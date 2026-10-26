import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { openWorker, parent } from './diagnostic-worker-fixture.mjs';

test('audit write budget crosses the real worker boundary and retains query/reopen access', async () => {
  const options = process.env.AGM_AUDIT_WORKER_ENTRY
    ? { workerPath: path.resolve(process.env.AGM_AUDIT_WORKER_ENTRY) }
    : {};
  const audit = openWorker('admission-boundary', 'traffic-audit', options);
  try {
    await assert.rejects(
      audit.command('insertParent', parent('rejected', 'model', Date.now()), { maxDiskBytes: 0 }),
      /audit_disk_budget/u,
    );
    assert.equal((await audit.command('stats', null)).rows, 0);
    assert.equal(
      await audit.command('insertParent', parent('accepted', 'model', Date.now()), {
        maxDiskBytes: 16 * 1024 * 1024,
      }),
      1,
    );
    await audit.command(
      'beginPayload',
      {
        createdAt: Date.now(),
        direction: 'request',
        id: 'denied-body',
        kind: 'text',
        ownerId: 'accepted',
        ownerKind: 'parent',
        parentId: 'accepted',
        representation: 'sanitized_text',
      },
      { maxDiskBytes: 16 * 1024 * 1024 },
    );
    await assert.rejects(
      audit.command(
        'appendPayloadChunk',
        { payloadId: 'denied-body', sequence: 0, data: 'not-persisted' },
        { maxDiskBytes: 0 },
      ),
      /audit_disk_budget; capture_metadata_unpersisted/u,
    );
    await assert.rejects(
      audit.command('insertParent', parent('bad-budget', 'model', Date.now()), {
        maxDiskBytes: -1,
      }),
      /Invalid traffic audit worker message/u,
    );
    assert.equal((await audit.command('stats', null)).rows, 1);
    assert.equal((await audit.command('detail', { id: 'accepted' })).request.id, 'accepted');
  } finally {
    await audit.close();
  }
  const reopened = openWorker('admission-boundary', 'traffic-audit', options);
  try {
    assert.equal((await reopened.command('detail', { id: 'accepted' })).request.id, 'accepted');
    assert.equal((await reopened.command('stats', null)).rows, 1);
  } finally {
    await reopened.close();
  }
});
