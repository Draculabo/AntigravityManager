import { z } from 'zod';
import { omitThoughtSignaturePlaceholder } from '../antigravity/ThoughtSignatureCompat';
import { decodeThoughtPartSignatures } from './thought-part-signatures';
import { unpackThought } from './thought-store.blob';
import type { thinkingRecords } from './thought-store.schema';
import type { ThoughtRecord } from './thought-store.types';
import { ThoughtProvenanceSchema } from './thought-record-provenance';
import {
  MAX_THOUGHT_METADATA_BYTES,
  MAX_THOUGHT_READ_BYTES,
  ThoughtReadBudgetError,
} from './thought-read-budget';

function parseStoredJson(value: string): unknown {
  if (Buffer.byteLength(value, 'utf8') > MAX_THOUGHT_METADATA_BYTES) {
    throw new ThoughtReadBudgetError();
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Thought Store contains invalid record metadata');
  }
}

export function parsePartSignatures(value: string, thought?: string) {
  return decodeThoughtPartSignatures(parseStoredJson(value), thought);
}

export function parseThoughtToolList(value: string): string[] {
  const parsed = z.array(z.string()).safeParse(parseStoredJson(value));
  if (!parsed.success) {
    throw new Error('Thought Store contains invalid tool metadata');
  }
  return parsed.data;
}

export function decodeThoughtRow(
  row: typeof thinkingRecords.$inferSelect,
): ThoughtRecord & { id: number } {
  const metadataBytes = [
    row.visible,
    row.signature ?? '',
    row.partSignatures,
    row.toolIds,
    row.toolNames,
    row.fingerprint,
    row.model ?? '',
    row.sourceFamily ?? '',
    row.operationId ?? '',
    row.causalAnchor ?? '',
    row.captureState,
  ].reduce((bytes, value) => bytes + Buffer.byteLength(value, 'utf8'), 512);
  if (
    !Number.isSafeInteger(row.thoughtBytes) ||
    row.thoughtBytes < 0 ||
    metadataBytes + row.thoughtBytes > MAX_THOUGHT_READ_BYTES ||
    (row.thought?.length ?? 0) > MAX_THOUGHT_READ_BYTES
  ) {
    throw new ThoughtReadBudgetError();
  }
  const thought = unpackThought(row.thought, row.id, Math.min(row.thoughtBytes, 64 * 1024 * 1024));
  return {
    ...(row.captureState === 'legacy'
      ? {}
      : ThoughtProvenanceSchema.parse({
          operationId: row.operationId,
          causalAnchor: row.causalAnchor,
          completedAt: row.completedAt,
          captureState: row.captureState,
        })),
    createdAt: row.createdAt,
    fingerprint: row.fingerprint,
    id: row.id,
    model: row.model,
    oversized: row.oversized,
    oversizedBytes: row.oversizedBytes,
    oversizedSha256: row.oversizedSha256,
    signature: omitThoughtSignaturePlaceholder(row.signature),
    partSignatures: parsePartSignatures(row.partSignatures, thought),
    sourceFamily: row.sourceFamily,
    thought,
    toolIds: parseThoughtToolList(row.toolIds),
    toolNames: parseThoughtToolList(row.toolNames),
    visible: row.visible,
  };
}
