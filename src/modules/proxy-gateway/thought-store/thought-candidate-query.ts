import { z } from 'zod';
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { thinkingRecords, thoughtStoreSchema } from './thought-store.schema';
import { ThoughtStoreReads } from './thought-store-reads';
import { assertThoughtReplyBudget, ThoughtReadBudgetError } from './thought-read-budget';
import { areThoughtRecordModelsCompatible } from './thought-store.model';

export const ThoughtCandidateInputSchema = z.object({
  sessionKey: z.string().min(1).max(512),
  model: z.string().min(1).max(256),
  anchors: z
    .array(z.string().regex(/^[a-f0-9]{64}$/u))
    .min(1)
    .max(64),
});
export type ThoughtCandidateInput = z.infer<typeof ThoughtCandidateInputSchema>;

/** Complete bounded candidate sets: overflow must never look like one unique owner. */
export function queryThoughtCandidates(
  orm: BetterSQLite3Database<typeof thoughtStoreSchema>,
  reads: ThoughtStoreReads,
  input: ThoughtCandidateInput,
) {
  const ids: number[] = [];
  for (const anchor of new Set(input.anchors)) {
    const candidates = orm
      .select({ id: thinkingRecords.id })
      .from(thinkingRecords)
      .where(
        and(
          eq(thinkingRecords.sessionKey, input.sessionKey),
          eq(thinkingRecords.causalAnchor, anchor),
        ),
      )
      .orderBy(asc(thinkingRecords.id))
      .limit(65)
      .all();
    if (candidates.length > 64 || ids.length + candidates.length > 256) {
      throw new ThoughtReadBudgetError();
    }
    ids.push(...candidates.map((row) => row.id));
  }
  if (ids.length === 0) {
    return [];
  }
  const where: SQL | undefined = and(
    eq(thinkingRecords.sessionKey, input.sessionKey),
    inArray(thinkingRecords.id, ids),
  );
  reads.assertSelectionBudget(where, 64 * 1024 * 1024);
  const records = ids.flatMap((id) => {
    const record = reads.getRecord(input.sessionKey, id);
    return record &&
      record.captureState === 'complete' &&
      Boolean(record.operationId) &&
      Boolean(record.causalAnchor) &&
      record.completedAt !== null &&
      record.completedAt !== undefined &&
      areThoughtRecordModelsCompatible(record, input)
      ? [record]
      : [];
  });
  assertThoughtReplyBudget(records);
  return records;
}
