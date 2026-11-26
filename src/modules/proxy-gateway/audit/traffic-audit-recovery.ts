import type Database from 'better-sqlite3';
import { and, count, eq, isNull, lt, sql, sum } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  auditPayloadChunks,
  auditPayloads,
  requestLogs,
  upstreamAttempts,
} from './traffic-audit.schema';

/** Reconcile capture lifetime, without claiming the provider completed or failed. */
export function recoverInterruptedAudit(database: Database.Database, ownerStartedAt: number): void {
  const orm = drizzle(database);
  orm.transaction((tx) => {
    const recoveredAt = Date.now();
    for (const table of [requestLogs, upstreamAttempts]) {
      tx.update(table)
        .set({ completedAt: recoveredAt, responsePartial: true })
        .where(
          and(
            eq(table.outcome, 'in_progress'),
            isNull(table.completedAt),
            lt(table.timestamp, ownerStartedAt),
          ),
        )
        .run();
    }
    const matchesPayload = eq(auditPayloadChunks.payloadId, auditPayloads.id);
    const storedBytes = tx
      .select({ value: sum(auditPayloadChunks.byteLength) })
      .from(auditPayloadChunks)
      .where(matchesPayload);
    const chunkCount = tx.select({ value: count() }).from(auditPayloadChunks).where(matchesPayload);
    tx.update(auditPayloads)
      .set({
        state: 'incomplete',
        partial: true,
        droppedReason: sql`coalesce(${auditPayloads.droppedReason}, ${'worker_restart'})`,
        storedBytes: sql`coalesce(${storedBytes}, 0)`,
        chunkCount: sql`${chunkCount}`,
        completedAt: recoveredAt,
      })
      .where(and(eq(auditPayloads.state, 'writing'), lt(auditPayloads.createdAt, ownerStartedAt)))
      .run();
  });
}

export function auditCaptureOutcome(outcome: string, completedAt: number | null): string {
  return outcome === 'in_progress' && completedAt !== null ? 'capture_interrupted' : outcome;
}
