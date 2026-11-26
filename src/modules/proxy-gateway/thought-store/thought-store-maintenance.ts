import type Database from 'better-sqlite3';
import { and, asc, count, eq, inArray, lt, notExists, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { sqliteFilesBytes } from '@/shared/persistence/database/sqlite-write-budget';
import {
  thinkingRecords,
  thinkingSessions,
  type ThoughtStoreDatabase,
} from './thought-store.schema';

const CountSchema = z.object({ count: z.number().int().nonnegative() });
const SessionsSchema = z.array(z.object({ sessionKey: z.string() }));
const RowsSchema = z.array(
  z.object({ id: z.number().int().positive(), bytes: z.number().int().nonnegative() }),
);
const recordBytes = sql<number>`coalesce(length(${thinkingRecords.thought}), 0)
  + length(cast(${thinkingRecords.visible} as blob))
  + length(cast(${thinkingRecords.partSignatures} as blob))
  + length(cast(coalesce(${thinkingRecords.signature}, '') as blob))
  + length(cast(${thinkingRecords.toolIds} as blob))
  + length(cast(${thinkingRecords.toolNames} as blob)) + 512`;
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
    private readonly orm: ThoughtStoreDatabase,
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
      this.orm.select({ count: count() }).from(thinkingSessions).get(),
    ).count;
    const countPressure = sessions > input.maxSessions;
    const diskPressure = pressure && reclaimed > target && !diskPaused;
    const protectedKeys = input.protectedSessionKeys ?? [];
    const exclusion = protectedKeys.length
      ? notInArray(thinkingSessions.sessionKey, protectedKeys)
      : undefined;
    const idleBefore = now - IDLE_GRACE_MS;
    const eligibleBefore = countPressure || diskPressure ? Math.max(cutoff, idleBefore) : cutoff;
    const candidates = SessionsSchema.parse(
      this.orm
        .select({ sessionKey: thinkingSessions.sessionKey })
        .from(thinkingSessions)
        .where(and(lt(thinkingSessions.lastAccessed, eligibleBefore), exclusion))
        .orderBy(asc(thinkingSessions.lastAccessed), asc(thinkingSessions.sessionKey))
        .limit(64)
        .all(),
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
        this.orm
          .select({ sessionKey: thinkingSessions.sessionKey })
          .from(thinkingSessions)
          .where(
            and(
              eq(thinkingSessions.sessionKey, candidate.sessionKey),
              lt(thinkingSessions.lastAccessed, cutoff),
            ),
          )
          .get(),
      );
      if (!ageExpired && sessions - removedSessions <= input.maxSessions && !diskPressure) {
        break;
      }
      const rows = RowsSchema.parse(
        this.orm
          .select({ id: thinkingRecords.id, bytes: recordBytes })
          .from(thinkingRecords)
          .where(eq(thinkingRecords.sessionKey, candidate.sessionKey))
          .orderBy(asc(thinkingRecords.id))
          .limit(MAX_RECORDS - removedRecords)
          .all(),
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
      this.orm.transaction((tx) => {
        const sessionRecords = eq(thinkingRecords.sessionKey, candidate.sessionKey);
        if (ids.length > 0) {
          removedRecords += tx
            .delete(thinkingRecords)
            .where(and(inArray(thinkingRecords.id, ids), sessionRecords))
            .run().changes;
        }
        removedSessions += tx
          .delete(thinkingSessions)
          .where(
            and(
              eq(thinkingSessions.sessionKey, candidate.sessionKey),
              notExists(
                tx.select({ id: thinkingRecords.id }).from(thinkingRecords).where(sessionRecords),
              ),
            ),
          )
          .run().changes;
      });
      invalidatedSessions.push(candidate.sessionKey);
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
      this.orm.select({ count: count() }).from(thinkingSessions).get(),
    ).count;
    const hasEligibleSession = (before: number) =>
      Boolean(
        this.orm
          .select({ sessionKey: thinkingSessions.sessionKey })
          .from(thinkingSessions)
          .where(and(lt(thinkingSessions.lastAccessed, before), exclusion))
          .limit(1)
          .get(),
      );
    const agePending = hasEligibleSession(cutoff);
    const idlePending = hasEligibleSession(idleBefore);
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
      if (this.raw.pragma('wal_checkpoint(TRUNCATE)', { simple: true }) !== 0) {
        return false;
      }
      if (Number(this.raw.pragma('auto_vacuum', { simple: true })) === 2) {
        this.raw.pragma('incremental_vacuum(128)');
      }
      return this.raw.pragma('wal_checkpoint(TRUNCATE)', { simple: true }) === 0;
    } finally {
      this.raw.pragma(`busy_timeout = ${timeout}`);
    }
  }
}
