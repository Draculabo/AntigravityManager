import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { openWorker as openDiagnosticWorker } from './diagnostic-worker-fixture.mjs';

function openWorker(name, workerName = 'thought-store') {
  return openDiagnosticWorker(name, workerName, {
    workerPath: process.env.AGM_THOUGHT_WORKER_ENTRY,
  });
}

test('tool recovery permissions honor eviction through the production Worker while diagnostics retain signatures', async () => {
  const name = 'tool-permission-eviction';
  let worker = openWorker(name);
  const now = Date.now();
  const tools = Array.from({ length: 2000 }, (_, position) => ({
    kind: 'tool',
    position,
    callId: `call-${position}`,
    name: 'read',
    argsDigest: 'b'.repeat(64),
    signature: `opaque-${position}`,
  }));
  try {
    for (let index = 0; index < 6; index += 1) {
      await worker.command('save', {
        sessionKey: 'session',
        createdAt: now,
        completedAt: now,
        operationId: `op-${index}`,
        causalAnchor: index.toString(16).padStart(64, '0'),
        captureState: 'complete',
        fingerprint: 'same',
        model: 'gemini-pro',
        sourceFamily: 'gemini',
        thought: 'diagnostic reasoning',
        visible: 'OK',
        signature: null,
        partSignatures: index === 5 ? [tools[0]] : tools,
        toolIds: [],
        toolNames: [],
        meaningful: true,
        maxSessionBytes: 64 * 1024 * 1024,
        maxSessions: 2000,
        maxTurns: 600,
      });
    }
    const loaded = await worker.command('load', { sessionKey: 'session' });
    assert.deepEqual(
      loaded[0].partSignatures,
      tools.map((part, index) => (index === 0 ? { ...part, signature: null } : part)),
    );
    assert.deepEqual(
      (await worker.command('getRecord', { sessionKey: 'session', id: 1 })).partSignatures,
      tools,
    );
    const input = { sessionKey: 'session', operationIds: ['op-0', 'op-5'] };
    const expected = [
      { operationId: 'op-0', positions: Array.from({ length: 1999 }, (_, index) => index + 1) },
      { operationId: 'op-5', positions: [0] },
    ];
    assert.deepEqual(await worker.command('toolRecoverySnapshot', input), expected);
    const layoutDigest = (parts) => {
      const hash = createHash('sha256');
      for (const part of parts) {
        hash.update(JSON.stringify([part.position, part.callId, part.name, part.argsDigest]) + '\n');
      }
      return hash.digest('hex');
    };
    assert.deepEqual(await worker.command('toolRecoverySnapshot', { ...input, layouts: [
      { operationId: 'op-0', digest: layoutDigest(tools) },
      { operationId: 'op-5', digest: layoutDigest([tools[0]]) },
    ] }), expected);
    assert.deepEqual(await worker.command('toolRecoverySnapshot', {
      ...input, layouts: input.operationIds.map((operationId) => ({ operationId, digest: '0'.repeat(64) })),
    }), input.operationIds.map((operationId) => ({ operationId, positions: [] })));
    assert.deepEqual(
      await worker.command('toolRecoverySnapshot', { ...input, sessionKey: 'neighbor' }),
      [],
    );
    await assert.rejects(
      worker.command('toolRecoverySnapshot', {
        sessionKey: 'session',
        operationIds: Array.from({ length: 10257 }, (_, index) => `op-${index}`),
      }),
    );
    await worker.close();
    worker = openWorker(name);
    assert.deepEqual(await worker.command('toolRecoverySnapshot', input), expected);
    assert.equal((await worker.command('stats', null)).recoverableToolLinks, 10000);
    const raw = new Database(worker.databasePath);
    try {
      raw.pragma('foreign_keys = ON');
      raw.prepare('DELETE FROM thinking_records WHERE id=?').run(6);
    } finally {
      raw.close();
    }
    const replay = await worker.command('getRecord', { sessionKey: 'session', id: 1 });
    await worker.command('save', {
      ...replay,
      sessionKey: 'session',
      thought: 'diagnostic reasoning enriched',
      meaningful: true,
      maxSessionBytes: 64 * 1024 * 1024,
      maxSessions: 2000,
      maxTurns: 600,
    });
    assert.deepEqual(await worker.command('toolRecoverySnapshot', input), [expected[0]]);
    assert.equal((await worker.command('stats', null)).recoverableToolLinks, 9999);
    await worker.command('save', {
      ...replay,
      sessionKey: 'legacy',
      operationId: null,
      causalAnchor: null,
      completedAt: null,
      captureState: 'legacy',
      meaningful: true,
      maxSessionBytes: 64 * 1024 * 1024,
      maxSessions: 2000,
      maxTurns: 600,
    });
    const legacy = await worker.command('load', { sessionKey: 'legacy' });
    assert.equal(legacy[0].thought, 'diagnostic reasoning');
    assert.ok(legacy[0].partSignatures.every((part) => part.signature === null));
    const legacyDiagnostic = await worker.command('getSession', { sessionKey: 'legacy' });
    assert.deepEqual(legacyDiagnostic[0].partSignatures, tools);
  } finally {
    await worker.close();
  }
});

