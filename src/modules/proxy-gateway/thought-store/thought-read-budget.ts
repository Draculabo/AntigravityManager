import type { ThoughtRecord } from './thought-store.types';
import { serialize } from 'node:v8';

export const MAX_THOUGHT_READ_BYTES = 100 * 1024 * 1024;
export const MAX_THOUGHT_METADATA_BYTES = 16 * 1024 * 1024;
export const MAX_THOUGHT_READ_RECORDS = 10_000;

export class ThoughtReadBudgetError extends Error {
  constructor() {
    super('Thought Store read exceeds its record or byte budget');
  }
}

/** Worker messages carry structured data; do not impose JSON escaping on thought text. */
export function assertThoughtReplyBudget(records: readonly ThoughtRecord[]): void {
  if (records.length > MAX_THOUGHT_READ_RECORDS) {
    throw new ThoughtReadBudgetError();
  }
  let bytes = 2;
  for (const record of records) {
    bytes += 512;
    for (const text of [
      record.thought,
      record.visible,
      record.signature ?? '',
      record.fingerprint,
      record.model ?? '',
      record.sourceFamily ?? '',
      String(record.id),
      record.oversizedSha256 ?? '',
      ...record.toolIds,
      ...record.toolNames,
    ]) {
      bytes += Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_THOUGHT_READ_BYTES) {
        throw new ThoughtReadBudgetError();
      }
    }
    bytes += Buffer.byteLength(JSON.stringify(record.partSignatures), 'utf8');
    if (bytes > MAX_THOUGHT_READ_BYTES) {
      throw new ThoughtReadBudgetError();
    }
  }
  if (
    serialize({ id: Number.MAX_SAFE_INTEGER, result: records }).byteLength > MAX_THOUGHT_READ_BYTES
  ) {
    throw new ThoughtReadBudgetError();
  }
}
