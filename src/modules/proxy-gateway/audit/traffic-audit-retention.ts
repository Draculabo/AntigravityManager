import fs from 'node:fs';
import Database from 'better-sqlite3';
import { and, eq, lt, ne } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  auditAdminEvents,
  auditPayloadChunks,
  auditPayloads,
  requestLogs,
  trafficAuditSchema,
} from './traffic-audit.schema';
import type { TrafficAuditWorkerCommand } from './traffic-audit.worker-protocol';

type TrafficAuditDatabase = BetterSQLite3Database<typeof trafficAuditSchema>;
type RetentionConfig = Extract<TrafficAuditWorkerCommand, { operation: 'maintenance' }>['payload'];

export class TrafficAuditRetention {
  public constructor(
    private readonly databasePath: string,
    private readonly raw: Database.Database,
    private readonly orm: TrafficAuditDatabase,
  ) {}

  public maintenance(config: RetentionConfig) {
    const now = Date.now();
    const bodyCutoff = now - config.bodyRetentionHours * 60 * 60 * 1000;
    const summaryCutoff = now - config.summaryRetentionDays * 24 * 60 * 60 * 1000;
    const expired = this.orm
      .select({ id: auditPayloads.id })
      .from(auditPayloads)
      .where(and(lt(auditPayloads.createdAt, bodyCutoff), ne(auditPayloads.state, 'expired')))
      .orderBy(auditPayloads.createdAt)
      .all();
    for (const row of expired) {
      this.expirePayload(row.id, 'retention');
    }
    this.orm.delete(requestLogs).where(lt(requestLogs.timestamp, summaryCutoff)).run();
    this.orm.delete(auditAdminEvents).where(lt(auditAdminEvents.timestamp, summaryCutoff)).run();
    this.evictRowsBeyondLimit(config.maxRows);
    this.reclaimDiskSpace();

    while (sqliteFilesBytes(this.databasePath) > config.maxDiskBytes) {
      const removedAdmin = this.raw
        .prepare(
          'DELETE FROM audit_admin_events WHERE id IN (' +
            'SELECT id FROM audit_admin_events ORDER BY timestamp ASC LIMIT 1)',
        )
        .run().changes;
      if (removedAdmin > 0) {
        this.reclaimDiskSpace();
        continue;
      }
      const bodies = this.raw
        .prepare<
          [],
          { id: string }
        >('SELECT p.id FROM audit_payloads p JOIN request_logs r ON r.id=p.request_id ' + "WHERE p.stored_bytes>0 ORDER BY CASE r.traffic_class WHEN 'system' THEN 0 " + "WHEN 'ipc' THEN 1 WHEN 'auxiliary' THEN 2 ELSE 3 END,p.created_at ASC LIMIT 1")
        .all();
      if (bodies.length > 0) {
        for (const row of bodies) {
          this.expirePayload(row.id, 'disk_pressure');
        }
      } else {
        const rows = this.raw
          .prepare<
            [],
            { id: string }
          >("SELECT id FROM request_logs ORDER BY CASE traffic_class WHEN 'system' THEN 0 " + "WHEN 'ipc' THEN 1 WHEN 'auxiliary' THEN 2 ELSE 3 END,timestamp ASC LIMIT 1")
          .all();
        if (rows.length > 0) {
          this.raw.transaction((items: Array<{ id: string }>) => {
            const remove = this.raw.prepare('DELETE FROM request_logs WHERE id=?');
            for (const row of items) {
              remove.run(row.id);
            }
          })(rows);
        } else {
          break;
        }
      }
      this.reclaimDiskSpace();
    }
    return { databaseBytes: sqliteFilesBytes(this.databasePath) };
  }

  private reclaimDiskSpace(): void {
    // Reclaim before remeasuring: a delete only adds pages to SQLite's freelist.
    this.raw.pragma('wal_checkpoint(TRUNCATE)');
    this.raw.pragma('incremental_vacuum');
    this.raw.pragma('wal_checkpoint(TRUNCATE)');
  }

  private evictRowsBeyondLimit(maxRows: number): void {
    const total =
      this.raw
        .prepare<
          [],
          { value: number }
        >('SELECT (SELECT COUNT(*) FROM request_logs) + (SELECT COUNT(*) FROM audit_admin_events) value')
        .get()?.value ?? 0;
    let remaining = Math.max(0, total - maxRows);
    const removedAdmin = this.raw
      .prepare(
        'DELETE FROM audit_admin_events WHERE id IN (' +
          'SELECT id FROM audit_admin_events ORDER BY timestamp ASC LIMIT ?)',
      )
      .run(remaining).changes;
    remaining -= removedAdmin;
    const remove = this.raw.prepare(
      'DELETE FROM request_logs WHERE id IN (' +
        'SELECT id FROM request_logs WHERE traffic_class=? ORDER BY timestamp ASC LIMIT ?)',
    );
    for (const trafficClass of ['system', 'ipc', 'auxiliary', 'model']) {
      if (remaining <= 0) {
        break;
      }
      const changes = remove.run(trafficClass, remaining).changes;
      remaining -= changes;
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