test('round ownership restores old causal candidates through the real Worker without merging independent replies', async () => {
  const name = 'round-causal-recovery';
  let worker = openWorker(name);
  const now = Date.now();
  const save = (index, operationId = `op-${index}`) =>
    worker.command('save', {
      createdAt: now,
      completedAt: now,
      operationId,
      causalAnchor: index.toString(16).padStart(64, '0'),
      captureState: 'complete',
      fingerprint: 'identical-reply',
      maxSessionBytes: 64 * 1024 * 1024,
      maxSessions: 2000,
      maxTurns: 600,
      meaningful: true,
      model: 'gemini-pro',
      sessionKey: 'rounds',
      signature: null,
      partSignatures: [
        {
          kind: 'tool',
          position: 0,
          callId: 'reused',
          name: 'read',
          argsDigest: 'b'.repeat(64),
          signature: 'opaque-tool',
        },
      ],
      sourceFamily: 'gemini',
      thought: '',
      visible: 'OK',
      toolIds: ['reused'],
      toolNames: ['read'],
    });
  try {
    for (let index = 0; index < 700; index += 1) {
      await save(index);
    }
    await save(0, 'independent-retry');
    assert.equal((await worker.command('stats', null)).records, 701);
    const input = { sessionKey: 'rounds', model: 'gemini-pro', anchors: ['0'.repeat(64)] };
    const candidates = await worker.command('findCandidates', input);
    assert.deepEqual(
      candidates.map((record) => ({
        id: record.id,
        operationId: record.operationId,
        completedAt: record.completedAt,
        signature: record.partSignatures[0].signature,
      })),
      [
        { id: 1, operationId: 'op-0', completedAt: now, signature: 'opaque-tool' },
        { id: 701, operationId: 'independent-retry', completedAt: now, signature: 'opaque-tool' },
      ],
    );
    assert.deepEqual(
      await worker.command('findCandidates', { ...input, sessionKey: 'other-tenant' }),
      [],
    );
    assert.deepEqual(
      await worker.command('findCandidates', { ...input, model: 'claude-sonnet-4-6' }),
      [],
    );
    await worker.close();
    worker = openWorker(name);
    assert.deepEqual(
      (await worker.command('findCandidates', input)).map((record) => record.id),
      [1, 701],
    );
    assert.deepEqual(await worker.command('deleteSession', { sessionKey: 'rounds' }), {
      sessions: 1,
      records: 701,
    });
    assert.deepEqual(await worker.command('findCandidates', input), []);
    assert.equal((await worker.command('stats', null)).recoverableToolLinks, 0);
  } finally {
    await worker.close();
  }
});

test('reasoning metadata pages retain their high-water boundary and exact transactional counts after reopen', async () => {
  const name = 'paged-management';
  let worker = openWorker(name);
  const save = (sessionKey, index) =>
    worker.command('save', {
      createdAt: Date.now(),
      fingerprint: `turn-${index}`,
      maxSessionBytes: 64 * 1024 * 1024,
      maxSessions: 2000,
      maxTurns: 600,
      meaningful: true,
      model: 'gemini-pro',
      sessionKey,
      signature: `signature-${index}`,
      partSignatures: [],
      sourceFamily: 'gemini',
      thought: `reasoning-${index}`,
      visible: `reply-${index}`,
      toolIds: [],
      toolNames: [],
    });
  try {
    for (let index = 0; index < 700; index += 1) {
      await save('history', index);
    }
    await save('neighbor', 900);
    const first = await worker.command('listRecordPage', { sessionKey: 'history', limit: 37 });
    assert.equal(first.records.length, 37);
    assert.equal(first.complete, false);
    assert.equal(first.nextCursor, first.records.at(-1).id);
    const appended = await save('history', 700);
    const ids = first.records.map((record) => record.id);
    let page = first;
    while (!page.complete) {
      page = await worker.command('listRecordPage', {
        sessionKey: 'history',
        afterId: page.nextCursor,
        throughId: first.throughId,
        limit: 37,
      });
      assert.equal(page.throughId, first.throughId);
      assert.ok(page.records.length <= 37);
      ids.push(...page.records.map((record) => record.id));
      assert.ok(ids.length <= 700, 'pagination must progress and terminate');
    }
    assert.equal(page.nextCursor, null);
    assert.deepEqual(
      ids,
      Array.from({ length: 700 }, (_, index) => index + 1),
    );
    assert.ok(!ids.includes(appended.id));
    assert.deepEqual(await worker.command('end', { sessionKey: 'history' }), {
      sessions: 1,
      records: 701,
    });
    assert.equal((await worker.command('getSession', { sessionKey: 'history' })).length, 701);
    assert.deepEqual(await worker.command('deleteSession', { sessionKey: 'history' }), {
      sessions: 1,
      records: 701,
    });
    assert.deepEqual(await worker.command('deleteSession', { sessionKey: 'history' }), {
      sessions: 0,
      records: 0,
    });
    await worker.close();
    worker = openWorker(name);
    assert.equal((await worker.command('getSession', { sessionKey: 'history' })).length, 0);
    assert.equal((await worker.command('getSession', { sessionKey: 'neighbor' })).length, 1);
    assert.deepEqual(await worker.command('clear', null), { sessions: 1, records: 1 });
    assert.deepEqual(await worker.command('clear', null), { sessions: 0, records: 0 });
  } finally {
    await worker.close();
  }
});

