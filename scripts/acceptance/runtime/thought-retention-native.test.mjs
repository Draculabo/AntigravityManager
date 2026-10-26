import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { openWorker as openDiagnosticWorker } from './diagnostic-worker-fixture.mjs';

function openWorker(name) {
  return openDiagnosticWorker(name, 'thought-store', {
    workerPath: process.env.AGM_THOUGHT_WORKER_ENTRY,
  });
}
function seed(databasePath, records, lastAccessed, { legacyVacuum = false, bodyBytes = 2 } = {}) {
  const db = new Database(databasePath);
  if (legacyVacuum) {
    db.pragma('auto_vacuum = NONE');
    db.exec('VACUUM');
  }
  db.prepare('INSERT INTO thinking_sessions(session_key,last_accessed) VALUES (?,?)').run(
    'old',
    lastAccessed,
  );
  const insert = db.prepare(
    "INSERT INTO thinking_records(session_key,fingerprint,thought,thought_bytes,signature,part_signatures,signature_bytes,tool_ids,tool_names,visible,model,source_family,oversized,created_at,last_accessed) VALUES ('old',?,?,?,NULL,'[]',2,'[]','[]','','gemini-pro','gemini',0,1,1)",
  );
  const body = Buffer.concat([Buffer.from('RAW1'), Buffer.alloc(bodyBytes, 120)]);
  db.transaction(() => {
    for (let index = 0; index < records; index += 1) {
      insert.run(`turn-${index}`, body, bodyBytes);
    }
  })();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

test('thought expiry yields after 128 records instead of cascading a long session', async () => {
  const worker = openWorker('bounded-long-session-cleanup');
  try {
    await worker.command('stats', null);
    seed(worker.databasePath, 260, 1);
    const first = await worker.command('cleanup', { retentionDays: 15, maxSessions: 2000 });
    assert.equal(first.removedSessions, 0);
    assert.ok(first.removedRecords > 0 && first.removedRecords <= 128);
    assert.deepEqual(first.invalidatedSessions, ['old']);
    assert.equal(first.moreWorkPending, true);
    const firstCount = (await worker.command('stats', null)).records;
    assert.equal(firstCount, 260 - first.removedRecords);
    let totalRecords = first.removedRecords;
    let totalSessions = 0;
    for (let pass = 0; pass < 10 && totalRecords < 260; pass += 1) {
      const result = await worker.command('cleanup', { retentionDays: 15, maxSessions: 2000 });
      assert.ok(result.removedRecords <= 128);
      totalRecords += result.removedRecords;
      totalSessions += result.removedSessions;
    }
    assert.equal(totalRecords, 260);
    assert.equal(totalSessions, 1);
    assert.equal((await worker.command('stats', null)).records, 0);
  } finally {
    await worker.close();
  }
});

test('thought disk pressure pauses for a pinned reader and resumes after release', async () => {
  const worker = openWorker('thought-reader-pressure');
  let reader;
  try {
    await worker.command('stats', null);
    seed(worker.databasePath, 260, Date.now() - 10 * 60 * 1000, { bodyBytes: 4096 });
    reader = new Database(worker.databasePath, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM thinking_records').get();
    const writer = new Database(worker.databasePath);
    writer.prepare('UPDATE thinking_sessions SET ended_at=2 WHERE session_key=?').run('old');
    writer.close();
    const blocked = await worker.command('cleanup', {
      retentionDays: 15,
      maxSessions: 2000,
      maxDiskBytes: 1,
    });
    assert.equal(blocked.blockedReason, 'checkpoint_busy');
    assert.equal(blocked.removedRecords, 0);
    assert.equal((await worker.command('stats', null)).records, 260);
    reader.exec('ROLLBACK');
    reader.close();
    reader = undefined;
    const resumed = await worker.command('cleanup', {
      retentionDays: 15,
      maxSessions: 2000,
      maxDiskBytes: 1,
    });
    assert.ok(resumed.removedRecords > 0 && resumed.removedRecords <= 128);
    assert.notEqual(resumed.blockedReason, 'checkpoint_busy');
  } finally {
    reader?.close();
    await worker.close();
  }
});

test('legacy non-shrinking thought files stop pressure deletion after no physical progress', async () => {
  const worker = openWorker('thought-no-progress');
  try {
    await worker.command('stats', null);
    seed(worker.databasePath, 260, Date.now() - 10 * 60 * 1000, {
      legacyVacuum: true,
      bodyBytes: 4096,
    });
    const progress = await worker.command('cleanup', {
      retentionDays: 15,
      maxSessions: 2000,
      maxDiskBytes: 1,
    });
    assert.equal(progress.blockedReason, 'no_progress');
    assert.equal(progress.moreWorkPending, false);
    assert.ok(progress.removedRecords > 0 && progress.removedRecords <= 128);
    assert.equal((await worker.command('stats', null)).records, 260 - progress.removedRecords);
    const repeated = await worker.command('cleanup', {
      retentionDays: 15,
      maxSessions: 2000,
      maxDiskBytes: 1,
    });
    assert.equal(repeated.blockedReason, 'no_progress');
    assert.equal(repeated.removedRecords, 0);
    assert.equal((await worker.command('stats', null)).records, 260 - progress.removedRecords);
  } finally {
    await worker.close();
  }
});

test('count and disk pressure preserve recently used thought sessions', async () => {
  const worker = openWorker('thought-active-session');
  try {
    await worker.command('stats', null);
    seed(worker.databasePath, 4, Date.now());
    const result = await worker.command('cleanup', {
      retentionDays: 15,
      maxSessions: 0,
      maxDiskBytes: 1,
    });
    assert.equal(result.removedSessions, 0);
    assert.equal(result.removedRecords, 0);
    assert.equal((await worker.command('stats', null)).records, 4);
  } finally {
    await worker.close();
  }
});

test('an active request protects even an old durable session beyond the idle grace', async () => {
  const worker = openWorker('thought-active-old-session');
  try {
    await worker.command('stats', null);
    seed(worker.databasePath, 4, 1);
    const held = await worker.command('cleanup', {
      retentionDays: 15,
      maxSessions: 0,
      maxDiskBytes: 1,
      protectedSessionKeys: ['old'],
    });
    assert.equal(held.removedRecords, 0);
    assert.equal(held.moreWorkPending, false);
    assert.equal((await worker.command('stats', null)).records, 4);
    const released = await worker.command('cleanup', {
      retentionDays: 15,
      maxSessions: 0,
      maxDiskBytes: 1,
      protectedSessionKeys: [],
    });
    assert.equal(released.removedRecords, 4);
    assert.equal(released.removedSessions, 1);
  } finally {
    await worker.close();
  }
});

test('thought pressure reclaims existing free-page backlog to its target before deleting more history', async () => {
  const worker = openWorker('thought-existing-free-pages');
  try {
    await worker.command('stats', null);
    seed(worker.databasePath, 1000, Date.now() - 10 * 60 * 1000, { bodyBytes: 4096 });
    const db = new Database(worker.databasePath);
    db.prepare('DELETE FROM thinking_records WHERE id > 4').run();
    db.pragma('wal_checkpoint(TRUNCATE)');
    assert.ok(db.pragma('freelist_count', { simple: true }) > 128);
    db.close();
    const before = (await worker.command('stats', null)).databaseBytes;
    const limit = Math.floor(before * 0.9);
    let pending = true;
    for (let pass = 0; pass < 30 && pending; pass += 1) {
      const result = await worker.command('cleanup', {
        retentionDays: 15,
        maxSessions: 2000,
        maxDiskBytes: limit,
      });
      assert.equal(result.removedRecords, 0);
      pending = result.moreWorkPending;
    }
    assert.equal(pending, false);
    const final = await worker.command('stats', null);
    assert.equal(final.records, 4);
    assert.ok(final.databaseBytes <= limit * 0.7);
  } finally {
    await worker.close();
  }
});
