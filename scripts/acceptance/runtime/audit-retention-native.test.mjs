import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { openWorker, parent, addBody, retention, list } from './diagnostic-worker-fixture.mjs';

test('production worker applies admin and traffic-class row priority', async () => {
  const audit = openWorker('rows');
  try {
    const now = Date.now();
    for (const trafficClass of ['model', 'auxiliary', 'ipc', 'system']) {
      await audit.command('insertParent', parent(trafficClass, trafficClass, now));
    }
    await audit.command('adminEvent', {
      affectedCount: null,
      error: null,
      operation: 'clear',
      outcome: 'success',
      timestamp: now,
    });
    for (const [maxRows, expectedClass, removedClass] of [
      [4, 'system', null],
      [3, 'ipc', 'system'],
      [2, 'auxiliary', 'ipc'],
      [1, 'model', 'auxiliary'],
    ]) {
      const result = await audit.command('maintenance', retention(maxRows));
      assert.ok(result.databaseBytes > 0);
      const stats = await audit.command('stats', null);
      assert.equal(stats.rows, maxRows);
      const expected = await list(audit, expectedClass);
      assert.equal(expected.total, 1);
      if (removedClass) {
        assert.equal((await list(audit, removedClass)).total, 0);
      }
      if (maxRows === 4) {
        assert.equal(expected.items[0].recordKind, 'request');
      }
    }
    assert.equal((await list(audit, 'model')).total, 1);
    assert.equal((await list(audit, 'auxiliary')).total, 0);
    assert.equal((await list(audit, 'ipc')).total, 0);
    assert.equal((await list(audit, 'system')).total, 0);
  } finally {
    await audit.close();
  }
});

test('production worker reclaims disk after lower-priority body eviction without deleting model data', async () => {
  const audit = openWorker('disk');
  try {
    const now = Date.now();
    await audit.command('insertParent', parent('system', 'system', now));
    await audit.command('insertParent', parent('model', 'model', now));
    // Distinct chunks prevent SQLite from hiding eviction errors behind compression.
    const systemBody = Array.from(
      { length: 20 },
      (_, index) => String(index).padStart(4, '0') + 's'.repeat(32_764),
    ).join('');
    const modelBody = 'm'.repeat(130_000);
    await addBody(audit, 'system', 'system-body', systemBody);
    await addBody(audit, 'model', 'model-body', modelBody);
    await audit.command('maintenance', retention(100));
    const before = await audit.command('stats', null);
    const budget = before.databaseBytes - 200_000;
    assert.ok(budget > 0);
    const result = await audit.command('maintenance', retention(100, budget));
    const modelDetail = await audit.command('detail', { id: 'model' });
    const systemDetail = await audit.command('detail', { id: 'system' });
    const db = new Database(audit.databasePath, { readonly: true });
    const storage = {
      autoVacuum: db.pragma('auto_vacuum', { simple: true }),
      free: db.pragma('freelist_count', { simple: true }),
      pages: db.pragma('page_count', { simple: true }),
    };
    db.close();
    assert.equal(storage.autoVacuum, 2);
    assert.ok(
      result.databaseBytes <= budget,
      `database ${result.databaseBytes} exceeded ${budget}; system=${systemDetail?.bodies[0]?.state}; model=${modelDetail?.bodies[0]?.state}; storage=${JSON.stringify(storage)}`,
    );
    assert.equal((await list(audit, 'model')).total, 1);
    assert.equal(modelDetail.bodies[0].state, 'complete');
    assert.equal(systemDetail.bodies[0].state, 'expired');
    assert.equal(systemDetail.bodies[0].droppedReason, 'disk_pressure');
  } finally {
    await audit.close();
  }
});