test('reasoning pages reject oversized stored metadata and failed deletion retains durable rows', async () => {
  const worker = openWorker('paged-management-failure');
  try {
    await worker.command('save', {
      createdAt: Date.now(),
      fingerprint: 'safe',
      maxSessionBytes: 64 * 1024 * 1024,
      maxSessions: 2000,
      maxTurns: 600,
      meaningful: true,
      model: 'gemini-pro',
      sessionKey: 'history',
      signature: null,
      partSignatures: [],
      sourceFamily: 'gemini',
      thought: 'saved',
      visible: '',
      toolIds: [],
      toolNames: [],
    });
    const raw = new Database(worker.databasePath);
    try {
      raw.prepare('UPDATE thinking_records SET model=?').run('x'.repeat(2 * 1024 * 1024));
      await assert.rejects(
        worker.command('listRecordPage', { sessionKey: 'history' }),
        /read.*budget/u,
      );
      raw.exec(
        "CREATE TRIGGER refuse_delete BEFORE DELETE ON thinking_records BEGIN SELECT RAISE(ABORT, 'synthetic deletion failure'); END",
      );
      await assert.rejects(
        worker.command('deleteSession', { sessionKey: 'history' }),
        /synthetic deletion failure/u,
      );
      assert.deepEqual(raw.prepare('SELECT count(*) AS records FROM thinking_records').get(), {
        records: 1,
      });
      assert.deepEqual(raw.prepare('SELECT count(*) AS sessions FROM thinking_sessions').get(), {
        sessions: 1,
      });
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS refuse_delete');
      raw.close();
    }
  } finally {
    await worker.close();
  }
});

test('durable thought history survives a 600-turn cold window, restart and tiny L1 limits', async () => {
  const name = 'independent-l1-l2-window';
  const worker = openWorker(name);
  let firstId;
  try {
    for (let index = 0; index < 700; index += 1) {
      const result = await worker.command('save', {
        createdAt: Date.now(),
        fingerprint: `turn-${index}`,
        maxSessionBytes: 64 * 1024 * 1024,
        maxSessions: 2000,
        maxTurns: 10,
        meaningful: true,
        model: 'gemini-pro',
        sessionKey: 'many-turns',
        signature: `signature-${index}`,
        partSignatures: [],
        sourceFamily: 'gemini',
        thought: `reasoning-${index}`,
        visible: `reply-${index}`,
        toolIds: [`tool-${index}`],
        toolNames: ['read'],
      });
      firstId ??= result.id;
    }
    const metadata = await worker.command('listRecords', { sessionKey: 'many-turns' });
    assert.equal(metadata.length, 700);
    const recent = await worker.command('load', {
      sessionKey: 'many-turns',
      maxTurns: 600,
      maxSessionBytes: 64 * 1024 * 1024,
    });
    assert.equal(recent.length, 600);
    assert.equal(recent[0].thought, 'reasoning-100');
    assert.equal(
      (await worker.command('getRecord', { sessionKey: 'many-turns', id: firstId })).thought,
      'reasoning-0',
    );
  } finally {
    await worker.close();
  }
  const reopened = openWorker(name);
  try {
    assert.equal((await reopened.command('getSession', { sessionKey: 'many-turns' })).length, 700);
    assert.equal(
      (await reopened.command('getRecord', { sessionKey: 'many-turns', id: firstId })).thought,
      'reasoning-0',
    );
  } finally {
    await reopened.close();
  }
});

test('thought disk admission refuses new persistence but preserves old readable history', async () => {
  const worker = openWorker('independent-disk-admission');
  const payload = {
    createdAt: Date.now(),
    fingerprint: 'saved',
    maxSessionBytes: 64 * 1024 * 1024,
    maxSessions: 2000,
    maxTurns: 10,
    meaningful: true,
    model: 'gemini-pro',
    sessionKey: 'saved',
    signature: null,
    partSignatures: [],
    sourceFamily: 'gemini',
    thought: 'saved reasoning',
    visible: '',
    toolIds: [],
    toolNames: [],
  };
  try {
    const saved = await worker.command('save', payload);
    await assert.rejects(
      worker.command('save', { ...payload, fingerprint: 'refused', maxDiskBytes: 1 }),
      /disk_budget/u,
    );
    await assert.rejects(
      worker.command('touch', { sessionKey: 'saved', maxDiskBytes: 1 }),
      /disk_budget/u,
    );
    await assert.rejects(
      worker.command('end', { sessionKey: 'saved', maxDiskBytes: 1 }),
      /disk_budget/u,
    );
    await assert.rejects(
      worker.command('ingestHistory', {
        sessionKey: 'saved',
        records: [{ ...payload, fingerprint: 'refused-history', maxDiskBytes: 1 }],
      }),
      /disk_budget/u,
    );
    assert.equal((await worker.command('getSession', { sessionKey: 'saved' })).length, 1);
    assert.equal(
      (await worker.command('getRecord', { sessionKey: 'saved', id: saved.id })).thought,
      'saved reasoning',
    );
  } finally {
    await worker.close();
  }
});

