import fs from 'node:fs';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { auditPayloadChunks, auditPayloads, trafficAuditSchema } from './traffic-audit.schema';
import type { TrafficClass } from './traffic-classifier';
import type { TrafficAuditWorkerCommand } from './traffic-audit.worker-protocol';

type TrafficAuditDatabase = BetterSQLite3Database<typeof trafficAuditSchema>;
type RetentionConfig = Extract<TrafficAuditWorkerCommand, { operation: 'maintenance' }>['payload'];
const TRAFFIC_CLASSES: readonly TrafficClass[] = ['system', 'ipc', 'auxiliary', 'model'];
const DELETE_BATCH_SIZE = 32;
const VACUUM_PAGE_BATCH = 128;

export class TrafficAuditRetention {
  public constructor(
    private readonly databasePath: string,
    private readonly raw: Database.Database,
    private readonly orm: TrafficAuditDatabase,
  ) {}

  public *maintenance(config: RetentionConfig): Generator<void, { databaseBytes: number }> {
    const now = Date.now();
    const bodyCutoff = now - config.bodyRetentionHours * 60 * 60 * 1000;
    const summaryCutoff = now - config.summaryRetentionDays * 24 * 60 * 60 * 1000;
    // High-water row IDs bound the pass. Creation-time cutoffs also protect new
    // writes if a concurrent clear/delete lets SQLite reuse an earlier row ID.
    const maxRequestRowId = this.maxRowId('request_logs');
    const maxPayloadRowId = this.maxRowId('audit_payloads');
    const maxAdminRowId = this.maxRowId('audit_admin_events');
    yield;
    const selectExpired = this.raw.prepare<
      [number, number],
      { rowId: number; id: string; createdAt: number; state: string }
    >(
      'SELECT rowid rowId,id,created_at createdAt,state FROM audit_payloads ' +
        'WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 32',
    );
    let payloadRowId = 0;
    while (payloadRowId < maxPayloadRowId) {
      const rows = selectExpired.all(payloadRowId, maxPayloadRowId);
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        payloadRowId = row.rowId;
        if (row.createdAt < bodyCutoff && row.state !== 'expired') {
          this.expirePayload(row.id, 'retention');
          yield;
        }
      }
      yield;
    }
    for (const [table, maxRowId] of [
      ['request_logs', maxRequestRowId],
      ['audit_admin_events', maxAdminRowId],
    ] as const) {
      const removeExpired = this.raw.prepare(
        `DELETE FROM ${table} WHERE rowid IN (` +
          `SELECT rowid FROM ${table} WHERE timestamp<? AND rowid<=? ORDER BY timestamp LIMIT ?)`,
      );
      while (removeExpired.run(summaryCutoff, maxRowId, DELETE_BATCH_SIZE).changes > 0) {
        yield;
      }
    }
    this.raw.prepare('DELETE FROM audit_drop_stats WHERE last_seen < ?').run(summaryCutoff);
    yield;
    yield* this.evictRowsBeyondLimit(config.maxRows, maxRequestRowId, maxAdminRowId, now);
    yield* this.reclaimDiskSpace();

    while (sqliteFilesBytes(this.databasePath) > config.maxDiskBytes) {
      const removedAdmin = this.raw
        .prepare(
          'DELETE FROM audit_admin_events WHERE id IN (' +
            'SELECT id FROM audit_admin_events WHERE rowid<=? AND timestamp<? ORDER BY timestamp ASC LIMIT ?)',
        )
        .run(maxAdminRowId, now, DELETE_BATCH_SIZE).changes;
      if (removedAdmin === 0) {
        break;
      }
      yield;
      yield* this.reclaimDiskSpace();
    }

