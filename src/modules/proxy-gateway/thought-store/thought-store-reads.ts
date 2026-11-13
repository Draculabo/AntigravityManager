import { and, asc, desc, eq, gt, lte, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { ThoughtRecordPageSchema, type ThoughtRecordPageInput } from './thought-management.schema';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { thinkingRecords, thoughtStoreSchema } from './thought-store.schema';
import { decodeThoughtRow } from './thought-store.codec';
import {
  assertThoughtReplyBudget,
  MAX_THOUGHT_METADATA_BYTES,
  MAX_THOUGHT_READ_BYTES,
  MAX_THOUGHT_READ_RECORDS,
  ThoughtReadBudgetError,
} from './thought-read-budget';

type ThoughtDatabase = BetterSQLite3Database<typeof thoughtStoreSchema>;

// Measure persisted strings and blobs without first returning their contents to JavaScript.
const metadataBytes = sql<number>`512 + length(cast(${thinkingRecords.visible} as blob)) +
  length(cast(coalesce(${thinkingRecords.signature}, '') as blob)) +
  length(cast(${thinkingRecords.partSignatures} as blob)) +
  length(cast(${thinkingRecords.toolIds} as blob)) + length(cast(${thinkingRecords.toolNames} as blob)) +
  length(cast(${thinkingRecords.fingerprint} as blob)) +
  length(cast(coalesce(${thinkingRecords.model}, '') as blob)) +
  length(cast(coalesce(${thinkingRecords.sourceFamily}, '') as blob)) +
  length(cast(coalesce(${thinkingRecords.operationId}, '') as blob)) +
  length(cast(coalesce(${thinkingRecords.causalAnchor}, '') as blob)) +
  length(cast(${thinkingRecords.captureState} as blob))`;
const selection = {
  id: thinkingRecords.id,
  metadataBytes,
  thoughtBytes: thinkingRecords.thoughtBytes,
  blobBytes: sql<number>`coalesce(length(${thinkingRecords.thought}), 0)`,
  jsonBytes: sql<number>`max(length(cast(${thinkingRecords.partSignatures} as blob)),
    length(cast(${thinkingRecords.toolIds} as blob)), length(cast(${thinkingRecords.toolNames} as blob)))`,
};
type SizeRow = {
  id: number;
  metadataBytes: number;
  thoughtBytes: number;
  blobBytes: number;
  jsonBytes: number;
};

function readBytes(row: SizeRow): number {
  if (
    [row.metadataBytes, row.thoughtBytes, row.blobBytes, row.jsonBytes].some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    row.blobBytes > MAX_THOUGHT_READ_BYTES ||
    row.jsonBytes > MAX_THOUGHT_METADATA_BYTES
  ) {
    throw new ThoughtReadBudgetError();
  }
  return row.metadataBytes + Math.max(row.thoughtBytes, row.blobBytes);
}

/** Recent windows may be smaller; complete management reads fail instead of truncating. */
export class ThoughtStoreReads {
  constructor(private readonly orm: ThoughtDatabase) {}

  loadCandidatesById(sessionKey: string, orderedIds: readonly number[]) {
    if (orderedIds.length === 0) {
      return [];
    }
    const where = and(
      eq(thinkingRecords.sessionKey, sessionKey),
      inArray(thinkingRecords.id, orderedIds),
    );
    const sizes = this.orm.select(selection).from(thinkingRecords).where(where).all();
    if (sizes.reduce((total, row) => total + readBytes(row), 0) > 64 * 1024 * 1024) {
      throw new ThoughtReadBudgetError();
    }
    const rows = new Map(this.selectRows(where).map((row) => [row.id, row]));
    return orderedIds.flatMap((id) => {
      const row = rows.get(id);
      if (!row) {
        return [];
      }
      const record = decodeThoughtRow(row);
      assertThoughtReplyBudget([record]);
      return [record];
    });
  }

  private selectRows(where: SQL | undefined) {
    return this.orm
      .select()
      .from(thinkingRecords)
      .where(where)
      .orderBy(asc(thinkingRecords.id))
      .all();
  }

  assertMatchBudget(sessionKey: string, targetId: number | undefined, limit: number): void {
    const rows = this.orm
      .select({ metadataBytes, jsonBytes: selection.jsonBytes })
      .from(thinkingRecords)
      .where(
        targetId === undefined
          ? eq(thinkingRecords.sessionKey, sessionKey)
          : eq(thinkingRecords.id, targetId),
      )
      .orderBy(desc(thinkingRecords.id))
      .limit(targetId === undefined ? limit : 1)
      .all();
    let bytes = 0;
    for (const row of rows) {
      bytes += row.metadataBytes;
      if (
        !Number.isSafeInteger(row.metadataBytes) ||
        row.metadataBytes < 0 ||
        !Number.isSafeInteger(row.jsonBytes) ||
        row.jsonBytes < 0 ||
        row.jsonBytes > MAX_THOUGHT_METADATA_BYTES ||
        bytes > MAX_THOUGHT_READ_BYTES
      ) {
        throw new ThoughtReadBudgetError();
      }
    }
  }

  load(sessionKey: string, limits?: { maxTurns?: number; maxSessionBytes?: number }) {
    const maxTurns = Math.min(
      limits?.maxTurns ?? MAX_THOUGHT_READ_RECORDS,
      MAX_THOUGHT_READ_RECORDS,
    );
    const maxBytes = Math.min(
      limits?.maxSessionBytes ?? MAX_THOUGHT_READ_BYTES,
      MAX_THOUGHT_READ_BYTES,
    );
    const candidates = this.orm
      .select(selection)
      .from(thinkingRecords)
      .where(eq(thinkingRecords.sessionKey, sessionKey))
      .orderBy(desc(thinkingRecords.id))
      .limit(maxTurns + (limits ? 0 : 1))
      .all();
    if (!limits && candidates.length > maxTurns) {
      throw new ThoughtReadBudgetError();
    }
    const ids: number[] = [];
    let bytes = 2;
    for (const row of candidates) {
      bytes += readBytes(row);
      if (bytes > maxBytes) {
        if (!limits) {
          throw new ThoughtReadBudgetError();
        }
        break;
      }
      ids.push(row.id);
    }
    const records =
      ids.length === 0
        ? []
        : this.selectRows(
            and(eq(thinkingRecords.sessionKey, sessionKey), inArray(thinkingRecords.id, ids)),
          ).map(decodeThoughtRow);
    assertThoughtReplyBudget(records);
    // Reads remain available under disk pressure; generation-time access is a separate admitted write.
    return records;
  }

  getRecord(sessionKey: string, id: number) {
    const where = and(eq(thinkingRecords.id, id), eq(thinkingRecords.sessionKey, sessionKey));
    const sizes = this.orm.select(selection).from(thinkingRecords).where(where).get();
    if (!sizes) {
      return null;
    }
    if (readBytes(sizes) > MAX_THOUGHT_READ_BYTES) {
      throw new ThoughtReadBudgetError();
    }
    const row = this.orm.select().from(thinkingRecords).where(where).get();
    if (!row) {
      return null;
    }
    const record = decodeThoughtRow(row);
    assertThoughtReplyBudget([record]);
    return record;
  }

  listRecords(sessionKey: string) {
    const rows = this.orm
      .select({
        createdAt: thinkingRecords.createdAt,
        id: thinkingRecords.id,
        model: thinkingRecords.model,
        oversized: thinkingRecords.oversized,
        oversizedBytes: thinkingRecords.oversizedBytes,
        sourceFamily: thinkingRecords.sourceFamily,
        thoughtBytes: thinkingRecords.thoughtBytes,
      })
      .from(thinkingRecords)
      .where(eq(thinkingRecords.sessionKey, sessionKey))
      .orderBy(asc(thinkingRecords.id))
      .limit(MAX_THOUGHT_READ_RECORDS + 1)
      .all();
    if (
      rows.length > MAX_THOUGHT_READ_RECORDS ||
      Buffer.byteLength(JSON.stringify(rows), 'utf8') > MAX_THOUGHT_READ_BYTES
    ) {
      throw new ThoughtReadBudgetError();
    }
    return rows;
  }

  listRecordPage(input: ThoughtRecordPageInput) {
    const throughId =
      input.throughId ??
      this.orm
        .select({ id: thinkingRecords.id })
        .from(thinkingRecords)
        .where(eq(thinkingRecords.sessionKey, input.sessionKey))
        .orderBy(desc(thinkingRecords.id))
        .limit(1)
        .get()?.id ??
      0;
    const where = and(
      eq(thinkingRecords.sessionKey, input.sessionKey),
      gt(thinkingRecords.id, input.afterId),
      lte(thinkingRecords.id, throughId),
    );
    const sizes = this.orm
      .select({
        bytes: sql<number>`256 + length(cast(coalesce(${thinkingRecords.model}, '') as blob)) + length(cast(coalesce(${thinkingRecords.sourceFamily}, '') as blob))`,
      })
      .from(thinkingRecords)
      .where(where)
      .orderBy(asc(thinkingRecords.id))
      .limit(input.limit + 1)
      .all();
    if (
      sizes.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes < 0) ||
      sizes.reduce((sum, row) => sum + row.bytes, 0) > 512 * 1024
    ) {
      throw new ThoughtReadBudgetError();
    }
    const rows = this.orm
      .select({
        createdAt: thinkingRecords.createdAt,
        id: thinkingRecords.id,
        model: thinkingRecords.model,
        oversized: thinkingRecords.oversized,
        oversizedBytes: thinkingRecords.oversizedBytes,
        sourceFamily: thinkingRecords.sourceFamily,
        thoughtBytes: thinkingRecords.thoughtBytes,
      })
      .from(thinkingRecords)
      .where(where)
      .orderBy(asc(thinkingRecords.id))
      .limit(input.limit + 1)
      .all();
    const complete = rows.length <= input.limit;
    const records = rows.slice(0, input.limit);
    const page = ThoughtRecordPageSchema.parse({
      version: 1,
      records,
      throughId,
      complete,
      nextCursor: complete ? null : records.at(-1)?.id,
    });
    if (Buffer.byteLength(JSON.stringify(page), 'utf8') > 512 * 1024) {
      throw new ThoughtReadBudgetError();
    }
    return page;
  }
}