test('production thought reads refuse expansion and metadata budgets without deleting saved rows', async () => {
  const worker = openWorker('read-preflight-budget');
  try {
    const payload = {
      createdAt: Date.now(),
      fingerprint: 'bounded',
      maxSessionBytes: 64 * 1024 * 1024,
      maxSessions: 2000,
      maxTurns: 200,
      meaningful: true,
      model: 'gemini-pro',
      sessionKey: 'bounded',
      signature: null,
      partSignatures: [],
      sourceFamily: 'gemini',
      thought: 'ok',
      toolIds: [],
      toolNames: [],
      visible: '',
    };
    const saved = await worker.command('save', payload);
    const compressed = Buffer.concat([Buffer.from('AGZ1'), gzipSync('x'.repeat(8192))]);
    const db = new Database(worker.databasePath);
    try {
      db.prepare('UPDATE thinking_records SET thought=?,thought_bytes=1 WHERE id=?').run(
        compressed,
        saved.id,
      );
      await assert.rejects(
        worker.command('getRecord', { sessionKey: 'bounded', id: saved.id }),
        /decode budget/u,
      );
      assert.deepEqual(
        db.prepare('SELECT thought FROM thinking_records WHERE id=?').get(saved.id).thought,
        compressed,
      );
      db.prepare(
        'UPDATE thinking_records SET thought=?,thought_bytes=2,part_signatures=? WHERE id=?',
      ).run(Buffer.from('RAW1ok'), '[]' + ' '.repeat(16 * 1024 * 1024), saved.id);
      await assert.rejects(
        worker.command('getSession', { sessionKey: 'bounded' }),
        /read.*budget/u,
      );
      assert.equal(db.prepare('SELECT count(*) AS count FROM thinking_records').get().count, 1);
      db.prepare('UPDATE thinking_records SET part_signatures=? WHERE id=?').run('[]', saved.id);
      assert.equal(
        (await worker.command('getRecord', { sessionKey: 'bounded', id: saved.id })).thought,
        'ok',
      );
      const controls = '\u0000'.repeat(18 * 1024 * 1024);
      db.prepare('UPDATE thinking_records SET thought=?,thought_bytes=? WHERE id=?').run(
        Buffer.concat([Buffer.from('AGZ1'), gzipSync(controls)]),
        Buffer.byteLength(controls),
        saved.id,
      );
      const restored = await worker.command('getRecord', { sessionKey: 'bounded', id: saved.id });
      assert.equal(restored.thought.length, controls.length);
      assert.equal(
        createHash('sha256').update(restored.thought).digest('hex'),
        createHash('sha256').update(controls).digest('hex'),
      );
    } finally {
      db.close();
    }
  } finally {
    await worker.close();
  }
});

test('complete thought management reads refuse over-limit rows instead of silently truncating', async () => {
  const worker = openWorker('read-count-budget');
  try {
    await worker.command('stats', null);
    const db = new Database(worker.databasePath);
    try {
      db.prepare('INSERT INTO thinking_sessions(session_key,last_accessed) VALUES (?,?)').run(
        'many',
        Date.now(),
      );
      const insert = db.prepare(
        "INSERT INTO thinking_records(session_key,fingerprint,thought,thought_bytes,signature,part_signatures,signature_bytes,tool_ids,tool_names,visible,model,source_family,oversized,created_at,last_accessed) VALUES ('many',?,NULL,0,NULL,'[]',2,'[]','[]','','gemini-pro','gemini',0,1,1)",
      );
      db.transaction(() => {
        for (let index = 0; index < 10001; index += 1) {
          insert.run(`turn-${index}`);
        }
      })();
      await assert.rejects(worker.command('getSession', { sessionKey: 'many' }), /read.*budget/u);
      await assert.rejects(worker.command('listRecords', { sessionKey: 'many' }), /read.*budget/u);
      const firstPage = await worker.command('listRecordPage', { sessionKey: 'many', limit: 200 });
      assert.deepEqual(
        {
          length: firstPage.records.length,
          first: firstPage.records[0].id,
          cursor: firstPage.nextCursor,
          through: firstPage.throughId,
          complete: firstPage.complete,
        },
        { length: 200, first: 1, cursor: 200, through: 10001, complete: false },
      );
      assert.equal(
        (await worker.command('load', { sessionKey: 'many', maxTurns: 1, maxSessionBytes: 4096 }))
          .length,
        1,
      );
      assert.equal(db.prepare('SELECT count(*) AS count FROM thinking_records').get().count, 10001);
      await worker.command('save', {
        createdAt: Date.now(),
        fingerprint: 'latest-independent-turn',
        maxSessionBytes: 64 * 1024 * 1024,
        maxSessions: 2000,
        maxTurns: 10,
        meaningful: true,
        model: 'gemini-pro',
        sessionKey: 'many',
        signature: null,
        partSignatures: [],
        sourceFamily: 'gemini',
        thought: 'latest',
        visible: '',
        toolIds: [],
        toolNames: [],
      });
      assert.equal(db.prepare('SELECT count(*) AS count FROM thinking_records').get().count, 10002);
      assert.equal((await worker.command('getRecord', { sessionKey: 'many', id: 1 })).id, 1);
    } finally {
      db.close();
    }
  } finally {
    await worker.close();
  }
});

