import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  openWorker,
  parent,
  completedParent,
  addAttempt,
  addBody,
  finalize,
  retention,
  list,
} from './diagnostic-worker-fixture.mjs';

const openAudit = (name) =>
  openWorker(name, 'traffic-audit', {
    workerPath: process.env.AGM_AUDIT_WORKER_ENTRY,
  });
const complete = (audit, id) =>
  audit.command('completeParent', completedParent(id, { completedAt: 2 }));

function beginBody(id, requestId, representation = 'sanitized_json') {
  return {
    createdAt: 1,
    direction: 'response',
    id,
    kind: 'text',
    ownerId: requestId,
    ownerKind: 'parent',
    parentId: requestId,
    representation,
  };
}

test('old complete bodies survive without age expiration below the capacity window', async () => {
  const audit = openAudit('window-age');
  try {
    await audit.command('insertParent', parent('old', 'model', 1));
    await audit.command('beginPayload', beginBody('body', 'old'));
    await audit.command('appendPayloadChunk', { data: 'original', payloadId: 'body', sequence: 0 });
    await audit.command('finalizePayload', finalize('body', 'original'));
    await complete(audit, 'old');
    const query = { bodyId: 'body', cursor: 0, limitBytes: 1024 };
    const before = await audit.command('bodyPage', query);
    await audit.command('maintenance', retention(100));
    assert.equal(before.body.state, 'complete');
    assert.deepEqual(await audit.command('bodyPage', query), before);
    assert.equal((await list(audit, 'model')).total, 1);
  } finally {
    await audit.close();
  }
});

test('row pressure deletes globally oldest whole parents and cascades all owned data', async () => {
  const audit = openAudit('window-global');
  try {
    for (const [id, trafficClass, timestamp] of [
      ['old-model', 'model', 1],
      ['new-system', 'system', 3],
      ['middle-ipc', 'ipc', 2],
    ]) {
      await audit.command('insertParent', parent(id, trafficClass, timestamp));
      await addBody(audit, id, `${id}-body`, `${id} body`);
      await complete(audit, id);
    }
    await addAttempt(audit, 'old-model', 'attempt', 1, null, null, 200, 'completed');
    await audit.command('beginPayload', {
      ...beginBody('attempt-body', 'old-model'),
      ownerId: 'attempt',
      ownerKind: 'attempt',
    });
    await audit.command('appendPayloadChunk', {
      data: 'old-model body',
      payloadId: 'attempt-body',
      sequence: 0,
    });
    await audit.command('finalizePayload', finalize('attempt-body', 'old-model body'));
    const shared = new Database(audit.databasePath, { readonly: true });
    try {
      assert.equal(
        shared.prepare('SELECT payload_id id FROM attempt_body_refs').get().id,
        'old-model-body',
      );
    } finally {
      shared.close();
    }
    await audit.command('adminEvent', {
      affectedCount: null,
      error: null,
      operation: 'repair',
      outcome: 'success',
      timestamp: 1,
    });
    await audit.command('maintenance', retention(2));
    assert.equal(await audit.command('detail', { id: 'old-model' }), null);
    assert.equal((await audit.command('detail', { id: 'middle-ipc' })).request.id, 'middle-ipc');
    assert.equal((await audit.command('detail', { id: 'new-system' })).request.id, 'new-system');
    const db = new Database(audit.databasePath, { readonly: true });
    try {
      for (const table of ['upstream_attempts', 'attempt_body_refs']) {
        assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
      }
      for (const table of ['audit_payloads', 'audit_payload_chunks', 'request_body_refs']) {
        assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 2, table);
      }
      assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_admin_events').get().n, 1);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
  } finally {
    await audit.close();
  }
});

