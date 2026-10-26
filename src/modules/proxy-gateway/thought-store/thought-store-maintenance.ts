import type Database from 'better-sqlite3';
import { z } from 'zod';
import { sqliteFilesBytes } from '@/shared/persistence/database/sqlite-write-budget';

const CountSchema = z.object({ count: z.number().int().nonnegative() });
const SessionsSchema = z.array(z.object({ session_key: z.string() }));
const RowsSchema = z.array(
  z.object({ id: z.number().int().positive(), bytes: z.number().int().nonnegative() }),
);
const IDLE_GRACE_MS = 5 * 60 * 1000;
const MAX_RECORDS = 128;
const MAX_DELETE_BYTES = 8 * 1024 * 1024;

export interface ThoughtMaintenanceInput {
  protectedSessionKeys?: string[];
  retentionDays: number;
  maxSessions: number;
  maxDiskBytes?: number;
}

/** Delete within one bounded pass; never cascade a whole unbounded history window. */
export class ThoughtStoreMaintenance {
  private pressurePauseBytes: number | null = null;
  private pressureLimit: number | null = null;
  constructor(
    private readonly raw: Database.Database,
    private readonly databasePath: string,
  ) {}

  run(input: ThoughtMaintenanceInput) {
    const started = performance.now();
    const now = Date.now();
    const cutoff = now - input.retentionDays * 24 * 60 * 60 * 1000;
    const diskLimit = input.maxDiskBytes ?? 1024 * 1024 * 1024;
    const before = sqliteFilesBytes(this.databasePath);
    if (this.pressureLimit !== diskLimit) {
      this.pressureLimit = null;
    }
    if (before > diskLimit) {
      this.pressureLimit = diskLimit;
    }
    const pressure = this.pressureLimit === diskLimit;
    if (!this.reclaim()) {
      return {
        removedSessions: 0,
        removedRecords: 0,
        invalidatedSessions: [],
        moreWorkPending: false,
        blockedReason: 'checkpoint_busy' as const,
      };
    }
    const reclaimed = sqliteFilesBytes(this.databasePath);
    const target = Math.floor(diskLimit * 0.7);
    if (reclaimed <= target) {
      this.pressureLimit = null;
    }
    if (!pressure || (this.pressurePauseBytes !== null && reclaimed < this.pressurePauseBytes)) {
      this.pressurePauseBytes = null;
    }
    const diskPaused = pressure && this.pressurePauseBytes !== null;
    const freePages = Number(this.raw.pragma('freelist_count', { simple: true }));
    if (pressure && reclaimed > target && freePages > 0 && !diskPaused) {
      const progress = reclaimed < before;
      if (!progress) {
        this.pressurePauseBytes = reclaimed;
      }
      return {
        removedSessions: 0,
        removedRecords: 0,
        invalidatedSessions: [],
        moreWorkPending: progress,
        ...(progress ? {} : { blockedReason: 'no_progress' as const }),
      };
    }
    const sessions = CountSchema.parse(
      this.raw.prepare('SELECT count(*) AS count FROM thinking_sessions').get(),
    ).count;
    const countPressure = sessions > input.maxSessions;
    const diskPressure = pressure && reclaimed > target && !diskPaused;
    const protectedKeys = input.protectedSessionKeys ?? [];
    const exclusion = protectedKeys.length
      ? ` AND session_key NOT IN (${protectedKeys.map(() => '?').join(',')})`
      : '';
    const candidates = SessionsSchema.parse(
      this.raw
        .prepare(
          `SELECT session_key FROM thinking_sessions WHERE (last_accessed < ? OR (? AND last_accessed < ?))${exclusion} ORDER BY last_accessed,session_key LIMIT 64`,
        )
        .all(cutoff, countPressure || diskPressure ? 1 : 0, now - IDLE_GRACE_MS, ...protectedKeys),
    );
    let removedSessions = 0;
    let removedRecords = 0;
    let deletedBytes = 0;
    const invalidatedSessions: string[] = [];
    for (const candidate of candidates) {
      if (performance.now() - started >= 25 || removedRecords >= MAX_RECORDS) {
        break;
      }
      const ageExpired = Boolean(
        this.raw
          .prepare('SELECT 1 FROM thinking_sessions WHERE session_key=? AND last_accessed < ?')
          .get(candidate.session_key, cutoff),
      );
      if (!ageExpired && sessions - removedSessions <= input.maxSessions && !diskPressure) {
        break;
      }
      const rows = RowsSchema.parse(
        this.raw
          .prepare(
            "SELECT id, coalesce(length(thought),0)+length(cast(visible as blob))+length(cast(part_signatures as blob))+length(cast(coalesce(signature,'') as blob))+length(cast(tool_ids as blob))+length(cast(tool_names as blob))+512 AS bytes FROM thinking_records WHERE session_key=? ORDER BY id LIMIT ?",
          )
          .all(candidate.session_key, MAX_RECORDS - removedRecords),
      );
      const ids: number[] = [];
      for (const row of rows) {
        // One oversized old record can progress, bounded by the existing record ceiling.
        if ((removedRecords > 0 || ids.length > 0) && deletedBytes + row.bytes > MAX_DELETE_BYTES) {
          break;
        }
        if (row.bytes > 100 * 1024 * 1024) {
          return {
            removedSessions,
            removedRecords,
            invalidatedSessions,
            moreWorkPending: false,
            blockedReason: 'oversized_record' as const,
          };
        }
        ids.push(row.id);
        deletedBytes += row.bytes;
        if (deletedBytes >= MAX_DELETE_BYTES) {
          break;
        }
      }
      if (ids.length === 0 && rows.length > 0) {
        break;
      }
      this.raw.transaction(() => {
        const remove = this.raw.prepare(
          'DELETE FROM thinking_records WHERE id=? AND session_key=?',
        );
        for (const id of ids) {
          removedRecords += remove.run(id, candidate.session_key).changes;
        }
        removedSessions += this.raw
          .prepare(
            'DELETE FROM thinking_sessions WHERE session_key=? AND NOT EXISTS(SELECT 1 FROM thinking_records WHERE session_key=?)',
          )
          .run(candidate.session_key, candidate.session_key).changes;
      })();
      invalidatedSessions.push(candidate.session_key);
      if (deletedBytes >= MAX_DELETE_BYTES) {
        break;
      }
    }
    const freePagesPending = !this.reclaim();
    const after = sqliteFilesBytes(this.databasePath);
    const noProgress =
      diskPaused ||
      (diskPressure && (removedRecords > 0 || removedSessions > 0) && after >= reclaimed);
    if (noProgress) {
      this.pressurePauseBytes ??= after;
    }
    const remaining = CountSchema.parse(
      this.raw.prepare('SELECT count(*) AS count FROM thinking_sessions').get(),
    ).count;
    const agePending = Boolean(
      this.raw
        .prepare(`SELECT 1 FROM thinking_sessions WHERE last_accessed < ?${exclusion} LIMIT 1`)
        .get(cutoff, ...protectedKeys),
    );
    const idlePending = Boolean(
      this.raw
        .prepare(`SELECT 1 FROM thinking_sessions WHERE last_accessed < ?${exclusion} LIMIT 1`)
        .get(now - IDLE_GRACE_MS, ...protectedKeys),
    );
    return {
      removedSessions,
      removedRecords,
      invalidatedSessions,
      moreWorkPending:
        !freePagesPending &&
        !noProgress &&
        (agePending ||
          (idlePending && (remaining > input.maxSessions || (diskPressure && after > target)))),
      ...(freePagesPending
        ? { blockedReason: 'checkpoint_busy' as const }
        : noProgress
          ? { blockedReason: 'no_progress' as const }
          : {}),
    };
  }

  private reclaim(): boolean {
    const timeout = Number(this.raw.pragma('busy_timeout', { simple: true }));
    try {
      this.raw.pragma('busy_timeout = 0');
      if (
        this.raw.prepare<[], { busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy !== 0
      ) {
        return false;
      }
      if (Number(this.raw.pragma('auto_vacuum', { simple: true })) === 2) {
        this.raw.pragma('incremental_vacuum(128)');
      }
      return (
        this.raw.prepare<[], { busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy === 0
      );
    } finally {
      this.raw.pragma(`busy_timeout = ${timeout}`);
    }
  }
}
