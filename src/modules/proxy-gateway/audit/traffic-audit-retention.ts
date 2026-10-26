import Database from 'better-sqlite3';

import { auditSqliteFilesBytes as sqliteFilesBytes } from './traffic-audit-disk-budget';
import { auditArchiveUsage } from './traffic-audit-archives';
import type {
  TrafficAuditMaintenanceResult,
  TrafficAuditWorkerCommand,
} from './traffic-audit.worker-protocol';

type RetentionConfig = Extract<TrafficAuditWorkerCommand, { operation: 'maintenance' }>['payload'];
const DELETE_BATCH_SIZE = 32;
const VACUUM_PAGE_BATCH = 128;
const ADMIN_EVENT_LIMIT = 1_000;
const DROP_BUCKET_LIMIT = 128;
const COMPLETED_REQUEST =
  'r.completed_at<? ' +
  "AND NOT EXISTS (SELECT 1 FROM upstream_attempts a WHERE a.parent_id=r.id AND a.outcome='in_progress' AND a.completed_at IS NULL) " +
  "AND NOT EXISTS (SELECT 1 FROM audit_payloads p WHERE p.request_id=r.id AND p.state='writing')";

type ReclaimStatus = 'ready' | 'busy' | 'vacuum_pending';

export class TrafficAuditRetention {
  public constructor(
    private readonly databasePath: string,
    private readonly raw: Database.Database,
  ) {}

  public *maintenance(config: RetentionConfig): Generator<void, TrafficAuditMaintenanceResult> {
    const startedAt = Date.now();
    // Both guards are needed: a concurrent clear can reuse row IDs while this pass yields.
    const highWater =
      this.raw
        .prepare<[], { value: number }>('SELECT COALESCE(MAX(rowid),0) value FROM request_logs')
        .get()?.value ?? 0;
    const adminHighWater =
      this.raw
        .prepare<[], { value: number }>('SELECT COALESCE(MAX(id),0) value FROM audit_admin_events')
        .get()?.value ?? 0;
    const diskPressure = sqliteFilesBytes(this.databasePath) > config.maxDiskBytes;
    yield;
    yield* this.boundAuxiliaryRecords(startedAt, adminHighWater);
    yield* this.evictRowsBeyondLimit(config.maxRows, highWater, startedAt);
    let reclaimStatus = yield* this.reclaimDiskSpace();
    const target = Math.floor(config.maxDiskBytes * 0.7);
    let databaseBytes = sqliteFilesBytes(this.databasePath);
    // Reclaim existing free pages first. Once pressure starts, retain headroom for new captures.
    while (diskPressure && reclaimStatus === 'ready' && databaseBytes > target) {
      if (this.removeOldest(1, highWater, startedAt) === 0) {
        break;
      }
      const before = databaseBytes;
      yield;
      reclaimStatus = yield* this.reclaimDiskSpace();
      databaseBytes = sqliteFilesBytes(this.databasePath);
      // Never discard more history merely to gamble that another delete will shrink SQLite.
      if (databaseBytes >= before) {
        break;
      }
    }
    if (databaseBytes > config.maxDiskBytes) {
      console.warn('Traffic audit disk pressure remains; deferring further eviction', {
        databaseBytes,
        maxDiskBytes: config.maxDiskBytes,
        checkpointBusy: reclaimStatus === 'busy',
        vacuumPending: reclaimStatus === 'vacuum_pending',
      });
    }
    return { databaseBytes, moreWorkPending: reclaimStatus === 'vacuum_pending' };
  }

  private removeOldest(limit: number, highWater: number, startedAt: number): number {
    const rows = this.raw
      .prepare<
        [number, number, number, number],
        { id: string }
      >('SELECT r.id FROM request_logs r WHERE r.rowid<=? AND r.timestamp<? AND ' + COMPLETED_REQUEST + ' ORDER BY r.timestamp ASC,r.rowid ASC LIMIT ?')
      .all(highWater, startedAt, startedAt, limit);
    const remove = this.raw.prepare('DELETE FROM request_logs WHERE id=?');
    return this.raw.transaction(() => {
      const began = performance.now();
      let changes = 0;
      for (const row of rows) {
        // FK cascades remove the entire parent, including deduplicated payload references.
        changes += remove.run(row.id).changes;
        if (performance.now() - began >= 20) {
          break;
        }
      }
      return changes;
    })();
  }

