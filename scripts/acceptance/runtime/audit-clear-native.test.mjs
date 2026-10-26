import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { openWorker, parent } from './diagnostic-worker-fixture.mjs';

const openAudit = (name) =>
  openWorker(name, 'traffic-audit', { workerPath: process.env.AGM_AUDIT_WORKER_ENTRY });
test('serial Worker rejects delayed old parent admission after a scoped clear and preserves new/unaffected captures', async () => {
  const audit = openAudit('clear-generation');
  try {
    await audit.command('insertParent', parent('old', 'model', 1));
    await audit.command('insertParent', parent('aux', 'auxiliary', 1));
    await audit.command('beginPayload', {
      createdAt: 1,
      direction: 'response',
      id: 'body',
      kind: 'text',
      ownerId: 'old',
      ownerKind: 'parent',
      parentId: 'old',
      representation: 'sanitized_text',
    });
    await audit.command('appendPayloadChunk', { data: 'prefix', payloadId: 'body', sequence: 0 });
    assert.equal(await audit.command('clear', { trafficClass: 'model' }), 1);
    assert.equal(
      await audit.command('insertParent', parent('delayed', 'model', 1), {
        capture: { trafficClass: 'model', generation: 0 },
      }),
      0,
    );
    assert.equal(
      await audit.command('beginPayload', {
        createdAt: 1,
        direction: 'response',
        id: 'late-body',
        kind: 'text',
        ownerId: 'old',
        ownerKind: 'parent',
        parentId: 'old',
        representation: 'sanitized_text',
      }),
      0,
    );
    assert.equal(
      await audit.command('appendPayloadChunk', { data: 'late', payloadId: 'body', sequence: 1 }),
      0,
    );
    assert.equal(
      await audit.command('insertAttempt', {
        accountId: null,
        accountIdHash: null,
        attemptIndex: 1,
        endpoint: 'https://example.test',
        id: 'late-attempt',
        model: null,
        operation: 'generate',
        parentId: 'old',
        requestHeaders: '{}',
        timestamp: 1,
      }),
      0,
    );
    assert.equal(await audit.command('detail', { id: 'old' }), null);
    assert.equal(await audit.command('detail', { id: 'delayed' }), null);
    assert.equal((await audit.command('detail', { id: 'aux' })).request.id, 'aux');
    assert.equal(await audit.command('insertParent', parent('new', 'model', Date.now())), 1);
    assert.equal((await audit.command('detail', { id: 'new' })).request.id, 'new');
  } finally {
    await audit.close();
  }
});
test('all-scope clear rolls back request deletion and its generation floor when admin deletion fails', async () => {
  const audit = openAudit('clear-rollback');
  try {
    await audit.command('insertParent', parent('preserve', 'model', 1));
    await audit.command('adminEvent', {
      affectedCount: null,
      error: null,
      operation: 'synthetic',
      outcome: 'completed',
      timestamp: 1,
    });
    const db = new Database(audit.databasePath);
    try {
      db.exec(
        "CREATE TRIGGER fail_admin_clear BEFORE DELETE ON audit_admin_events BEGIN SELECT RAISE(ABORT,'synthetic clear failure'); END",
      );
    } finally {
      db.close();
    }
    await assert.rejects(
      audit.command('clear', { trafficClass: null }),
      /synthetic clear failure/u,
    );
    assert.equal((await audit.command('detail', { id: 'preserve' })).request.id, 'preserve');
    assert.equal(
      await audit.command('insertParent', parent('still-current', 'model', 2), {
        capture: { trafficClass: 'model', generation: 0 },
      }),
      1,
    );
    const repair = new Database(audit.databasePath);
    try {
      repair.exec('DROP TRIGGER fail_admin_clear');
    } finally {
      repair.close();
    }
    assert.equal(await audit.command('clear', { trafficClass: null }), 3);
    assert.equal(
      await audit.command(
        'adminEvent',
        {
          affectedCount: null,
          error: null,
          operation: 'old-event',
          outcome: 'completed',
          timestamp: 1,
        },
        { capture: { trafficClass: 'system', generation: 0 } },
      ),
      0,
    );
    assert.equal((await audit.command('list', { limit: 20, offset: 0 })).total, 0);
  } finally {
    await audit.close();
  }
});