for (const operation of ['save', 'ingestHistory']) {
  test(`ambiguous unsigned history cannot overwrite signed rounds during ${operation} or restart`, async () => {
    const name = `ambiguous-history-${operation}`;
    const worker = openWorker(name, 'thought-store');
    const base = {
      partSignatures: [],
      createdAt: Date.now(),
      fingerprint: 'reused-fingerprint',
      maxSessionBytes: 1024 * 1024,
      maxSessions: 10,
      maxTurns: 200,
      meaningful: true,
      model: 'gemini-pro-agent',
      sessionKey: 'ambiguous-session',
      sourceFamily: 'gemini-pro',
      toolIds: ['reused'],
      toolNames: ['read'],
      visible: '',
    };
    const records = [
      {
        ...base,
        partSignatures: [
          { kind: 'thought', position: 0, start: 0, end: 15, signature: 'a'.repeat(60) },
          {
            kind: 'tool',
            position: 1,
            callId: 'reused',
            name: 'read',
            argsDigest: createHash('sha256').update('{}').digest('hex'),
            signature: 'a'.repeat(60),
          },
        ],
        signature: 'a'.repeat(60),
        thought: 'first reasoning',
      },
      {
        ...base,
        partSignatures: [
          { kind: 'thought', position: 0, start: 0, end: 16, signature: 'b'.repeat(60) },
          {
            kind: 'tool',
            position: 1,
            callId: 'reused',
            name: 'read',
            argsDigest: createHash('sha256').update('{}').digest('hex'),
            signature: 'b'.repeat(60),
          },
        ],
        signature: 'b'.repeat(60),
        thought: 'second reasoning',
      },
      { ...base, signature: null, thought: 'long unsigned text with no proven round ownership' },
    ];
    try {
      for (const record of records.slice(0, 2)) {
        await worker.command('save', record);
      }
      await worker.command(
        operation,
        operation === 'save' ? records[2] : { sessionKey: base.sessionKey, records: [records[2]] },
      );
    } finally {
      await worker.close();
    }
    const reopened = openWorker(name, 'thought-store');
    try {
      const actual = await reopened.command('getSession', { sessionKey: base.sessionKey });
      assert.deepEqual(
        actual.map(({ signature, thought, partSignatures }) => ({
          signature,
          thought,
          partSignatures,
        })),
        records.map(({ signature, thought, partSignatures }) => ({
          signature,
          thought,
          partSignatures,
        })),
      );
    } finally {
      await reopened.close();
    }
  });
}

for (const operation of ['save', 'ingestHistory']) {
  test(`known Claude raw and wrapped signatures match during ${operation} without rewriting stored values`, async () => {
    const raw = Buffer.from([0x08, 0x04, 0x12, ...Array(80).fill(0x7f)]).toString('base64');
    const wrapped = Buffer.from(raw, 'utf8').toString('base64');
    const name = `signature-format-${operation}`;
    const thought = openWorker(name, 'thought-store');
    const first = {
      partSignatures: [],
      createdAt: Date.now(),
      fingerprint: 'same-fingerprint',
      maxSessionBytes: 1024 * 1024,
      maxSessions: 10,
      maxTurns: 200,
      meaningful: true,
      model: 'claude-sonnet-4-6',
      sessionKey: 'format-session',
      signature: raw,
      sourceFamily: 'claude',
      thought: 'short',
      toolIds: ['shared-call'],
      toolNames: ['read'],
      visible: '',
    };
    const second = { ...first, signature: wrapped, thought: 'expanded reasoning' };
    try {
      await thought.command('save', first);
      await thought.command(
        operation,
        operation === 'save' ? second : { sessionKey: first.sessionKey, records: [second] },
      );
    } finally {
      await thought.close();
    }
    const reopened = openWorker(name, 'thought-store');
    try {
      const records = await reopened.command('getSession', { sessionKey: first.sessionKey });
      assert.deepEqual(
        records.map(({ signature, thought }) => ({ signature, thought })),
        [{ signature: wrapped, thought: second.thought }],
      );
      assert.equal(
        await reopened.command('ingestHistory', {
          sessionKey: first.sessionKey,
          records: [{ ...second, signature: raw }],
        }),
        0,
      );
      const unchanged = await reopened.command('getSession', { sessionKey: first.sessionKey });
      assert.equal(unchanged[0].signature, wrapped);
    } finally {
      await reopened.close();
    }
  });
}

