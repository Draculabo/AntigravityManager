import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('disk eviction preserves newer bodies when one body satisfies the budget', async () => {
  const audit = openWorker('disk-body-budget');
  try {
    for (let index = 0; index < 5; index += 1) {
      const id = `model-${index}`;
      await audit.command('insertParent', parent(id, 'model', Date.now()));
      await addBody(audit, id, `${id}-body`, String(index).repeat(262_144));
    }
    await audit.command('maintenance', retention(100));
    const before = await audit.command('stats', null);
    const budget = before.databaseBytes - 65_536;
    const result = await audit.command('maintenance', retention(100, budget));
    const states = [];
    for (let index = 0; index < 5; index += 1) {
      const detail = await audit.command('detail', { id: `model-${index}` });
      states.push(detail.bodies[0].state);
    }
    assert.ok(result.databaseBytes <= budget);
    assert.deepEqual(states, ['expired', 'complete', 'complete', 'complete', 'complete']);
    assert.equal((await list(audit, 'model')).total, 5);
  } finally {
    await audit.close();
  }
});

test('disk eviction remeasures a small fragmented body before discarding a large body', async () => {
  const audit = openWorker('disk-fragmented-body');
  try {
    await audit.command('insertParent', parent('small', 'model', Date.now()));
    await addBody(audit, 'small', 'small-body', 's');
    await audit.command('insertParent', parent('large', 'model', Date.now()));
    await addBody(audit, 'large', 'large-body', 'l'.repeat(262_144));
    const db = new Database(audit.databasePath);
    try {
      // Many small stream chunks occupy more SQLite pages than their stored byte total.
      db.transaction(() => {
        db.prepare('DELETE FROM audit_payload_chunks WHERE payload_id=?').run('small-body');
        const insert = db.prepare(
          'INSERT INTO audit_payload_chunks(payload_id,seq,payload,byte_length) VALUES(?,?,?,1)',
        );
        for (let sequence = 0; sequence < 1024; sequence += 1) {
          insert.run('small-body', sequence, Buffer.from('s'));
        }
        db.prepare(
          'UPDATE audit_payloads SET stored_bytes=1024,logical_bytes=1024,chunk_count=1024,sha256=? WHERE id=?',
        ).run(createHash('sha256').update('s'.repeat(1024)).digest('hex'), 'small-body');
      })();
    } finally {
      db.close();
    }
    await audit.command('maintenance', retention(100));
    const before = await audit.command('stats', null);
    const budget = before.databaseBytes - 8192;
    const result = await audit.command('maintenance', retention(100, budget));
    const small = await audit.command('detail', { id: 'small' });
    const large = await audit.command('detail', { id: 'large' });
    assert.ok(result.databaseBytes <= budget);
    assert.deepEqual([small.bodies[0].state, large.bodies[0].state], ['expired', 'complete']);
  } finally {
    await audit.close();
  }
});

test('disk eviction advances across tied timestamps and candidate pages', async () => {
  const audit = openWorker('disk-cursor');
  try {
    await audit.command('stats', null);
    const db = new Database(audit.databasePath);
    try {
      db.pragma('foreign_keys = ON');
      const insertParent = db.prepare(
        "INSERT INTO request_logs(id,timestamp,method,url,protocol,traffic_class,request_headers,outcome) VALUES(?,?,'POST','/v1/chat/completions','openai',?,'{}','completed')",
      );
      const insertPayload = db.prepare(
        "INSERT INTO audit_payloads(id,request_id,kind,representation,state,stored_bytes,logical_bytes,chunk_count,created_at) VALUES(?,?,'text','sanitized_json','complete',4096,4096,1,?)",
      );
      const insertChunk = db.prepare(
        'INSERT INTO audit_payload_chunks(payload_id,seq,payload,byte_length) VALUES(?,0,?,4096)',
      );
      const insertRef = db.prepare(
        "INSERT INTO request_body_refs(request_id,direction,payload_id) VALUES(?,'request',?)",
      );
      const now = Date.now();
      db.transaction(() => {
        // The oldest model body must survive every system candidate page.
        for (let index = -1; index < 1500; index += 1) {
          const id = index === -1 ? 'model' : `system-${String(index).padStart(4, '0')}`;
          const payloadId = `${id}-body`;
          insertParent.run(id, now, index === -1 ? 'model' : 'system');
          insertPayload.run(payloadId, id, now);
          insertChunk.run(payloadId, Buffer.alloc(4096, index % 256));
          insertRef.run(id, payloadId);
        }
      })();
    } finally {
      db.close();
    }
    await audit.command('maintenance', retention(10_000));
    const before = await audit.command('stats', null);
    const budget = before.databaseBytes - 4_500_000;
    const result = await audit.command('maintenance', retention(10_000, budget));
    assert.ok(result.databaseBytes <= budget);
    assert.equal((await audit.command('stats', null)).rows, 1501);
    for (const [id, state] of [
      ['system-0000', 'expired'],
      ['system-0500', 'expired'],
      ['system-1499', 'complete'],
      ['model', 'complete'],
    ]) {
      const detail = await audit.command('detail', { id });
      assert.equal(detail.bodies[0].state, state, id);
    }
  } finally {
    await audit.close();
  }
});