    // Drive the join from live payloads in index order. Starting from requests would
    // rescan and sort the whole traffic class for every eviction batch.
    const selectBodies = this.raw.prepare<
      [TrafficClass, number, string, number, number],
      { id: string; createdAt: number; storedBytes: number }
    >(
      'SELECT p.id,p.created_at createdAt,p.stored_bytes storedBytes ' +
        'FROM audit_payloads p INDEXED BY idx_payload_disk_eviction ' +
        'CROSS JOIN request_logs r ON r.id=p.request_id ' +
        'WHERE p.stored_bytes>0 AND r.traffic_class=? AND (p.created_at,p.id)>(?,?) ' +
        'AND p.rowid<=? AND p.created_at<? ' +
        'ORDER BY p.created_at ASC,p.id ASC LIMIT 32',
    );
    let databaseBytes = sqliteFilesBytes(this.databasePath);
    for (const trafficClass of TRAFFIC_CLASSES) {
      let cursorCreatedAt = Number.MIN_SAFE_INTEGER;
      let cursorId = '';
      while (databaseBytes > config.maxDiskBytes) {
        const bodies = selectBodies.all(
          trafficClass,
          cursorCreatedAt,
          cursorId,
          maxPayloadRowId,
          now,
        );
        if (bodies.length === 0) {
          break;
        }
        const excessBytes = databaseBytes - config.maxDiskBytes;
        let expiredBytes = 0;
        const startedAt = performance.now();
        this.raw.transaction(() => {
          for (const row of bodies) {
            // Chunk/index pages may free more than storedBytes. Reclaim accumulated
            // deletions before a further body would consume the remaining byte target.
            if (expiredBytes > 0 && row.storedBytes >= excessBytes - expiredBytes) {
              break;
            }
            this.expirePayload(row.id, 'disk_pressure');
            cursorCreatedAt = row.createdAt;
            cursorId = row.id;
            expiredBytes += row.storedBytes;
            // One large body may satisfy the budget; do not discard the rest of its page.
            if (expiredBytes >= excessBytes) {
              break;
            }
            if (performance.now() - startedAt >= 20) {
              break;
            }
          }
        })();
        yield;
        yield* this.reclaimDiskSpace();
        databaseBytes = sqliteFilesBytes(this.databasePath);
      }
    }