test('active parents, attempts and writing bodies survive until their completion', async () => {
  const audit = openAudit('window-active');
  try {
    for (const id of ['parent', 'attempt', 'body']) {
      await audit.command('insertParent', parent(id, 'model', 1));
    }
    await complete(audit, 'attempt');
    await complete(audit, 'body');
    await audit.command('insertAttempt', {
      accountId: null,
      accountIdHash: null,
      accountGenerationHash: null,
      accountSubjectHash: null,
      accountGrantHash: null,
      usageScope: null,
      attemptIndex: 1,
      endpoint: 'https://example.test',
      id: 'active-attempt',
      model: null,
      operation: 'generate',
      parentId: 'attempt',
      requestHeaders: '{}',
      timestamp: 1,
    });
    await audit.command('beginPayload', beginBody('active-body', 'body'));
    await audit.command('appendPayloadChunk', {
      data: 'prefix',
      payloadId: 'active-body',
      sequence: 0,
    });
    await audit.command('maintenance', retention(0, 0));
    assert.equal((await list(audit, 'model')).total, 3);
    assert.equal(
      (
        await audit.command('bodyPage', {
          bodyId: 'active-body',
          cursor: 0,
          limitBytes: 1024,
        })
      ).chunks[0].data,
      'prefix',
    );
    await complete(audit, 'parent');
    await audit.command('completeAttempt', {
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      reasoningTokens: null,
      id: 'active-attempt',
      completedAt: Date.now(),
      durationMs: 1,
      error: null,
      outcome: 'completed',
      responseHeaders: null,
      responsePartial: 0,
      status: 200,
    });
    await audit.command('finalizePayload', finalize('active-body', 'prefix'));
    await audit.command('maintenance', retention(0));
    assert.equal((await list(audit, 'model')).total, 0);
  } finally {
    await audit.close();
  }
});

test('large tied-timestamp row backlog yields bounded batches and admits live writes', async () => {
  const audit = openAudit('window-backlog');
  try {
    await audit.command('stats', null);
    const db = new Database(audit.databasePath);
    try {
      const insert = db.prepare(
        "INSERT INTO request_logs(id,timestamp,completed_at,method,url,protocol,traffic_class,request_headers,outcome) VALUES(?,1,2,'POST','/v1/messages','anthropic',?,'{}','completed')",
      );
      db.transaction(() => {
        for (let index = 0; index < 1500; index += 1) {
          insert.run(`old-${index}`, index % 2 === 0 ? 'model' : 'system');
        }
      })();
    } finally {
      db.close();
    }
    let previous = 1500;
    let inserted = false;
    await audit.command('maintenance', retention(1), {
      onYield: async () => {
        const current = (await audit.command('stats', null)).rows;
        const removed = previous - current;
        assert.ok(removed >= 0 && removed <= 32, `batch removed ${removed}`);
        previous = current;
        if (!inserted && current < 1500 && current > 1) {
          await audit.command('insertParent', parent('live', 'model', Date.now()));
          previous += 1;
          inserted = true;
        }
      },
    });
    assert.equal(inserted, true);
    assert.equal((await audit.command('stats', null)).rows, 1);
    assert.equal((await audit.command('detail', { id: 'live' })).request.id, 'live');
  } finally {
    await audit.close();
  }
});

test('admin events and drop buckets have separate bounds without consuming the parent window', async () => {
  const audit = openAudit('window-auxiliary');
  try {
    await audit.command('insertParent', parent('keep', 'model', 1));
    await complete(audit, 'keep');
    const db = new Database(audit.databasePath);
    try {
      db.transaction(() => {
        const admin = db.prepare(
          "INSERT INTO audit_admin_events(timestamp,operation,outcome) VALUES(?,'repair','success')",
        );
        for (let i = 0; i < 1100; i += 1) {
          admin.run(i);
        }
        const drop = db.prepare(
          "INSERT INTO audit_drop_stats(traffic_class,reason,count,last_seen) VALUES('model',?,1,?)",
        );
        for (let i = 0; i < 200; i += 1) {
          drop.run(`synthetic-${i}`, i);
        }
      })();
    } finally {
      db.close();
    }
    await audit.command('maintenance', retention(1));
    const reader = new Database(audit.databasePath, { readonly: true });
    try {
      assert.equal(reader.prepare('SELECT COUNT(*) n FROM audit_admin_events').get().n, 1000);
      assert.equal(reader.prepare('SELECT MIN(timestamp) n FROM audit_admin_events').get().n, 100);
      assert.equal(reader.prepare('SELECT COUNT(*) n FROM audit_drop_stats').get().n, 128);
      assert.equal(reader.prepare('SELECT MIN(last_seen) n FROM audit_drop_stats').get().n, 72);
      assert.equal(reader.prepare('SELECT COUNT(*) n FROM request_logs').get().n, 1);
    } finally {
      reader.close();
    }
  } finally {
    await audit.close();
  }
});