test('existing v4 databases gain the eviction index without replacing audit records', async () => {
  const initial = openWorker('disk-index-reopen');
  try {
    await initial.command('insertParent', parent('model', 'model', Date.now()));
    await addBody(initial, 'model', 'model-body', 'm'.repeat(262_144));
  } finally {
    await initial.close();
  }
  const db = new Database(initial.databasePath);
  try {
    // Recreate the index layout shipped before ordered disk eviction.
    db.exec(
      'DROP INDEX IF EXISTS idx_payload_disk_eviction;' +
        'CREATE INDEX IF NOT EXISTS idx_payload_stored_bytes ON audit_payloads(stored_bytes,created_at);',
    );
  } finally {
    db.close();
  }
  const reopened = openWorker('disk-index-reopen');
  try {
    await reopened.command('maintenance', retention(100));
    const before = await reopened.command('stats', null);
    assert.equal(before.rows, 1);
    const detail = await reopened.command('detail', { id: 'model' });
    assert.equal(detail.bodies[0].state, 'complete');
    const budget = before.databaseBytes - 65_536;
    const result = await reopened.command('maintenance', retention(100, budget));
    assert.ok(result.databaseBytes <= budget);
    assert.equal((await list(reopened, 'model')).total, 1);
    const expired = await reopened.command('detail', { id: 'model' });
    assert.equal(expired.bodies[0].droppedReason, 'disk_pressure');
  } finally {
    await reopened.close();
  }
});

test('maintenance serves reads and new writes before final completion without evicting new rows', async () => {
  const audit = openWorker('cooperative-maintenance');
  const events = [];
  try {
    for (let index = 0; index < 5; index += 1) {
      await audit.command('insertParent', parent(`old-${index}`, 'system', Date.now() - 1000));
      await addBody(audit, `old-${index}`, `old-${index}-body`, 's'.repeat(4096));
    }
    let observations = 0;
    const result = await audit.command(
      'maintenance',
      { ...retention(0), bodyRetentionHours: 0 },
      {
        onYield: async () => {
          if (observations >= 3) {
            return;
          }
          observations += 1;
          await audit.command('stats', null);
          await list(audit, 'system');
          events.push('read');
          if (observations === 1) {
            await audit.command('insertParent', parent('new', 'model', Date.now()));
            await addBody(audit, 'new', 'new-body', 'new complete body');
            events.push('write');
          }
        },
      },
    );
    events.push('complete');
    assert.deepEqual(events, ['read', 'write', 'read', 'read', 'complete']);
    assert.ok(result.databaseBytes > 0);
    assert.equal((await list(audit, 'system')).total, 0);
    assert.equal((await list(audit, 'model')).total, 1);
    const detail = await audit.command('detail', { id: 'new' });
    assert.equal(detail.bodies[0].state, 'complete');
    assert.equal(detail.bodies[0].storedBytes, Buffer.byteLength('new complete body'));
  } finally {
    await audit.close();
  }
});

test('maintenance does not evict new rows when a concurrent clear reuses SQLite row IDs', async () => {
  const audit = openWorker('maintenance-clear-race');
  try {
    await audit.command('insertParent', parent('old', 'model', Date.now() - 1000));
    await addBody(audit, 'old', 'old-body', 'old body');
    let replaced = false;
    await audit.command('maintenance', retention(0, 0), {
      onYield: async () => {
        if (replaced) {
          return;
        }
        replaced = true;
        await audit.command('clear', { trafficClass: null });
        await audit.command('insertParent', parent('new', 'model', Date.now()));
        await addBody(audit, 'new', 'new-body', 'new body after clear');
      },
    });
    assert.equal(replaced, true);
    assert.equal((await list(audit, 'model')).total, 1);
    const detail = await audit.command('detail', { id: 'new' });
    assert.equal(detail.bodies[0].state, 'complete');
  } finally {
    await audit.close();
  }
});

test('row-limit maintenance accounts for concurrent user deletions between batches', async () => {
  const audit = openWorker('maintenance-delete-race');
  try {
    for (let index = 0; index < 100; index += 1) {
      await audit.command('insertParent', parent(`row-${index}`, 'model', Date.now() - 1000));
    }
    let deleted = false;
    await audit.command('maintenance', retention(50), {
      onYield: async () => {
        if (!deleted && (await list(audit, 'model')).total === 68) {
          deleted = true;
          for (let index = 90; index < 100; index += 1) {
            assert.equal(await audit.command('delete', { id: `row-${index}` }), 1);
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