  private *evictRowsBeyondLimit(
    maxRows: number,
    highWater: number,
    startedAt: number,
  ): Generator<void> {
    const count = this.raw.prepare<[], { value: number }>(
      'SELECT COUNT(*) value FROM request_logs',
    );
    const totalChanges = this.raw.prepare<[], { value: number }>('SELECT total_changes() value');
    const changeCount = () => totalChanges.get()?.value ?? 0;
    let remaining = Math.max(0, (count.get()?.value ?? 0) - maxRows);
    while (remaining > 0) {
      const changes = this.removeOldest(
        Math.min(remaining, DELETE_BATCH_SIZE),
        highWater,
        startedAt,
      );
      if (changes === 0) {
        break;
      }
      remaining -= changes;
      const ownChanges = changeCount();
      yield;
      // Concurrent user deletes must reduce the target; reads need no recount.
      if (changeCount() !== ownChanges) {
        remaining = Math.max(0, (count.get()?.value ?? 0) - maxRows);
      }
    }
  }

  private *boundAuxiliaryRecords(startedAt: number, adminHighWater: number): Generator<void> {
    for (const [table, limit] of [
      ['audit_admin_events', ADMIN_EVENT_LIMIT],
      ['audit_drop_stats', DROP_BUCKET_LIMIT],
    ] as const) {
      const count = this.raw.prepare<[], { value: number }>(`SELECT COUNT(*) value FROM ${table}`);
      const remove = this.raw.prepare(
        table === 'audit_admin_events'
          ? 'DELETE FROM audit_admin_events WHERE id IN (SELECT id FROM audit_admin_events ' +
              'WHERE timestamp<? AND id<=? ORDER BY timestamp,id LIMIT ?)'
          : 'DELETE FROM audit_drop_stats WHERE (traffic_class,reason) IN (' +
              'SELECT traffic_class,reason FROM audit_drop_stats WHERE last_seen<? ' +
              'ORDER BY last_seen,traffic_class,reason LIMIT ?)',
      );
      let excess = (count.get()?.value ?? 0) - limit;
      while (excess > 0) {
        const batch = Math.min(excess, DELETE_BATCH_SIZE);
        const changes =
          table === 'audit_admin_events'
            ? remove.run(startedAt, adminHighWater, batch).changes
            : remove.run(startedAt, batch).changes;
        if (changes === 0) {
          break;
        }
        excess -= changes;
        yield;
        excess = Math.min(excess, (count.get()?.value ?? 0) - limit);
      }
    }
  }

  public reclaimDiskSpaceDirect(): void {
    // Explicit clear reports after reclaiming available pages, but never waits on a pinned reader.
    const reclaim = this.reclaimDiskSpace();
    while (!reclaim.next().done) {
      // The generator has a finite page snapshot and stops on busy/no-progress.
    }
  }

  private *reclaimDiskSpace(): Generator<void, ReclaimStatus> {
    // A pinned reader must not block the weighted worker queue for busy_timeout seconds.
    const checkpoint = () => {
      const timeout = Number(this.raw.pragma('busy_timeout', { simple: true }));
      this.raw.pragma('busy_timeout = 0');
      try {
        return (
          this.raw.prepare<[], { busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy ===
          0
        );
      } finally {
        this.raw.pragma(`busy_timeout = ${timeout}`);
      }
    };
    if (!checkpoint()) {
      return 'busy';
    }
    yield;
    let remainingPages = Number(this.raw.pragma('freelist_count', { simple: true }));
    while (remainingPages > 0) {
      const before = Number(this.raw.pragma('freelist_count', { simple: true }));
      if (before === 0) {
        break;
      }
      this.raw.pragma(`incremental_vacuum(${Math.min(remainingPages, VACUUM_PAGE_BATCH)})`);
      if (!checkpoint()) {
        return 'busy';
      }
      const after = Number(this.raw.pragma('freelist_count', { simple: true }));
      if (after >= before) {
        return 'vacuum_pending';
      }
      remainingPages -= before - after;
      yield;
    }
    return Number(this.raw.pragma('freelist_count', { simple: true })) > 0
      ? 'vacuum_pending'
      : 'ready';
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
      archives: auditArchiveUsage(this.databasePath),
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
