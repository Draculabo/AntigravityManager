import type Database from 'better-sqlite3';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  min,
  notExists,
  sql,
} from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sqliteSchema } from '@/shared/persistence/database/sqlite-metadata';

import { auditSqliteFilesBytes as sqliteFilesBytes } from './traffic-audit-disk-budget';
import { auditArchiveUsage } from './traffic-audit-archives';
import {
  auditAdminEvents,
  auditDropStats,
  auditPayloads,
  requestLogs,
  upstreamAttempts,
} from './traffic-audit.schema';
import type {
  TrafficAuditMaintenanceResult,
  TrafficAuditWorkerCommand,
} from './traffic-audit.worker-protocol';

type RetentionConfig = Extract<TrafficAuditWorkerCommand, { operation: 'maintenance' }>['payload'];
const DELETE_BATCH_SIZE = 32;
const VACUUM_PAGE_BATCH = 128;
const ADMIN_EVENT_LIMIT = 1_000;
const DROP_BUCKET_LIMIT = 128;
const IPC_ROW_LIMIT = 50_000;
const IPC_PRUNE_ROWS = 40_000;
const requestRowId = sql<number>`${requestLogs}.rowid`;

type ReclaimStatus = 'ready' | 'busy' | 'vacuum_pending';

export class TrafficAuditRetention {
  private ipcInsertsUntilCheck = 0;
  private readonly orm: BetterSQLite3Database;

  public constructor(
    private readonly databasePath: string,
    private readonly raw: Database.Database,
  ) {
    this.orm = drizzle(raw);
  }

  public shouldPruneAfterIpcInsert(): boolean {
    this.ipcInsertsUntilCheck -= 1;
    return this.ipcInsertsUntilCheck <= 0 && this.shouldPruneIpc();
  }

  public *pruneIpc(): Generator<void, boolean> {
    if (!this.shouldPruneIpc()) {
      return false;
    }
    const startedAt = Date.now();
    const highWater = this.requestHighWater();
    let remaining = IPC_PRUNE_ROWS;
    while (remaining > 0) {
      const removable = this.ipcRowCount() - (IPC_ROW_LIMIT - IPC_PRUNE_ROWS);
      const limit = Math.min(remaining, removable, DELETE_BATCH_SIZE);
      if (limit <= 0) {
        break;
      }
      const changes = this.removeOldest(limit, highWater, startedAt, 'ipc');
      if (changes === 0) {
        break;
      }
      remaining -= changes;
      yield;
    }
    const stillOverLimit = this.shouldPruneIpc();
    return remaining === 0 && stillOverLimit;
  }

  private ipcRowCount(): number {
    return (
      this.orm
        .select({ value: count() })
        .from(requestLogs)
        .where(eq(requestLogs.trafficClass, 'ipc'))
        .get()?.value ?? 0
    );
  }

  public shouldPruneIpc(): boolean {
    // Deletions between checks can only cause an early recount.
    this.ipcInsertsUntilCheck = IPC_ROW_LIMIT - this.ipcRowCount();
    return this.ipcInsertsUntilCheck <= 0;
  }

  private requestHighWater(): number {
    return (
      this.orm
        .select({ value: sql<number>`coalesce(max(${requestRowId}), 0)` })
        .from(requestLogs)
        .get()?.value ?? 0
    );
  }

