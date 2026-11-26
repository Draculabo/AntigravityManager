import { and, asc, count, eq, gt, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { ThoughtRecord, ThoughtRecordInput } from './thought-store.types';
import {
  MAX_TOOL_RECOVERY_OPERATIONS,
  ThoughtToolRecoverySnapshotSchema,
} from './thought-tool-recovery.schema';
import type { ThoughtToolRecoverySnapshot } from './thought-tool-recovery.schema';
import type { ThoughtPartSignature } from './thought-part-signatures';
import { replayableToolPositions } from './thought-tool-link-replay';
import { thoughtToolLayoutDigest } from './thought-tool-layout';
import { decodeThoughtPartSignatures } from './thought-part-signatures';
import {
  MAX_THOUGHT_READ_BYTES,
  MAX_THOUGHT_METADATA_BYTES,
  ThoughtReadBudgetError,
} from './thought-read-budget';
import {
  thinkingRecords,
  thinkingToolLinks,
  type ThoughtStoreDatabase,
} from './thought-store.schema';

export const THOUGHT_TOOL_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LINKS = 10_000;
const PositionsSchema = z.array(z.object({ position: z.number().int().nonnegative() })).max(2000);
const CountSchema = z.object({ count: z.number().int().nonnegative().safe() });

export function expireThoughtToolSignatures<T extends ThoughtRecord>(
  record: T,
  now = Date.now(),
): T {
  if (
    record.operationId &&
    record.causalAnchor &&
    record.captureState === 'complete' &&
    record.completedAt !== null &&
    record.completedAt !== undefined &&
    record.completedAt > now - THOUGHT_TOOL_LINK_TTL_MS
  ) {
    return record;
  }
  return {
    ...record,
    partSignatures: record.partSignatures.map((part) =>
      part.kind === 'tool' ? { ...part, signature: null } : part,
    ),
  };
}

/** References only: signed content remains in its original diagnostic record. */
export class ThoughtToolLinks {
  constructor(private readonly orm: ThoughtStoreDatabase) {}

  save(
    id: number,
    record: ThoughtRecordInput,
    previousParts?: readonly ThoughtPartSignature[],
  ): void {
    if (
      record.captureState !== 'complete' ||
      !record.operationId ||
      !record.causalAnchor ||
      record.completedAt === undefined ||
      record.completedAt === null
    ) {
      return;
    }
    const cutoff = Date.now() - THOUGHT_TOOL_LINK_TTL_MS;
    const allowed =
      previousParts === undefined
        ? undefined
        : replayableToolPositions(
            previousParts,
            record.partSignatures,
            new Set(
              PositionsSchema.parse(
                this.orm
                  .select({ position: thinkingToolLinks.position })
                  .from(thinkingToolLinks)
                  .where(
                    and(
                      eq(thinkingToolLinks.recordId, id),
                      gt(thinkingToolLinks.completedAt, cutoff),
                    ),
                  )
                  .all(),
              ).map((row) => row.position),
            ),
          );
    this.orm.delete(thinkingToolLinks).where(eq(thinkingToolLinks.recordId, id)).run();
    const completedAt = record.completedAt;
    if (completedAt > cutoff) {
      const links: Array<typeof thinkingToolLinks.$inferInsert> = [];
      for (const part of record.partSignatures) {
        if (part.kind === 'tool' && part.signature && (!allowed || allowed.has(part.position))) {
          links.push({ recordId: id, position: part.position, completedAt });
        }
      }
      if (links.length > 0) {
        this.orm.insert(thinkingToolLinks).values(links).run();
      }
    }
    this.deleteOldest(2000, lte(thinkingToolLinks.completedAt, cutoff));
    const linkCount = CountSchema.parse(
      this.orm.select({ count: count() }).from(thinkingToolLinks).get(),
    ).count;
    if (linkCount > MAX_LINKS) {
      this.deleteOldest(linkCount - MAX_LINKS);
    }
  }

  private deleteOldest(limit: number, filter?: SQL): void {
    const oldest = this.orm
      .select({ recordId: thinkingToolLinks.recordId, position: thinkingToolLinks.position })
      .from(thinkingToolLinks)
      .where(filter)
      .orderBy(
        asc(thinkingToolLinks.completedAt),
        asc(thinkingToolLinks.recordId),
        asc(thinkingToolLinks.position),
      )
      .limit(limit);
    this.orm
      .delete(thinkingToolLinks)
      .where(inArray(sql`(${thinkingToolLinks.recordId}, ${thinkingToolLinks.position})`, oldest))
      .run();
  }

  recoverable<T extends ThoughtRecord>(sessionKey: string, records: T[]): T[] {
    const operationIds = [
      ...new Set(records.flatMap((record) => (record.operationId ? [record.operationId] : []))),
    ];
    const snapshot = this.snapshot(sessionKey, operationIds);
    const permissions = new Map(
      snapshot.map((entry) => [entry.operationId, new Set(entry.positions)]),
    );
    return records.map((record) => {
      if (!record.operationId || record.captureState !== 'complete') {
        return expireThoughtToolSignatures(record);
      }
      const positions = permissions.get(record.operationId);
      return {
        ...record,
        partSignatures: record.partSignatures.map((part) =>
          part.kind === 'tool' && !positions?.has(part.position)
            ? { ...part, signature: null }
            : part,
        ),
      };
    });
  }

  count(): number {
    return CountSchema.parse(
      this.orm
        .select({ count: count() })
        .from(thinkingToolLinks)
        .where(gt(thinkingToolLinks.completedAt, Date.now() - THOUGHT_TOOL_LINK_TTL_MS))
        .get(),
    ).count;
  }

  snapshot(
    sessionKey: string,
    operationIds: string[],
    layouts?: Array<{ operationId: string; digest: string }>,
  ): ThoughtToolRecoverySnapshot {
    if (operationIds.length === 0) {
      return [];
    }
    const where = and(
      eq(thinkingRecords.sessionKey, sessionKey),
      eq(thinkingRecords.captureState, 'complete'),
      inArray(thinkingRecords.operationId, operationIds),
    );
    const mismatched = new Set<string>();
    if (layouts) {
      const sizes = z
        .array(z.object({ bytes: z.number().int().safe().nonnegative() }))
        .max(MAX_TOOL_RECOVERY_OPERATIONS)
        .parse(
          this.orm
            .select({ bytes: sql<number>`length(cast(${thinkingRecords.partSignatures} as blob))` })
            .from(thinkingRecords)
            .where(where)
            .limit(MAX_TOOL_RECOVERY_OPERATIONS + 1)
            .all(),
        );
      if (
        sizes.some((row) => row.bytes > MAX_THOUGHT_METADATA_BYTES) ||
        sizes.reduce((sum, row) => sum + row.bytes, 0) > MAX_THOUGHT_READ_BYTES
      ) {
        throw new ThoughtReadBudgetError();
      }
      const requested = new Map<string, Set<string>>();
      for (const layout of layouts) {
        const digests = requested.get(layout.operationId) ?? new Set<string>();
        digests.add(layout.digest);
        requested.set(layout.operationId, digests);
      }
      const stored = z
        .array(z.object({ operationId: z.string().min(1).max(128), parts: z.string() }))
        .max(MAX_TOOL_RECOVERY_OPERATIONS)
        .parse(
          this.orm
            .select({
              operationId: thinkingRecords.operationId,
              parts: thinkingRecords.partSignatures,
            })
            .from(thinkingRecords)
            .where(where)
            .limit(MAX_TOOL_RECOVERY_OPERATIONS + 1)
            .all(),
        );
      for (const row of stored) {
        let value: unknown;
        try {
          value = JSON.parse(row.parts);
        } catch {
          throw new Error('Thought Store contains invalid part signature metadata');
        }
        const digest = thoughtToolLayoutDigest(decodeThoughtPartSignatures(value));
        const expected = requested.get(row.operationId);
        if (expected?.size !== 1 || !expected.has(digest)) {
          mismatched.add(row.operationId);
        }
      }
    }
    const rows = z
      .array(
        z.object({
          recordId: z.number().int().positive(),
          operationId: z.string().min(1).max(128),
          position: z.number().int().nonnegative().nullable(),
        }),
      )
      .max(MAX_TOOL_RECOVERY_OPERATIONS + MAX_LINKS)
      .parse(
        this.orm
          .select({
            recordId: thinkingRecords.id,
            operationId: thinkingRecords.operationId,
            position: thinkingToolLinks.position,
          })
          .from(thinkingRecords)
          .leftJoin(
            thinkingToolLinks,
            and(
              eq(thinkingToolLinks.recordId, thinkingRecords.id),
              gt(thinkingToolLinks.completedAt, Date.now() - THOUGHT_TOOL_LINK_TTL_MS),
            ),
          )
          .where(where)
          .orderBy(asc(thinkingRecords.operationId), asc(thinkingToolLinks.position))
          .limit(MAX_TOOL_RECOVERY_OPERATIONS + MAX_LINKS + 1)
          .all(),
      );
    const entries = new Map<string, number[]>();
    const owners = new Map<string, number>();
    for (const row of rows) {
      const owner = owners.get(row.operationId);
      if (owner !== undefined && owner !== row.recordId) {
        throw new Error('Thought Store operation ownership is ambiguous');
      }
      owners.set(row.operationId, row.recordId);
      const positions = entries.get(row.operationId) ?? [];
      if (row.position !== null && !mismatched.has(row.operationId)) {
        positions.push(row.position);
      }
      entries.set(row.operationId, positions);
    }
    return ThoughtToolRecoverySnapshotSchema.parse(
      [...entries].map(([operationId, positions]) => ({ operationId, positions })),
    );
  }
}