    const removeLogs = this.raw.prepare(
      'DELETE FROM request_logs WHERE id IN (' +
        'SELECT id FROM request_logs WHERE traffic_class=? AND rowid<=? AND timestamp<? ORDER BY timestamp ASC LIMIT ?)',
    );
    for (const trafficClass of TRAFFIC_CLASSES) {
      while (sqliteFilesBytes(this.databasePath) > config.maxDiskBytes) {
        const changes = removeLogs.run(
          trafficClass,
          maxRequestRowId,
          now,
          DELETE_BATCH_SIZE,
        ).changes;
        if (changes === 0) {
          break;
        }
        yield;
        yield* this.reclaimDiskSpace();
      }
    }
    return { databaseBytes: sqliteFilesBytes(this.databasePath) };
  }

  public reclaimDiskSpaceDirect(): void {
    this.raw.pragma('wal_checkpoint(TRUNCATE)');
    this.raw.pragma('incremental_vacuum');
    this.raw.pragma('wal_checkpoint(TRUNCATE)');
  }

  private *reclaimDiskSpace(): Generator<void> {
    // Reclaim before remeasuring: a delete only adds pages to SQLite's freelist.
    this.raw.pragma('wal_checkpoint(TRUNCATE)');
    yield;
    let remainingPages = Number(this.raw.pragma('freelist_count', { simple: true }));
    while (remainingPages > 0) {
      const before = Number(this.raw.pragma('freelist_count', { simple: true }));
      if (before === 0) {
        break;
      }
      this.raw.pragma(`incremental_vacuum(${Math.min(remainingPages, VACUUM_PAGE_BATCH)})`);
      this.raw.pragma('wal_checkpoint(TRUNCATE)');
      const after = Number(this.raw.pragma('freelist_count', { simple: true }));
      remainingPages -= Math.max(1, before - after);
      yield;
    }
  }

  private maxRowId(table: 'request_logs' | 'audit_payloads' | 'audit_admin_events'): number {
    return (
      this.raw
        .prepare<[], { value: number }>(`SELECT COALESCE(MAX(rowid),0) value FROM ${table}`)
        .get()?.value ?? 0
    );
  }

  private *evictRowsBeyondLimit(
    maxRows: number,
    maxRequestRowId: number,
    maxAdminRowId: number,
    startedAt: number,
  ): Generator<void> {
    const countRows = this.raw.prepare<[number, number, number, number], { value: number }>(
      'SELECT (SELECT COUNT(*) FROM request_logs WHERE rowid<=? AND timestamp<?) + ' +
        '(SELECT COUNT(*) FROM audit_admin_events WHERE rowid<=? AND timestamp<?) value',
    );
    const countRemaining = () =>
      Math.max(
        0,
        (countRows.get(maxRequestRowId, startedAt, maxAdminRowId, startedAt)?.value ?? 0) - maxRows,
      );
    const totalChanges = this.raw.prepare<[], { value: number }>('SELECT total_changes() value');
    const changeCount = () => totalChanges.get()?.value ?? 0;
    // Reads do not change this connection's counter. Recount only when interleaved
    // writes could have removed rows, rather than scanning the tables every batch.
    const remainingAfterYield = (previous: number, ownChanges: number) =>
      changeCount() === ownChanges ? previous : countRemaining();
    let remaining = countRemaining();
    const removeAdmin = this.raw.prepare(
      'DELETE FROM audit_admin_events WHERE id IN (' +
        'SELECT id FROM audit_admin_events WHERE rowid<=? AND timestamp<? ORDER BY timestamp ASC LIMIT ?)',
    );
    while (remaining > 0) {
      const changes = removeAdmin.run(
        maxAdminRowId,
        startedAt,
        Math.min(remaining, DELETE_BATCH_SIZE),
      ).changes;
      if (changes === 0) {
        break;
      }
      remaining -= changes;
      const ownChanges = changeCount();
      yield;
      remaining = remainingAfterYield(remaining, ownChanges);
    }
    const remove = this.raw.prepare(
      'DELETE FROM request_logs WHERE id IN (' +
        'SELECT id FROM request_logs WHERE traffic_class=? AND rowid<=? AND timestamp<? ORDER BY timestamp ASC LIMIT ?)',
    );
    for (const trafficClass of TRAFFIC_CLASSES) {
      while (remaining > 0) {
        const changes = remove.run(
          trafficClass,
          maxRequestRowId,
          startedAt,
          Math.min(remaining, DELETE_BATCH_SIZE),
        ).changes;
        if (changes === 0) {
          break;
        }
        remaining -= changes;
        const ownChanges = changeCount();
        yield;
        remaining = remainingAfterYield(remaining, ownChanges);
      }
    }
  }

  private expirePayload(id: string, reason: string): void {
    this.raw.transaction(() => {
      this.orm.delete(auditPayloadChunks).where(eq(auditPayloadChunks.payloadId, id)).run();
      this.orm
        .update(auditPayloads)
        .set({
          chunkCount: 0,
          droppedReason: reason,
          partial: true,
          state: 'expired',
          storedBytes: 0,
        })
        .where(eq(auditPayloads.id, id))
        .run();
    })();
  }

  public stats() {
    const row = this.raw
      .prepare<
        [],
        { oldestTimestamp: number | null; rows: number }
      >('SELECT COUNT(*) rows,MIN(timestamp) oldestTimestamp FROM (' + 'SELECT timestamp FROM request_logs UNION ALL SELECT timestamp FROM audit_admin_events)')
      .get() ?? { oldestTimestamp: null, rows: 0 };
    const bodies = this.raw
      .prepare<
        [],
        { bodyStoredBytes: number; incompleteBodies: number | null }
      >('SELECT COALESCE(SUM(stored_bytes),0) bodyStoredBytes,' + "SUM(CASE WHEN state='incomplete' THEN 1 ELSE 0 END) incompleteBodies FROM audit_payloads")
      .get() ?? { bodyStoredBytes: 0, incompleteBodies: 0 };
    const drops = this.raw
      .prepare<
        [],
        { droppedCount: number }
      >('SELECT COALESCE(SUM(count),0) droppedCount FROM audit_drop_stats')
      .get() ?? { droppedCount: 0 };
    const last = this.raw
      .prepare<
        [],
        { reason: string }
      >('SELECT reason FROM audit_drop_stats ORDER BY last_seen DESC LIMIT 1')
      .get();
    return {
      bodyStoredBytes: bodies.bodyStoredBytes,
      databaseBytes: sqliteFilesBytes(this.databasePath),
      droppedCount: drops.droppedCount,
      incompleteBodies: bodies.incompleteBodies ?? 0,
      lastDropReason: last?.reason ?? null,
      oldestTimestamp: row.oldestTimestamp,
      rows: row.rows,
    };
  }
}

function sqliteFilesBytes(databasePath: string): number {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += fs.statSync(`${databasePath}${suffix}`).size;
    } catch {
      // Missing WAL/SHM sidecars are expected when the database is idle.
    }
  }
  return total;
}