for (const operation of ['save', 'ingestHistory']) {
  for (const signature of [null, 'opaque-signature-'.repeat(4)]) {
    test(`physical model ownership survives ${operation} and restart (${signature ? 'signed' : 'unsigned'})`, async () => {
      const name = `model-history-${operation}-${signature ? 'signed' : 'unsigned'}`;
      const thought = openWorker(name, 'thought-store');
      const record = (model) => ({
        partSignatures: [],
        createdAt: Date.now(),
        fingerprint: 'same-fingerprint',
        maxSessionBytes: 1024 * 1024,
        maxSessions: 10,
        maxTurns: 200,
        meaningful: true,
        model,
        sessionKey: 'model-session',
        signature,
        sourceFamily: 'claude',
        thought: `reasoning for ${model}`,
        toolIds: ['shared-call'],
        toolNames: ['read'],
        visible: '',
      });
      const first = record('claude-sonnet-4-6');
      const second = record('claude-opus-4-6-thinking');
      try {
        await thought.command('save', first);
        await thought.command(
          operation,
          operation === 'save' ? second : { sessionKey: first.sessionKey, records: [second] },
        );
      } finally {
        await thought.close();
      }
      const reopened = openWorker(name, 'thought-store');
      try {
        const records = await reopened.command('getSession', { sessionKey: first.sessionKey });
        assert.deepEqual(
          records.map(({ model, signature: value, thought }) => ({
            model,
            signature: value,
            thought,
          })),
          [first, second].map(({ model, signature: value, thought }) => ({
            model,
            signature: value,
            thought,
          })),
        );
        assert.equal(
          await reopened.command('ingestHistory', {
            sessionKey: first.sessionKey,
            records: [first, second],
          }),
          0,
        );
      } finally {
        await reopened.close();
      }
    });
  }

  test(`compatible physical model variants still merge during ${operation}`, async () => {
    const thought = openWorker(`model-variants-${operation}`, 'thought-store');
    const first = {
      partSignatures: [],
      createdAt: Date.now(),
      fingerprint: 'same-fingerprint',
      maxSessionBytes: 1024 * 1024,
      maxSessions: 10,
      maxTurns: 200,
      meaningful: true,
      model: 'gemini-3.7-flash-low',
      sessionKey: 'variant-session',
      signature: 'opaque-signature-'.repeat(4),
      sourceFamily: 'gemini-3',
      thought: 'short',
      toolIds: ['shared-call'],
      toolNames: ['read'],
      visible: '',
    };
    const second = { ...first, model: 'gemini-3.7-flash-high', thought: 'expanded reasoning' };
    try {
      await thought.command('save', first);
      await thought.command(
        operation,
        operation === 'save' ? second : { sessionKey: first.sessionKey, records: [second] },
      );
      const records = await thought.command('getSession', { sessionKey: first.sessionKey });
      assert.deepEqual(
        records.map(({ model, thought, signature }) => ({ model, thought, signature })),
        [{ model: second.model, thought: second.thought, signature: second.signature }],
      );
    } finally {
      await thought.close();
    }
  });
}

for (const operation of ['save', 'ingestHistory']) {
  test(`distinct signed tool turns survive ${operation}, replay and worker restart`, async () => {
    const name = `signed-history-${operation}`;
    const thought = openWorker(name, 'thought-store');
    const record = (signature, text) => ({
      partSignatures: [],
      createdAt: Date.now(),
      fingerprint: 'same-tool-fingerprint',
      maxSessionBytes: 1024 * 1024,
      maxSessions: 10,
      maxTurns: 200,
      meaningful: true,
      model: 'gemini-pro-agent',
      sessionKey: 'signed-session',
      signature,
      sourceFamily: 'gemini-pro',
      thought: text,
      toolIds: ['reused'],
      toolNames: ['read'],
      visible: '',
    });
    const first = record('a'.repeat(60), 'first reasoning');
    const second = record('b'.repeat(60), 'second reasoning');
    try {
      await thought.command('save', first);
      await thought.command(
        operation,
        operation === 'save' ? second : { sessionKey: first.sessionKey, records: [second] },
      );
      assert.equal(
        await thought.command('ingestHistory', {
          sessionKey: first.sessionKey,
          records: [{ ...first, thought: 'expanded first reasoning' }],
        }),
        1,
      );
    } finally {
      await thought.close();
    }
    const reopened = openWorker(name, 'thought-store');
    try {
      const records = await reopened.command('getSession', { sessionKey: first.sessionKey });
      assert.equal(records.length, 2);
      assert.deepEqual(
        records.map(({ signature, thought, toolIds }) => ({ signature, thought, toolIds })),
        [
          {
            signature: first.signature,
            thought: 'expanded first reasoning',
            toolIds: ['reused'],
          },
          { signature: second.signature, thought: second.thought, toolIds: ['reused'] },
        ],
      );
      assert.equal(
        await reopened.command('ingestHistory', {
          sessionKey: first.sessionKey,
          records: [first, second],
        }),
        0,
      );
    } finally {
      await reopened.close();
    }
  });
}

for (const policy of ['age', 'capacity']) {
  test(`Thought Store ${policy} maintenance yields between bounded session deletions`, async () => {
    const thought = openWorker(`thought-cleanup-${policy}`, 'thought-store');
    try {
      await thought.command('stats', null);
      const db = new Database(thought.databasePath);
      try {
        const insert = db.prepare(
          'INSERT INTO thinking_sessions(session_key,last_accessed) VALUES(?,?)',
        );
        db.transaction(() => {
          for (let index = 0; index < 200; index += 1) {
            insert.run(`old-${index}`, policy === 'age' ? 1 : Date.now() - 10 * 60 * 1000);
          }
        })();
        insert.run('keep', Date.now());
      } finally {
        db.close();
      }
      let previous = 201;
      for (let pass = 0; pass < 20 && previous > 1; pass += 1) {
        const progress = await thought.command('cleanup', {
          retentionDays: 1,
          maxSessions: policy === 'age' ? 2000 : 1,
        });
        const sessions = (await thought.command('stats', null)).sessions;
        assert.ok(progress.removedSessions > 0 && progress.removedSessions <= 64);
        assert.equal(previous - sessions, progress.removedSessions);
        assert.equal(progress.moreWorkPending, sessions > 1);
        previous = sessions;
      }
      assert.equal(previous, 1);
      assert.equal(
        (await thought.command('listSessions', { limit: 10, offset: 0 }))[0].sessionKey,
        'keep',
      );
    } finally {
      await thought.close();
    }
  });
}