test('disk pressure reaches 70 percent by whole parents and preserves newer bodies', async () => {
  const audit = openAudit('window-disk');
  try {
    for (let index = 0; index < 5; index += 1) {
      const id = `p${index}`;
      await audit.command('insertParent', parent(id, index === 0 ? 'model' : 'system', index + 1));
      await addBody(audit, id, `${id}-body`, String(index).repeat(262_144));
      await complete(audit, id);
    }
    await audit.command('maintenance', retention(100));
    const before = await audit.command('stats', null);
    const budget = before.databaseBytes - 65_536;
    const result = await audit.command('maintenance', retention(100, budget));
    assert.ok(result.databaseBytes <= Math.floor(budget * 0.7));
    assert.equal(await audit.command('detail', { id: 'p0' }), null);
    assert.equal(await audit.command('detail', { id: 'p1' }), null);
    assert.equal((await audit.command('stats', null)).rows, 3);
    for (let index = 2; index < 5; index += 1) {
      const detail = await audit.command('detail', { id: `p${index}` });
      assert.equal(detail.bodies[0].state, 'complete');
      assert.equal(detail.bodies[0].storedBytes, 262_144);
    }
  } finally {
    await audit.close();
  }
});

test('existing free pages are reclaimed without deleting another request', async () => {
  const audit = openAudit('window-free');
  try {
    for (const id of ['discard', 'keep']) {
      await audit.command('insertParent', parent(id, 'model', 1));
      await addBody(audit, id, `${id}-body`, 'x'.repeat(id === 'discard' ? 1_000_000 : 20_000));
      await complete(audit, id);
    }
    await audit.command('maintenance', retention(100));
    const before = await audit.command('stats', null);
    await audit.command('delete', { id: 'discard' });
    const result = await audit.command(
      'maintenance',
      retention(100, before.databaseBytes - 100_000),
    );
    assert.ok(result.databaseBytes < (before.databaseBytes - 100_000) * 0.7);
    assert.equal((await audit.command('detail', { id: 'keep' })).bodies[0].state, 'complete');
  } finally {
    await audit.close();
  }
});

