import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ThoughtRecord, ThoughtRecordInput } from './thought-store.types';
import { ThoughtToolRecoverySnapshotSchema } from './thought-tool-recovery.schema';
import type { ThoughtToolRecoverySnapshot } from './thought-tool-recovery.schema';
import type { ThoughtPartSignature } from './thought-part-signatures';
import { replayableToolPositions } from './thought-tool-link-replay';
import { thoughtToolLayoutDigest } from './thought-tool-layout';
import { decodeThoughtPartSignatures } from './thought-part-signatures';
import { MAX_THOUGHT_READ_BYTES, MAX_THOUGHT_METADATA_BYTES, ThoughtReadBudgetError } from './thought-read-budget';

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
  constructor(private readonly raw: Database.Database) {}

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
                this.raw
                  .prepare(
                    'SELECT position FROM thinking_tool_links WHERE record_id=? AND completed_at>?',
                  )
                  .all(id, cutoff),
              ).map((row) => row.position),
            ),
          );
    this.raw.prepare('DELETE FROM thinking_tool_links WHERE record_id=?').run(id);
    if (record.completedAt > cutoff) {
      const insert = this.raw.prepare(
        'INSERT INTO thinking_tool_links(record_id,position,completed_at) VALUES(?,?,?)',
      );
      for (const part of record.partSignatures) {
        if (part.kind === 'tool' && part.signature && (!allowed || allowed.has(part.position))) {
          insert.run(id, part.position, record.completedAt);
        }
      }
    }
    this.raw
      .prepare(
        'DELETE FROM thinking_tool_links WHERE (record_id,position) IN (SELECT record_id,position FROM thinking_tool_links WHERE completed_at<=? ORDER BY completed_at,record_id,position LIMIT 2000)',
      )
      .run(cutoff);
    const count = CountSchema.parse(
      this.raw.prepare('SELECT count(*) AS count FROM thinking_tool_links').get(),
    ).count;
    if (count > MAX_LINKS) {
      this.raw
        .prepare(
          'DELETE FROM thinking_tool_links WHERE (record_id,position) IN (SELECT record_id,position FROM thinking_tool_links ORDER BY completed_at,record_id,position LIMIT ?)',
        )
        .run(count - MAX_LINKS);
    }
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
      this.raw
        .prepare('SELECT count(*) AS count FROM thinking_tool_links WHERE completed_at>?')
        .get(Date.now() - THOUGHT_TOOL_LINK_TTL_MS),
    ).count;
  }

  snapshot(sessionKey: string, operationIds: string[], layouts?: Array<{ operationId: string; digest: string }>): ThoughtToolRecoverySnapshot {
    if (operationIds.length === 0) {
      return [];
    }
    const mismatched = new Set<string>();
    if (layouts) {
      const where = `session_key=? AND capture_state='complete' AND operation_id IN (${operationIds.map(() => '?').join(',')})`;
      const sizes = z.array(z.object({ bytes: z.number().int().safe().nonnegative() })).max(10_256).parse(this.raw.prepare(
        `SELECT length(cast(part_signatures AS blob)) AS bytes FROM thinking_records WHERE ${where} LIMIT 10257`,
      ).all(sessionKey, ...operationIds));
      if (sizes.some((row) => row.bytes > MAX_THOUGHT_METADATA_BYTES) || sizes.reduce((sum, row) => sum + row.bytes, 0) > MAX_THOUGHT_READ_BYTES) {
        throw new ThoughtReadBudgetError();
      }
      const requested = new Map<string, Set<string>>();
      for (const layout of layouts) {
        const digests = requested.get(layout.operationId) ?? new Set<string>();
        digests.add(layout.digest);
        requested.set(layout.operationId, digests);
      }
      const stored = z.array(z.object({ operationId: z.string().min(1).max(128), parts: z.string() })).max(10_256).parse(this.raw.prepare(
        `SELECT operation_id AS operationId,part_signatures AS parts FROM thinking_records WHERE ${where} LIMIT 10257`,
      ).all(sessionKey, ...operationIds));
      for (const row of stored) {
        let value: unknown;
        try { value = JSON.parse(row.parts); } catch { throw new Error('Thought Store contains invalid part signature metadata'); }
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
      .max(20_256)
      .parse(
        this.raw
          .prepare(
            `SELECT r.id AS recordId,r.operation_id AS operationId, l.position FROM thinking_records r
         LEFT JOIN thinking_tool_links l ON l.record_id=r.id AND l.completed_at>?
         WHERE r.session_key=? AND r.capture_state='complete'
         AND r.operation_id IN (${operationIds.map(() => '?').join(',')})
         ORDER BY r.operation_id,l.position LIMIT 20257`,
          )
          .all(Date.now() - THOUGHT_TOOL_LINK_TTL_MS, sessionKey, ...operationIds),
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