test('cold load selects the bounded recent suffix before decoding, preserving management history', async () => {
  const thought = openWorker('cold-load-budget', 'thought-store');
  try {
    const body = 'large reasoning '.repeat(150_000);
    for (let index = 0; index < 16; index += 1) {
      await thought.command('save', {
        partSignatures: [],
        createdAt: Date.now(),
        fingerprint: `turn-${index}`,
        maxSessionBytes: 64 * 1024 * 1024,
        maxSessions: 2000,
        maxTurns: 200,
        meaningful: true,
        model: 'gemini-pro',
        sessionKey: 'cold',
        signature: `signature-${index}`,
        sourceFamily: 'gemini',
        thought: body,
        toolIds: [`tool-${index}`],
        toolNames: ['read'],
        visible: 'answer',
      });
    }
    const full = await thought.command('getSession', { sessionKey: 'cold' });
    const recent = await thought.command('load', {
      sessionKey: 'cold',
      maxTurns: 1,
      maxSessionBytes: 8 * 1024 * 1024,
    });
    assert.deepEqual(recent, full.slice(-1));
    assert.deepEqual(
      await thought.command('load', {
        sessionKey: 'cold',
        maxTurns: 200,
        maxSessionBytes: 1024 * 1024,
      }),
      [],
    );
    const db = new Database(thought.databasePath);
    try {
      db.prepare('UPDATE thinking_records SET thought=? WHERE id=?').run(
        Buffer.from('AGZ1invalid'),
        full[0].id,
      );
    } finally {
      db.close();
    }
    assert.deepEqual(
      await thought.command('load', {
        sessionKey: 'cold',
        maxTurns: 1,
        maxSessionBytes: 8 * 1024 * 1024,
      }),
      recent,
    );
    assert.equal((await thought.command('listRecords', { sessionKey: 'cold' })).length, 16);
    await assert.rejects(thought.command('getSession', { sessionKey: 'cold' }), /invalid gzip/u);
  } finally {
    await thought.close();
  }
});

test('thought compression preserves Unicode across restart and keeps short or incompressible text raw', async () => {
  const thought = openWorker('thought-codec', 'thought-store');
  const noisy = Buffer.concat(
    Array.from({ length: 12 }, (_, index) =>
      createHash('sha256').update(`noise-${index}`).digest(),
    ),
  )
    .map((value) => value & 0x7f)
    .toString('utf8');
  const cases = [
    { sessionKey: 'short', text: 'hello 世界😀', magic: 'RAW1' },
    { sessionKey: 'noise', text: noisy, magic: 'RAW1' },
    { sessionKey: 'large', text: '分析与推理😀 '.repeat(30_000), magic: 'AGZ1' },
  ];
  try {
    for (const { sessionKey, text } of cases) {
      await thought.command('save', {
        partSignatures: [],
        createdAt: Date.now(),
        fingerprint: sessionKey,
        maxSessionBytes: 64 * 1024 * 1024,
        maxSessions: 2_000,
        maxTurns: 200,
        meaningful: true,
        model: 'gemini-pro-agent',
        sessionKey,
        signature: 'synthetic-signature',
        sourceFamily: 'gemini',
        thought: text,
        toolIds: [],
        toolNames: [],
        visible: 'answer',
      });
    }
    const db = new Database(thought.databasePath, { readonly: true });
    try {
      for (const { sessionKey, text, magic } of cases) {
        const row = db
          .prepare('SELECT thought,thought_bytes bytes FROM thinking_records WHERE session_key=?')
          .get(sessionKey);
        assert.equal(row.thought.subarray(0, 4).toString(), magic);
        assert.equal(row.bytes, Buffer.byteLength(text));
        if (magic === 'AGZ1') {
          assert.ok(row.thought.byteLength < row.bytes / 10);
        }
      }
    } finally {
      db.close();
    }
  } finally {
    await thought.close();
  }
  const reopened = openWorker('thought-codec', 'thought-store');
  try {
    for (const { sessionKey, text } of cases) {
      const records = await reopened.command('getSession', { sessionKey });
      assert.equal(records.length, 1);
      assert.equal(records[0].thought, text);
      assert.equal(records[0].signature, 'synthetic-signature');
    }
  } finally {
    await reopened.close();
  }
});

test('production thought worker lists metadata without loading body and fetches one selected record', async () => {
  const thought = openWorker('thought', 'thought-store');
  try {
    const body = 'reasoning '.repeat(12_000);
    const saved = await thought.command('save', {
      partSignatures: [],
      createdAt: Date.now(),
      fingerprint: 'turn-one',
      maxSessionBytes: 64 * 1024 * 1024,
      maxSessions: 2_000,
      maxTurns: 200,
      meaningful: true,
      model: 'gemini-pro-agent',
      sessionKey: 'session-one',
      signature: 'signature-one',
      sourceFamily: 'gemini',
      thought: body,
      toolIds: [],
      toolNames: [],
      visible: 'answer',
    });
    const id = saved.id;
    assert.ok(id > 0);
    const summaries = await thought.command('listRecords', { sessionKey: 'session-one' });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].id, id);
    assert.equal(summaries[0].thoughtBytes, Buffer.byteLength(body));
    assert.equal(Object.hasOwn(summaries[0], 'thought'), false);
    assert.equal(Object.hasOwn(summaries[0], 'signature'), false);
    const matchingSessions = await thought.command('listSessions', {
      limit: 10,
      model: 'gemini-pro',
      offset: 0,
      search: 'session-',
    });
    assert.deepEqual(matchingSessions, [
      {
        bytes:
          Buffer.byteLength(body) + Buffer.byteLength('signature-one') + Buffer.byteLength('[]'),
        endedAt: null,
        lastAccessed: matchingSessions[0].lastAccessed,
        recordCount: 1,
        sessionKey: 'session-one',
      },
    ]);
    assert.deepEqual(
      await thought.command('listSessions', { limit: 10, model: 'claude', offset: 0 }),
      [],
    );
    const detail = await thought.command('getRecord', { id, sessionKey: 'session-one' });
    assert.equal(detail.thought, body);
    assert.equal(await thought.command('getRecord', { id, sessionKey: 'another-session' }), null);
  } finally {
    await thought.close();
  }
});

