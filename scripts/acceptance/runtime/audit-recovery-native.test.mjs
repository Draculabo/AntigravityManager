import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { openWorker, parent, completedParent, retention } from './diagnostic-worker-fixture.mjs';

const boundary = 10_000;
const openAudit = (name, ownerStartedAt) =>
  openWorker(name, 'traffic-audit', {
    workerPath: process.env.AGM_AUDIT_WORKER_ENTRY,
    ownerStartedAt,
  });

test('production Worker reconciles old captures, preserves live replacements and retires abandoned parents under capacity', async () => {
  let audit = openAudit('restart-recovery', 0);
  let closed = false;
  try {
    await audit.command('insertParent', parent('abandoned', 'model', 1));
    await audit.command('insertAttempt', {
      accountId: null,
      accountIdHash: null,
      accountGenerationHash: null,
      accountSubjectHash: null,
      accountGrantHash: null,
      usageScope: null,
      attemptIndex: 1,
      endpoint: 'https://example.test',
      id: 'abandoned-attempt',
      model: null,
      operation: 'generate',
      parentId: 'abandoned',
      requestHeaders: '{}',
      timestamp: 1,
    });
    await audit.command('beginPayload', {
      createdAt: 1,
      direction: 'response',
      id: 'body',
      kind: 'text',
      ownerId: 'abandoned',
      ownerKind: 'parent',
      parentId: 'abandoned',
      representation: 'sanitized_text',
    });
    await audit.command('appendPayloadChunk', {
      data: 'stored prefix',
      payloadId: 'body',
      sequence: 0,
    });
    await audit.command('insertParent', parent('live', 'model', boundary));
    await audit.command('beginPayload', {
      createdAt: boundary,
      direction: 'response',
      id: 'live-body',
      kind: 'text',
      ownerId: 'live',
      ownerKind: 'parent',
      parentId: 'live',
      representation: 'sanitized_text',
    });
    await audit.close();
    closed = true;
    audit = openAudit('restart-recovery', boundary);
    closed = false;
    const detail = await audit.command('detail', { id: 'abandoned' });
    assert.equal(detail.request.outcome, 'capture_interrupted');
    assert.equal(detail.request.status, null);
    assert.equal(detail.request.durationMs, null);
    assert.equal(detail.attempts[0].outcome, 'capture_interrupted');
    assert.equal(detail.bodies[0].state, 'incomplete');
    assert.equal(detail.bodies[0].storedBytes, 13);
    assert.equal(detail.bodies[0].droppedReason, 'worker_restart');
    assert.equal(
      (await audit.command('bodyPage', { bodyId: 'body', cursor: 0, limitBytes: 1024 })).chunks[0]
        .data,
      'stored prefix',
    );
    assert.equal(
      (await audit.command('list', { limit: 20, offset: 0, statusMode: 'unfinished' })).total,
      1,
    );
    const first = JSON.stringify(detail);
    await audit.close();
    closed = true;
    audit = openAudit('restart-recovery', boundary);
    closed = false;
    assert.equal(JSON.stringify(await audit.command('detail', { id: 'abandoned' })), first);
    assert.equal((await audit.command('detail', { id: 'live' })).request.outcome, 'in_progress');
    assert.equal((await audit.command('detail', { id: 'live' })).bodies[0].state, 'writing');
    await audit.command('appendPayloadChunk', {
      data: 'live continuation',
      payloadId: 'live-body',
      sequence: 0,
    });
    await audit.command('maintenance', retention(1));
    assert.equal(await audit.command('detail', { id: 'abandoned' }), null);
    assert.equal((await audit.command('detail', { id: 'live' })).request.id, 'live');
    const db = new Database(audit.databasePath, { readonly: true });
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 7);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
    await audit.command('completeParent', completedParent('live'));
  } finally {
    if (!closed) {
      await audit.close();
    }
  }
});

test('production statistics include only recognized archived files without deleting or resetting them', async () => {
  const audit = openAudit('archive-accounting', 0);
  try {
    const files = [
      ['.schema-v3-backup-123', 101],
      ['.schema-v3-backup-123-wal', 103],
      ['.corrupt-456', 107],
      ['.corrupt-456-shm', 109],
    ];
    for (const [suffix, size] of files) {
      fs.writeFileSync(`${audit.databasePath}${suffix}`, Buffer.alloc(size, 33));
    }
    fs.writeFileSync(`${audit.databasePath}.unknown-backup`, 'ignore');
    const stats = await audit.command('stats', null);
    assert.deepEqual(stats.archives, { status: 'complete', bytes: 420, files: 4 });
    assert.ok(stats.databaseBytes > 0);
    await audit.command('maintenance', retention(100, 0));
    assert.deepEqual((await audit.command('stats', null)).archives, stats.archives);
    for (const [suffix, size] of files) {
      assert.equal(fs.statSync(`${audit.databasePath}${suffix}`).size, size);
    }
  } finally {
    await audit.close();
  }
});
