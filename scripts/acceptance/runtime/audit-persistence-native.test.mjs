import assert from 'node:assert/strict';
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
  list,
} from './diagnostic-worker-fixture.mjs';

test('production worker reopens schema v4 and serves paged UTF-8 bodies with parent-local dedup', async () => {
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
  assert.equal(db.pragma('user_version', { simple: true }), 4);
  assert.equal(
    db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value,
    '4',
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
    '4',
  );
  assert.equal(
    db.prepare("SELECT value FROM schema_meta WHERE key='layout'").get().value,
    'classified-chunked-payload-v4',
  );
  assert.equal(db.pragma('auto_vacuum', { simple: true }), 2);
  db.close();
});

test('schema v3 is preserved as a recoverable backup and replaced with an empty v4 database', async () => {
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
  assert.equal(current.pragma('user_version', { simple: true }), 4);
  current.close();
});

test('future audit schema is rejected without archiving or replacing its data', async () => {
  const audit = openWorker('future-version');
  await audit.command('insertParent', parent('future-row', 'model', Date.now()));
  await audit.close();
  const database = new Database(audit.databasePath);
  database.pragma('user_version = 5');
  database.close();

  const workerPath = path.resolve(__dirname, '../../../.vite/build/traffic-audit.worker.js');
  const worker = new Worker(workerPath, { workerData: { databasePath: audit.databasePath } });
  const failure = await new Promise((resolve) => worker.once('error', resolve));
  assert.match(failure.message, /Unsupported traffic audit schema version: 5/);
  await worker.terminate();

  const preserved = new Database(audit.databasePath, { readonly: true });
  assert.equal(preserved.pragma('user_version', { simple: true }), 5);
  assert.equal(
    preserved.prepare("SELECT id FROM request_logs WHERE id='future-row'").get().id,
    'future-row',
  );
  preserved.close();
  assert.equal(
    fs
      .readdirSync(testDirectory)
      .some((name) => name.startsWith('future-version.db.schema-v5-backup-')),
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