test('corrupt compressed thought fails explicitly without deleting the record or stopping the worker', async () => {
  const thought = openWorker('thought-corrupt-codec', 'thought-store');
  try {
    const saved = await thought.command('save', {
      partSignatures: [],
      createdAt: Date.now(),
      fingerprint: 'corrupt-turn',
      maxSessionBytes: 64 * 1024 * 1024,
      maxSessions: 2_000,
      maxTurns: 200,
      meaningful: true,
      model: 'gemini-pro-agent',
      sessionKey: 'corrupt-session',
      signature: 'synthetic-signature',
      sourceFamily: 'gemini',
      thought: 'compressible thought '.repeat(200),
      toolIds: [],
      toolNames: [],
      visible: 'answer',
    });
    const corrupted = Buffer.from('AGZ1truncated');
    const db = new Database(thought.databasePath);
    try {
      db.prepare('UPDATE thinking_records SET thought=? WHERE id=?').run(corrupted, saved.id);
    } finally {
      db.close();
    }
    await assert.rejects(
      thought.command('getRecord', { id: saved.id, sessionKey: 'corrupt-session' }),
      new RegExp(`Thought Store record ${saved.id} contains invalid gzip data`, 'u'),
    );
    await assert.rejects(
      thought.command('getSession', { sessionKey: 'corrupt-session' }),
      /invalid gzip data/u,
    );
    assert.equal(
      (await thought.command('listRecords', { sessionKey: 'corrupt-session' })).length,
      1,
    );
    const preserved = new Database(thought.databasePath, { readonly: true });
    try {
      assert.deepEqual(
        preserved.prepare('SELECT thought FROM thinking_records WHERE id=?').get(saved.id).thought,
        corrupted,
      );
    } finally {
      preserved.close();
    }
  } finally {
    await thought.close();
  }
});

test('production thought worker ingests repeated history without duplicating turns and upgrades older thought', async () => {
  const thought = openWorker('thought-history', 'thought-store');
  const sessionKey = 'history-session';
  const record = (fingerprint, text) => ({
    partSignatures: [],
    createdAt: Date.now(),
    fingerprint,
    maxSessionBytes: 64 * 1024 * 1024,
    maxSessions: 2_000,
    maxTurns: 200,
    meaningful: true,
    model: 'gemini-pro-agent',
    sessionKey,
    signature: null,
    sourceFamily: 'gemini-pro',
    thought: text,
    toolIds: [],
    toolNames: [],
    visible: fingerprint,
  });
  try {
    await thought.command('save', record('first', 'short'));
    await thought.command('save', record('second', 'second thought'));
    const history = [
      record('first', 'expanded full first thought'),
      record('second', 'second thought'),
      record('third', 'third thought'),
    ];
    await thought.command('ingestHistory', { records: history, sessionKey });
    await thought.command('ingestHistory', { records: history, sessionKey });
    const stored = await thought.command('getSession', { sessionKey });
    assert.deepEqual(
      stored.map((item) => item.fingerprint),
      ['first', 'second', 'third'],
    );
    assert.deepEqual(
      stored.map((item) => item.thought),
      ['expanded full first thought', 'second thought', 'third thought'],
    );
  } finally {
    await thought.close();
  }
});

test('production thought worker refuses session overflow until bounded idle maintenance makes room', async () => {
  const thought = openWorker('thought-session-prune', 'thought-store');
  const first = Date.now() - 10 * 60 * 1000;
  try {
    for (const [sessionKey, createdAt] of [
      ['older-session', first],
      ['newer-session', first + 1],
    ]) {
      const payload = {
        partSignatures: [],
        createdAt,
        fingerprint: sessionKey,
        maxSessionBytes: 64 * 1024 * 1024,
        maxSessions: 1,
        maxTurns: 200,
        meaningful: true,
        model: 'gemini-pro-agent',
        sessionKey,
        signature: null,
        sourceFamily: 'gemini',
        thought: sessionKey,
        toolIds: [],
        toolNames: [],
        visible: sessionKey,
      };
      if (sessionKey === 'newer-session') {
        await assert.rejects(thought.command('save', payload), /session_capacity/u);
        const progress = await thought.command('cleanup', { retentionDays: 15, maxSessions: 0 });
        assert.equal(progress.removedSessions, 1);
        assert.deepEqual(progress.invalidatedSessions, ['older-session']);
      }
      await thought.command('save', payload);
    }
    const sessions = await thought.command('listSessions', { limit: 10, offset: 0 });
    assert.deepEqual(
      sessions.map((session) => session.sessionKey),
      ['newer-session'],
    );
  } finally {
    await thought.close();
  }
});
