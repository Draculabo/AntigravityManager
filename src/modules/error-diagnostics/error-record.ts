import { omit } from 'lodash-es';
import { z } from 'zod';
import {
  createDiagnosticErrorRecord,
  type CreateDiagnosticErrorRecordInput,
  type DiagnosticErrorRecord,
} from '@/shared/observability/errorDiagnostic';

export const MAX_ERROR_RECORD_BYTES = 8 * 1024 * 1024;
const NullableLabelSchema = z.string().max(512).nullable();
const StackSchema = z.string().max(MAX_ERROR_RECORD_BYTES).nullable();
const CauseSchema = z
  .object({
    name: z.string().max(512),
    message: z.string().max(64 * 1024),
    stack: StackSchema,
    cycle: z.boolean(),
  })
  .strict();

// Stack chunks are a transport projection, not another persisted copy of the stack.
export const StoredErrorRecordSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    role: z.enum(['app', 'core']),
    source: z.string().min(1).max(512),
    module: NullableLabelSchema,
    functionName: NullableLabelSchema,
    stage: NullableLabelSchema,
    protocol: NullableLabelSchema,
    requestId: NullableLabelSchema,
    attemptId: NullableLabelSchema,
    category: z.string().min(1).max(512),
    status: z.number().int().safe().nonnegative().nullable(),
    message: z.string().max(64 * 1024),
    stack: StackSchema,
    stackComplete: z.boolean(),
    causes: z.array(CauseSchema).max(17),
  })
  .strict()
  .refine((record) => Boolean(record.stack) === record.stackComplete);
export type StoredErrorRecord = z.infer<typeof StoredErrorRecordSchema>;

export type EncodedErrorRecord =
  | { accepted: true; id: string; body: string; bytes: number }
  | { accepted: false; reason: 'record_too_large' };

/** Reject the whole diagnostic; never label a truncated stack as complete. */
export function encodeErrorRecord(record: DiagnosticErrorRecord): EncodedErrorRecord {
  const textFields = [
    record.stack ?? '',
    record.message,
    record.source,
    record.category,
    record.module ?? '',
    record.functionName ?? '',
    record.stage ?? '',
    record.protocol ?? '',
    record.requestId ?? '',
    record.attemptId ?? '',
    ...record.causes.flatMap((cause) => [cause.name, cause.message, cause.stack ?? '']),
  ];
  if (textFields.reduce((total, text) => total + text.length, 0) > MAX_ERROR_RECORD_BYTES) {
    return { accepted: false, reason: 'record_too_large' };
  }
  const body = JSON.stringify(omit(record, 'stackChunks'));
  const bytes = Buffer.byteLength(body, 'utf8');
  return bytes <= MAX_ERROR_RECORD_BYTES
    ? { accepted: true, id: record.id, body, bytes }
    : { accepted: false, reason: 'record_too_large' };
}

/** Bound source text before redaction and stack chunk copies are allocated. */
export function encodeErrorCapture(input: CreateDiagnosticErrorRecordInput): EncodedErrorRecord {
  let characters =
    input.source.length +
    input.category.length +
    (input.module?.length ?? 0) +
    (input.functionName?.length ?? 0) +
    (input.stage?.length ?? 0) +
    (input.protocol?.length ?? 0) +
    (input.requestId?.length ?? 0) +
    (input.attemptId?.length ?? 0);
  let current = input.error;
  const seen = new Set<Error>();
  for (let depth = 0; depth <= 16 && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      if (seen.has(current)) {
        break;
      }
      seen.add(current);
      characters += current.name.length + current.message.length + (current.stack?.length ?? 0);
      current = current.cause;
    } else {
      characters += typeof current === 'string' ? current.length : 0;
      break;
    }
    if (characters > MAX_ERROR_RECORD_BYTES) {
      return { accepted: false, reason: 'record_too_large' };
    }
  }
  if (characters > MAX_ERROR_RECORD_BYTES) {
    return { accepted: false, reason: 'record_too_large' };
  }
  return encodeErrorRecord(createDiagnosticErrorRecord(input));
}

/** JSON/Worker storage boundary; callers never expose parser input snippets. */
export function decodeErrorRecord(body: string): StoredErrorRecord {
  if (Buffer.byteLength(body, 'utf8') > MAX_ERROR_RECORD_BYTES) {
    throw new Error('Local error diagnostic exceeds the record budget');
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error('Local error diagnostic is invalid');
  }
  const parsed = StoredErrorRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Local error diagnostic is invalid');
  }
  return parsed.data;
}