test('a pinned WAL defers disk deletion and resumes after its reader releases', async () => {
  const audit = openAudit('window-pinned');
  let reader;
  try {
    for (let index = 0; index < 5; index += 1) {
      const id = `p${index}`;
      await audit.command('insertParent', parent(id, 'model', index + 1));
      await addBody(audit, id, `${id}-body`, 'x'.repeat(262_144));
      await complete(audit, id);
    }
    await audit.command('maintenance', retention(100));
    reader = new Database(audit.databasePath, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM request_logs').get();
    const writer = new Database(audit.databasePath);
    try {
      writer.prepare('UPDATE request_logs SET error=? WHERE id=?').run('synthetic', 'p0');
    } finally {
      writer.close();
    }
    const before = await audit.command('stats', null);
    const budget = before.databaseBytes - 65_536;
    const pinned = await audit.command('maintenance', retention(100, budget));
    assert.deepEqual(pinned, { databaseBytes: before.databaseBytes, moreWorkPending: false });
    assert.equal((await audit.command('stats', null)).rows, 5);
    reader.exec('ROLLBACK');
    reader.close();
    reader = undefined;
    assert.ok(
      (await audit.command('maintenance', retention(100, budget))).databaseBytes <= budget * 0.7,
    );
  } finally {
    if (reader) {
      reader.exec('ROLLBACK');
      reader.close();
    }
    await audit.close();
  }
});

test('disk maintenance stops after a whole-parent delete makes no physical progress', async () => {
  const audit = openAudit('window-no-progress');
  try {
    for (let i = 0; i < 5; i += 1) {
      await audit.command('insertParent', parent(`p${i}`, 'model', i + 1));
      await complete(audit, `p${i}`);
    }
    await audit.command('maintenance', retention(100));
    const before = await audit.command('stats', null);
    const result = await audit.command('maintenance', retention(100, 0));
    assert.equal(result.databaseBytes, before.databaseBytes);
    assert.equal((await audit.command('stats', null)).rows, 4);
    assert.equal(await audit.command('detail', { id: 'p0' }), null);
    assert.equal((await audit.command('detail', { id: 'p1' })).request.id, 'p1');
  } finally {
    await audit.close();
  }
});

test('maintenance protects new rows when concurrent clear reuses SQLite row IDs', async () => {
  const audit = openAudit('window-clear');
  try {
    await audit.command('insertParent', parent('old', 'model', 1));
    await complete(audit, 'old');
    let replaced = false;
    await audit.command('maintenance', retention(0, 0), {
      onYield: async () => {
        if (!replaced) {
          replaced = true;
          await audit.command('clear', { trafficClass: null });
          await audit.command('insertParent', parent('new', 'model', Date.now()));
          await addBody(audit, 'new', 'new-body', 'new body');
          await complete(audit, 'new');
        }
      },
    });
    assert.equal((await list(audit, 'model')).total, 1);
    assert.equal((await audit.command('detail', { id: 'new' })).bodies[0].state, 'complete');
  } finally {
    await audit.close();
  }
});

test('a request completed during maintenance remains protected until the next pass', async () => {
  const audit = openAudit('window-completion');
  try {
    await audit.command('insertParent', parent('live', 'model', 1));
    let completed = false;
    await audit.command('maintenance', retention(0), {
      onYield: async () => {
        if (!completed) {
          completed = true;
          await audit.command('completeParent', completedParent('live'));
        }
      },
    });
    assert.equal((await list(audit, 'model')).total, 1);
    await audit.command('maintenance', retention(0));
    assert.equal((await list(audit, 'model')).total, 0);
  } finally {
    await audit.close();
  }
});

test('row pressure recounts concurrent user deletions between batches', async () => {
  const audit = openAudit('window-delete');
  try {
    for (let index = 0; index < 100; index += 1) {
      await audit.command('insertParent', parent(`p${index}`, 'model', index + 1));
      await complete(audit, `p${index}`);
    }
    let deleted = false;
    await audit.command('maintenance', retention(50), {
      onYield: async () => {
        if (!deleted && (await list(audit, 'model')).total === 68) {
          deleted = true;
          for (let index = 90; index < 100; index += 1) {
            assert.equal(await audit.command('delete', { id: `p${index}` }), 1);
          }
        }
      },
    });
    assert.equal(deleted, true);
    assert.equal((await list(audit, 'model')).total, 50);
  } finally {
    await audit.close();
  }
});

test('reopening the current schema keeps bodies and duplicate SSE completion remains terminal', async () => {
  let audit = openAudit('window-reopen');
  try {
    await audit.command('insertParent', parent('sse', 'model', 1));
    await audit.command('beginPayload', beginBody('body', 'sse', 'redacted_raw_sse'));
    const text = 'data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
    await audit.command('appendPayloadChunk', { data: text, payloadId: 'body', sequence: 0 });
    const finish = {
      completedAt: Date.now(),
      droppedReason: null,
      errorSummary: null,
      id: 'body',
      parseErrorOffset: null,
      partial: 0,
      rawBytes: Buffer.byteLength(text),
      sanitizedBytes: Buffer.byteLength(text),
      sanitizedSha256: null,
      terminalStatus: 'completed',
    };
    await audit.command('finalizeSsePayload', finish);
    await complete(audit, 'sse');
    const query = { bodyId: 'body', cursor: 0, limitBytes: 1024 };
    const before = await audit.command('bodyPage', query);
    assert.equal(before.body.state, 'complete');
    assert.match(before.chunks.map((chunk) => chunk.data).join(''), /hello/u);
    assert.equal(
      await audit.command('appendPayloadChunk', { data: 'late', payloadId: 'body', sequence: 1 }),
      0,
    );
    await audit.command('finalizeSsePayload', finish);
    assert.deepEqual(await audit.command('bodyPage', query), before);
    await audit.close();
    audit = openAudit('window-reopen');
    await audit.command('maintenance', retention(100));
    assert.deepEqual(await audit.command('bodyPage', query), before);
    const db = new Database(audit.databasePath, { readonly: true });
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 7);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
  } finally {
    await audit.close();
  }
});
