import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ThoughtRecord, ThoughtRecordInput } from './thought-store.types';

export const THOUGHT_TOOL_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LINKS = 10_000;
const PositionsSchema = z.array(z.object({ position: z.number().int().nonnegative() })).max(2000);
const CountSchema = z.object({ count: z.number().int().nonnegative().safe() });

export function expireThoughtToolSignatures<T extends ThoughtRecord>(
  record: T,
  now = Date.now(),
): T {
  if (
    !record.operationId ||
    (record.captureState === 'complete' &&
      record.completedAt !== null &&
      record.completedAt !== undefined &&
      record.completedAt > now - THOUGHT_TOOL_LINK_TTL_MS)
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

  save(id: number, record: ThoughtRecordInput): void {
    if (
      record.captureState !== 'complete' ||
      !record.operationId ||
      !record.causalAnchor ||
      record.completedAt === undefined ||
      record.completedAt === null
    ) {
      return;
    }
    this.raw.prepare('DELETE FROM thinking_tool_links WHERE record_id=?').run(id);
    const cutoff = Date.now() - THOUGHT_TOOL_LINK_TTL_MS;
    if (record.completedAt > cutoff) {
      const insert = this.raw.prepare(
        'INSERT INTO thinking_tool_links(record_id,position,completed_at) VALUES(?,?,?)',
      );
      for (const part of record.partSignatures) {
        if (part.kind === 'tool' && part.signature) {
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

  recoverable(record: ThoughtRecord & { id: number }): ThoughtRecord & { id: number } {
    if (!record.operationId || record.captureState !== 'complete') {
      return record;
    }
    const rows = PositionsSchema.parse(
      this.raw
        .prepare(
          'SELECT position FROM thinking_tool_links WHERE record_id=? AND completed_at>? ORDER BY position',
        )
        .all(record.id, Date.now() - THOUGHT_TOOL_LINK_TTL_MS),
    );
    const positions = new Set(rows.map((row) => row.position));
    return {
      ...record,
      partSignatures: record.partSignatures.map((part) =>
        part.kind === 'tool' && !positions.has(part.position) ? { ...part, signature: null } : part,
      ),
    };
  }

  count(): number {
    return CountSchema.parse(
      this.raw
        .prepare('SELECT count(*) AS count FROM thinking_tool_links WHERE completed_at>?')
        .get(Date.now() - THOUGHT_TOOL_LINK_TTL_MS),
    ).count;
  }
}
