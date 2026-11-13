import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
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

const MAX_PER_ANCHOR = 64;
const MAX_CANDIDATES = 256;

/** Complete bounded candidate sets: overflow must never look like one unique owner. */
export function queryThoughtCandidates(
  orm: BetterSQLite3Database<typeof thoughtStoreSchema>,
  reads: ThoughtStoreReads,
  input: ThoughtCandidateInput,
) {
  const idsByAnchor = new Map<string, number[]>(input.anchors.map((anchor) => [anchor, []]));
  const candidates = orm
    .select({ id: thinkingRecords.id, anchor: thinkingRecords.causalAnchor })
    .from(thinkingRecords)
    .where(
      and(
        eq(thinkingRecords.sessionKey, input.sessionKey),
        inArray(thinkingRecords.causalAnchor, [...idsByAnchor.keys()]),
      ),
    )
    .limit(MAX_CANDIDATES + 1)
    .all();
  if (candidates.length > MAX_CANDIDATES) {
    throw new ThoughtReadBudgetError();
  }
  for (const { id, anchor } of candidates) {
    const ids = anchor === null ? undefined : idsByAnchor.get(anchor);
    if (!ids || ids.length >= MAX_PER_ANCHOR) {
      throw new ThoughtReadBudgetError();
    }
    ids.push(id);
  }
  const orderedIds = [...idsByAnchor.values()].flatMap((ids) => ids.sort((a, b) => a - b));
  const records = reads
    .loadCandidatesById(input.sessionKey, orderedIds)
    .filter(
      (record) =>
        record.captureState === 'complete' &&
        Boolean(record.operationId) &&
        Boolean(record.causalAnchor) &&
        record.completedAt !== null &&
        record.completedAt !== undefined &&
        areThoughtRecordModelsCompatible(record, input),
    );
  assertThoughtReplyBudget(records);
  return records;
}
