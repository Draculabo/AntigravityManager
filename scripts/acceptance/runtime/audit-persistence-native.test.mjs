import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import {
  __dirname,
  testDirectory,
  openWorker,
  parent,
  finalize,
  completedParent,
  addAttempt,
  addBody,
  list,
  retention,
} from './diagnostic-worker-fixture.mjs';

for (const trafficClass of ['model', 'system']) {
  test(`production ${trafficClass} list separates failed attempts from successful preparation`, async () => {
    const audit = openWorker(`fallback-count-${trafficClass}`);
    try {
      await audit.command('insertParent', parent('healthy', trafficClass, Date.now()));
      await audit.command('insertParent', parent('recovered', trafficClass, Date.now()));
      for (const id of ['healthy', 'recovered']) {
        await addAttempt(audit, id, `${id}-1`, 1, null, 'test', 200, 'completed');
        await addAttempt(
          audit,
          id,
          `${id}-2`,
          2,
          null,
          'test',
          id === 'healthy' ? 200 : 503,
          id === 'healthy' ? 'completed' : 'upstream_error',
        );
        await addAttempt(audit, id, `${id}-3`, 3, null, 'test', null, 'in_progress');
        await audit.command('completeParent', completedParent(id));
      }
      if (trafficClass === 'system') {
        await audit.command('adminEvent', {
          affectedCount: 0,
          error: null,
          operation: 'test',
          outcome: 'completed',
          timestamp: Date.now(),
        });
      }
      const result = await list(audit, trafficClass);
      assert.deepEqual(
        result.items
          .filter((row) => row.recordKind === 'request')
          .map(({ id, attemptCount, failedAttemptCount }) => ({
            id,
            attemptCount,
            failedAttemptCount,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        [
          { id: 'healthy', attemptCount: 3, failedAttemptCount: 0 },
          { id: 'recovered', attemptCount: 3, failedAttemptCount: 1 },
        ],
      );
      if (trafficClass === 'system') {
        assert.equal(result.items.find((row) => row.recordKind === 'admin').failedAttemptCount, 0);
      }
    } finally {
      await audit.close();
    }
  });
}

for (const operation of ['resetDropStats', 'clear']) {
  for (const trafficClass of ['model', 'system', null]) {
    test(`production worker ${operation} scopes drop deletion to ${trafficClass ?? 'all'}`, async () => {
      const audit = openWorker(`${operation}-${trafficClass ?? 'all'}`);
      try {
        const classes = ['model', 'ipc', 'system'];
        for (const [index, scope] of classes.entries()) {
          await audit.command('insertParent', parent(scope, scope, Date.now()));
          await audit.command('drop', {
            count: index + 1,
            droppedBytes: 0,
            lastSeen: Date.now(),
            reason: 'queue_capacity',
            trafficClass: scope,
          });
        }
        await addBody(audit, 'model', 'model-body', 'm'.repeat(256_000));
        const before = await audit.command('stats', null);
        await audit.command(operation, { trafficClass });
        const after = await audit.command('stats', null);
        const remaining = trafficClass === 'model' ? 5 : trafficClass === 'system' ? 3 : 0;
        assert.equal(after.droppedCount, remaining);
        assert.equal(after.rows, operation === 'resetDropStats' ? 3 : trafficClass ? 2 : 0);
        if (operation === 'resetDropStats' || trafficClass === 'system') {
          assert.equal(
            (await audit.command('detail', { id: 'model' })).bodies[0].storedBytes,
            256_000,
          );
        } else {
          assert.ok(after.databaseBytes < before.databaseBytes);
        }
      } finally {
        await audit.close();
      }
    });
  }
}

test('production retention bounds drop buckets and preserves newer counts without age expiry', async () => {
  const audit = openWorker('drop-retention');
  try {
    const now = Date.now();
    for (const [trafficClass, lastSeen, count] of [
      ['model', now - 2 * 24 * 60 * 60 * 1000, 7],
      ['ipc', now, 3],
    ]) {
      await audit.command('drop', {
        count,
        droppedBytes: 0,
        lastSeen,
        reason: 'queue_capacity',
        trafficClass,
      });
    }
    for (let index = 0; index < 127; index += 1) {
      await audit.command('drop', {
        count: 1,
        droppedBytes: 0,
        lastSeen: now - 1,
        reason: `fixture-${index}`,
        trafficClass: 'system',
      });
    }
    assert.equal((await audit.command('stats', null)).droppedCount, 137);
    await audit.command('maintenance', retention(100));
    assert.equal((await audit.command('stats', null)).droppedCount, 130);
    const db = new Database(audit.databasePath, { readonly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) count FROM audit_drop_stats').get().count, 128);
      assert.deepEqual(
        db
          .prepare(
            "SELECT traffic_class scope,count FROM audit_drop_stats WHERE traffic_class<>'system' ORDER BY traffic_class",
          )
          .all(),
        [{ scope: 'ipc', count: 3 }],
      );
    } finally {
      db.close();
    }
  } finally {
    await audit.close();
  }
});

test('production session snapshot fingerprints settled scoped records and rejects active or oversized sessions', async () => {
  const audit = openWorker('session-export-snapshot', 'traffic-audit', {
    workerPath: process.env.AGM_AUDIT_WORKER_ENTRY,
  });
  const sessionId = `session:affinity:v1:${'a'.repeat(64)}`;
  const id = randomUUID();
  try {
    await audit.command('insertParent', { ...parent(id, 'model', Date.now()), sessionId });
    await assert.rejects(audit.command('sessionSnapshot', { sessionId }), /active|limits/u);
    await audit.command('completeParent', completedParent(id, { sessionId }));
    const restoredId = randomUUID();
    await audit.command('insertParent', {
      ...parent(restoredId, 'model', Date.now()),
      sessionId: 'legacy-unscoped',
    });
    await audit.command('completeParent', completedParent(restoredId, { sessionId }));
    assert.equal((await audit.command('detail', { id: restoredId })).request.sessionId, sessionId);
    assert.equal((await audit.command('sessionSnapshot', { sessionId })).ids.length, 2);
    await audit.command('delete', { id: restoredId });
    const initial = await audit.command('sessionSnapshot', { sessionId });
    assert.deepEqual(initial.ids, [id]);
    assert.match(initial.fingerprint, /^[a-f0-9]{64}$/u);
    assert.deepEqual(await audit.command('sessionSnapshot', { sessionId }), initial);
    await audit.command('completeParent', completedParent(id, { outputTokens: 42 }));
    assert.notEqual(
      (await audit.command('sessionSnapshot', { sessionId })).fingerprint,
      initial.fingerprint,
    );
    await audit.command('delete', { id });
    assert.deepEqual((await audit.command('sessionSnapshot', { sessionId })).ids, []);
    await assert.rejects(audit.command('sessionSnapshot', { sessionId: 'legacy-unscoped' }));
    const db = new Database(audit.databasePath);
    try {
      const insert = db.prepare(
        "INSERT INTO request_logs(id,timestamp,method,url,protocol,traffic_class,request_headers,session_id,outcome,completed_at) VALUES (?,1,'POST','/v1/messages','anthropic','model','{}',?,'completed',2)",
      );
      db.transaction(() => {
        for (let index = 0; index < 2001; index += 1) {
          insert.run(randomUUID(), sessionId);
        }
      })();
    } finally {
      db.close();
    }
    await assert.rejects(audit.command('sessionSnapshot', { sessionId }), /request limit/u);
  } finally {
    await audit.close();
  }
});

test('exact saved-session filter preserves full tenant scope, paging and system union semantics', async () => {
  const audit = openWorker('exact-session', 'traffic-audit', {
    workerPath: process.env.AGM_AUDIT_WORKER_ENTRY,
  });
  const session = 'tenant-one:session_%';
  try {
    for (const [id, trafficClass, sessionId, timestamp] of [
      ['first', 'model', session, 1],
      ['second', 'model', session, 2],
      ['other-tenant', 'model', 'tenant-two:session_%', 3],
      ['longer', 'model', `${session}-suffix`, 4],
      ['no-session', 'model', null, 5],
      ['system-match', 'system', session, 6],
      ['system-other', 'system', 'other', 7],
    ]) {
      await audit.command('insertParent', { ...parent(id, trafficClass, timestamp), sessionId });
    }
    await audit.command('adminEvent', {
      affectedCount: null,
      error: null,
      operation: 'fixture',
      outcome: 'completed',
      timestamp: 8,
    });
    const query = { limit: 1, offset: 0, trafficClass: 'model', sessionId: session };
    const first = await audit.command('list', query);
    assert.equal(first.total, 2);
    assert.deepEqual(
      first.items.map((item) => item.id),
      ['second'],
    );
    assert.deepEqual(
      (await audit.command('list', { ...query, offset: 1 })).items.map((item) => item.id),
      ['first'],
    );
    const system = await audit.command('list', { ...query, limit: 20, trafficClass: 'system' });
    assert.equal(system.total, 1);
    assert.deepEqual(
      system.items.map((item) => item.id),
      ['system-match'],
    );
    assert.equal((await audit.command('list', { ...query, sessionId: 'session_%' })).total, 0);
    assert.equal(
      (await audit.command('detail', { id: 'other-tenant' })).request.sessionId,
      'tenant-two:session_%',
    );
    assert.equal(
      (await audit.command('list', { limit: 20, offset: 0, trafficClass: 'model' })).total,
      5,
    );
  } finally {
    await audit.close();
  }
});

test('production worker reopens the current schema and serves paged UTF-8 bodies with parent-local dedup', async () => {
  const audit = openWorker('pages');
  const requestId = 'request-1';
  const body = `${'a'.repeat(65_530)}😀中${'b'.repeat(65_530)}`;
  try {
    await audit.command('insertParent', parent(requestId, 'model', Date.now()));
    for (const [index, direction] of ['request', 'response'].entries()) {
      const id = `payload-${index}`;
      await audit.command('beginPayload', {
        createdAt: Date.now(),
        direction,
        id,
        kind: 'text',
        ownerId: requestId,
        ownerKind: 'parent',
        parentId: requestId,
        representation: 'sanitized_json',
      });
      const chunks = [body.slice(0, 65_530), body.slice(65_530, 65_533), body.slice(65_533)];
      for (const [sequence, data] of chunks.entries()) {
        await audit.command('appendPayloadChunk', { data, payloadId: id, sequence });
      }
      const canonicalId = await audit.command('finalizePayload', finalize(id, body));
      assert.equal(canonicalId, 'payload-0');
    }
    let cursor = 0;
    let reconstructed = '';
    let pages = 0;
    while (cursor !== null) {
      const page = await audit.command('bodyPage', {
        bodyId: 'payload-0',
        cursor,
        limitBytes: 65_536,
      });
      assert.ok(page);
      assert.ok(page.chunks.length <= 2);
      reconstructed += page.chunks.map((chunk) => chunk.data).join('');
      cursor = page.nextCursor;
      pages += 1;
    }
    assert.ok(pages >= 2);
    assert.equal(reconstructed, body);
    const detail = await audit.command('detail', { id: requestId });
    assert.deepEqual(
      detail.bodies.map((entry) => entry.id),
      ['payload-0', 'payload-0'],
    );
  } finally {
    await audit.close();
  }

  let db = new Database(audit.databasePath);
  assert.equal(db.pragma('user_version', { simple: true }), 7);
  assert.equal(
    db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value,
    '7',
  );
  db.pragma('auto_vacuum = NONE');
  db.exec('VACUUM');
  assert.equal(db.pragma('auto_vacuum', { simple: true }), 0);
  db.close();
  const reopened = openWorker('pages');
  await reopened.command('stats', null);
  await reopened.close();
  db = new Database(audit.databasePath);
  assert.equal(
    db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value,
    '7',
  );
  assert.equal(
    db.prepare("SELECT value FROM schema_meta WHERE key='layout'").get().value,
    'classified-chunked-payload-v7',
  );
  assert.equal(db.pragma('auto_vacuum', { simple: true }), 2);
  db.close();
});

test('schema v3 is preserved as a recoverable backup and replaced with an empty current database', async () => {
  const audit = openWorker('rebuild');
  await audit.command('insertParent', parent('old-row', 'model', Date.now()));
  await audit.close();
  const oldDatabase = new Database(audit.databasePath);
  oldDatabase.pragma('user_version = 3');
  oldDatabase.close();

  const rebuilt = openWorker('rebuild');
  try {
    const rows = await list(rebuilt, 'model');
    assert.equal(rows.total, 0);
  } finally {
    await rebuilt.close();
  }
  const backupName = fs
    .readdirSync(testDirectory)
    .find(
      (name) =>
        name.startsWith('rebuild.db.schema-v3-backup-') &&
        !name.endsWith('-wal') &&
        !name.endsWith('-shm'),
    );
  assert.ok(backupName);
  const backup = new Database(path.join(testDirectory, backupName), { readonly: true });
  assert.equal(
    backup.prepare("SELECT id FROM request_logs WHERE id='old-row'").get().id,
    'old-row',
  );
  backup.close();
  const current = new Database(audit.databasePath, { readonly: true });
  assert.equal(current.pragma('user_version', { simple: true }), 7);
  current.close();
});

test('future audit schema is rejected without archiving or replacing its data', async () => {
  const audit = openWorker('future-version');
  await audit.command('insertParent', parent('future-row', 'model', Date.now()));
  await audit.close();
  const database = new Database(audit.databasePath);
  database.pragma('user_version = 8');
  database.close();

  const workerPath =
    process.env.AGM_AUDIT_WORKER_ENTRY ??
    path.resolve(__dirname, '../../../.vite/build/traffic-audit.worker.js');
  const worker = new Worker(workerPath, { workerData: { databasePath: audit.databasePath } });
  const failure = await new Promise((resolve) => worker.once('error', resolve));
  assert.match(failure.message, /Unsupported traffic audit schema version: 8/);
  await worker.terminate();

  const preserved = new Database(audit.databasePath, { readonly: true });
  assert.equal(preserved.pragma('user_version', { simple: true }), 8);
  assert.equal(
    preserved.prepare("SELECT id FROM request_logs WHERE id='future-row'").get().id,
    'future-row',
  );
  preserved.close();
  assert.equal(
    fs
      .readdirSync(testDirectory)
      .some((name) => name.startsWith('future-version.db.schema-v8-backup-')),
    false,
  );
});

test('production worker filters final account, physical family, status, modality and normalized tokens', async () => {
  const audit = openWorker('filters');
  const now = Date.now();
  try {
    await audit.command('insertParent', {
      ...parent('retry', 'model', now),
      model: 'client-alias',
    });
    await addAttempt(
      audit,
      'retry',
      'retry-a',
      1,
      'account-a',
      'gemini-pro-agent',
      429,
      'upstream_error',
    );
    await addAttempt(
      audit,
      'retry',
      'retry-b',
      2,
      'account-b',
      'claude-sonnet-4-6',
      200,
      'completed',
    );
    await audit.command('completeParent', completedParent('retry'));

    await audit.command('insertParent', parent('failed', 'model', now + 1));
    await addAttempt(
      audit,
      'failed',
      'failed-a',
      1,
      'account-a',
      'gemini-3.7-flash',
      502,
      'upstream_error',
    );
    await audit.command(
      'completeParent',
      completedParent('failed', {
        hasImageOutput: false,
        hasTextOutput: false,
        inputTokens: null,
        outputTokens: null,
        outcome: 'upstream_error',
        status: 502,
      }),
    );

    await audit.command('insertParent', parent('mixed', 'model', now + 2));
    await addAttempt(
      audit,
      'mixed',
      'mixed-b',
      1,
      'account-b',
      'gemini-3.7-flash',
      200,
      'completed',
    );
    await audit.command('completeParent', completedParent('mixed', { hasImageOutput: true }));
    await audit.command('insertParent', parent('unfinished', 'model', now + 3));

    const accountB = await audit.command('list', {
      accountId: 'account-b',
      limit: 20,
      offset: 0,
      trafficClass: 'model',
    });
    assert.deepEqual(
      accountB.items.map((item) => item.id),
      ['mixed', 'retry'],
    );
    assert.equal(accountB.items[1].attributedAccountId, 'account-b');
    assert.equal(accountB.items[1].physicalModel, 'claude-sonnet-4-6');
    assert.equal(accountB.items[1].physicalModelFamily, 'claude-sonnet-4-6');
    assert.deepEqual([accountB.items[1].inputTokens, accountB.items[1].outputTokens], [12, 4]);
    assert.equal(
      (
        await audit.command('list', {
          accountId: 'account-a',
          limit: 20,
          offset: 0,
          trafficClass: 'model',
        })
      ).items[0].id,
      'failed',
    );
    assert.equal(
      (
        await audit.command('list', {
          limit: 20,
          offset: 0,
          statusMode: '2xx',
          trafficClass: 'model',
        })
      ).total,
      2,
    );
    assert.equal(
      (
        await audit.command('list', {
          limit: 20,
          offset: 0,
          statusMode: 'exact',
          status: 502,
          trafficClass: 'model',
        })
      ).items[0].id,
      'failed',
    );
    assert.equal(
      (
        await audit.command('list', {
          limit: 20,
          offset: 0,
          statusMode: 'unfinished',
          trafficClass: 'model',
        })
      ).items[0].id,
      'unfinished',
    );
    assert.equal(
      (
        await audit.command('list', {
          limit: 20,
          offset: 0,
          modelFamily: 'claude-sonnet-4-6',
          trafficClass: 'model',
        })
      ).items[0].id,
      'retry',
    );
    assert.deepEqual(
      (
        await audit.command('list', {
          limit: 20,
          modality: 'image',
          offset: 0,
          trafficClass: 'model',
        })
      ).items.map((item) => item.id),
      ['mixed'],
    );
    assert.deepEqual(
      (
        await audit.command('list', {
          limit: 20,
          modality: 'text',
          offset: 0,
          trafficClass: 'model',
        })
      ).items.map((item) => item.id),
      ['mixed', 'retry'],
    );
    assert.equal(
      (
        await audit.command('list', {
          limit: 20,
          modality: 'none',
          offset: 0,
          trafficClass: 'model',
        })
      ).items[0].id,
      'failed',
    );
    assert.equal(
      (
        await audit.command('list', {
          limit: 20,
          modality: 'unknown',
          offset: 0,
          trafficClass: 'model',
        })
      ).items[0].id,
      'unfinished',
    );
    assert.deepEqual(await audit.command('filterOptions', null), {
      accountIds: ['account-a', 'account-b'],
      modelFamilies: ['claude-sonnet-4-6', 'gemini-3.7-flash'],
    });
  } finally {
    await audit.close();
  }
});

test('account attribution keeps the newest success or else the last failed attempt', async () => {
  const audit = openWorker('attribution-edges');
  try {
    await audit.command('insertParent', parent('all-failed', 'model', Date.now()));
    await addAttempt(
      audit,
      'all-failed',
      'all-failed-a',
      1,
      'account-a',
      'gemini-pro-agent',
      429,
      'upstream_error',
    );
    await addAttempt(
      audit,
      'all-failed',
      'all-failed-b',
      2,
      'account-b',
      'claude-sonnet-4-6',
      502,
      'upstream_error',
    );
    await audit.command(
      'completeParent',
      completedParent('all-failed', { outcome: 'upstream_error', status: 502 }),
    );

    await audit.command('insertParent', parent('earlier-success', 'model', Date.now() + 1));
    await addAttempt(
      audit,
      'earlier-success',
      'earlier-success-a',
      1,
      'account-a',
      'gemini-pro-agent',
      200,
      'completed',
    );
    await addAttempt(
      audit,
      'earlier-success',
      'earlier-success-b',
      2,
      'account-b',
      'claude-sonnet-4-6',
      502,
      'upstream_error',
    );
    await audit.command(
      'completeParent',
      completedParent('earlier-success', { outcome: 'upstream_error', status: 502 }),
    );

    const rows = await list(audit, 'model');
    const byId = new Map(rows.items.map((item) => [item.id, item]));
    assert.equal(byId.get('all-failed').attributedAccountId, 'account-b');
    assert.equal(byId.get('all-failed').physicalModelFamily, 'claude-sonnet-4-6');
    assert.equal(byId.get('earlier-success').attributedAccountId, 'account-a');
    assert.equal(byId.get('earlier-success').physicalModelFamily, 'gemini-3.1-pro');
    assert.equal(
      (
        await audit.command('list', {
          limit: 20,
          offset: 0,
          statusMode: 'exact',
          trafficClass: 'model',
        })
      ).total,
      0,
    );
  } finally {
    await audit.close();
  }
});