  public *maintenance(config: RetentionConfig): Generator<void, TrafficAuditMaintenanceResult> {
    const startedAt = Date.now();
    // Both guards are needed: a concurrent clear can reuse row IDs while this pass yields.
    const highWater = this.requestHighWater();
    const adminHighWater =
      this.orm
        .select({ value: sql<number>`coalesce(max(${auditAdminEvents.id}), 0)` })
        .from(auditAdminEvents)
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

  private removeOldest(limit: number, highWater: number, startedAt: number, scope?: 'ipc'): number {
    const activeAttempts = this.orm
      .select({ id: upstreamAttempts.id })
      .from(upstreamAttempts)
      .where(
        and(
          eq(upstreamAttempts.parentId, requestLogs.id),
          eq(upstreamAttempts.outcome, 'in_progress'),
          isNull(upstreamAttempts.completedAt),
        ),
      );
    const writingPayloads = this.orm
      .select({ id: auditPayloads.id })
      .from(auditPayloads)
      .where(and(eq(auditPayloads.requestId, requestLogs.id), eq(auditPayloads.state, 'writing')));
    const rows = this.orm
      .select({ id: requestLogs.id })
      .from(requestLogs)
      .where(
        and(
          lte(requestRowId, highWater),
          lt(requestLogs.timestamp, startedAt),
          lt(requestLogs.completedAt, startedAt),
          notExists(activeAttempts),
          notExists(writingPayloads),
          scope === 'ipc' ? eq(requestLogs.trafficClass, 'ipc') : undefined,
        ),
      )
      .orderBy(asc(requestLogs.timestamp), asc(requestRowId))
      .limit(limit)
      .all();
    return this.orm.transaction((tx) => {
      const remove = tx
        .delete(requestLogs)
        .where(eq(requestLogs.id, sql.placeholder('id')))
        .prepare();
      const began = performance.now();
      let changes = 0;
      for (const row of rows) {
        // FK cascades remove the entire parent, including deduplicated payload references.
        changes += remove.run({ id: row.id }).changes;
        if (performance.now() - began >= 20) {
          break;
        }
      }
      return changes;
    });
  }

  private *evictRowsBeyondLimit(
    maxRows: number,
    highWater: number,
    startedAt: number,
  ): Generator<void> {
    const countRows = this.orm.select({ value: count() }).from(requestLogs).prepare();
    const totalChanges = this.orm
      .select({ value: sql<number>`total_changes()` })
      .from(sqliteSchema)
      .limit(1)
      .prepare();
    const changeCount = () => totalChanges.get()?.value ?? 0;
    let remaining = Math.max(0, (countRows.get()?.value ?? 0) - maxRows);
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
        remaining = Math.max(0, (countRows.get()?.value ?? 0) - maxRows);
      }
    }
  }

  private *boundAuxiliaryRecords(startedAt: number, adminHighWater: number): Generator<void> {
    const batchLimit = sql.placeholder('limit');
    const oldestEvents = this.orm
      .select({ id: auditAdminEvents.id })
      .from(auditAdminEvents)
      .where(
        and(lt(auditAdminEvents.timestamp, startedAt), lte(auditAdminEvents.id, adminHighWater)),
      )
      .orderBy(asc(auditAdminEvents.timestamp), asc(auditAdminEvents.id))
      .limit(batchLimit);
    const oldestDrops = this.orm
      .select({ trafficClass: auditDropStats.trafficClass, reason: auditDropStats.reason })
      .from(auditDropStats)
      .where(lt(auditDropStats.lastSeen, startedAt))
      .orderBy(
        asc(auditDropStats.lastSeen),
        asc(auditDropStats.trafficClass),
        asc(auditDropStats.reason),
      )
      .limit(batchLimit);
    for (const { countRows, remove, limit } of [
      {
        countRows: this.orm.select({ value: count() }).from(auditAdminEvents).prepare(),
        remove: this.orm
          .delete(auditAdminEvents)
          .where(inArray(auditAdminEvents.id, oldestEvents))
          .prepare(),
        limit: ADMIN_EVENT_LIMIT,
      },
      {
        countRows: this.orm.select({ value: count() }).from(auditDropStats).prepare(),
        remove: this.orm
          .delete(auditDropStats)
          .where(
            inArray(sql`(${auditDropStats.trafficClass}, ${auditDropStats.reason})`, oldestDrops),
          )
          .prepare(),
        limit: DROP_BUCKET_LIMIT,
      },
    ]) {
      let excess = (countRows.get()?.value ?? 0) - limit;
      while (excess > 0) {
        const changes = remove.run({ limit: Math.min(excess, DELETE_BATCH_SIZE) }).changes;
        if (changes === 0) {
          break;
        }
        excess -= changes;
        yield;
        excess = Math.min(excess, (countRows.get()?.value ?? 0) - limit);
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
        return this.raw.pragma('wal_checkpoint(TRUNCATE)', { simple: true }) === 0;
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
    const timestamps = this.orm
      .select({ timestamp: requestLogs.timestamp })
      .from(requestLogs)
      .unionAll(this.orm.select({ timestamp: auditAdminEvents.timestamp }).from(auditAdminEvents))
      .as('timestamps');
    const row = this.orm
      .select({ rows: count(), oldestTimestamp: min(timestamps.timestamp) })
      .from(timestamps)
      .get() ?? { oldestTimestamp: null, rows: 0 };
    const bodies = this.orm
      .select({
        bodyStoredBytes: sql<number>`coalesce(sum(${auditPayloads.storedBytes}), 0)`,
        incompleteBodies: count(sql`case when ${eq(auditPayloads.state, 'incomplete')} then 1 end`),
      })
      .from(auditPayloads)
      .get() ?? { bodyStoredBytes: 0, incompleteBodies: 0 };
    const drops = this.orm
      .select({ droppedCount: sql<number>`coalesce(sum(${auditDropStats.count}), 0)` })
      .from(auditDropStats)
      .get() ?? { droppedCount: 0 };
    const last = this.orm
      .select({ reason: auditDropStats.reason })
      .from(auditDropStats)
      .orderBy(desc(auditDropStats.lastSeen))
      .limit(1)
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
