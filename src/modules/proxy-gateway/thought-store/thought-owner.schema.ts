import { z } from 'zod';
import { ContentDescriptorSchema } from '../diagnostics/content-capability.schema';

export const ThoughtSessionsInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(200).default(100),
  offset: z.number().int().nonnegative().default(0),
  model: z.string().trim().max(256).optional(),
  search: z.string().trim().max(512).optional(),
});
export const ThoughtSessionInputSchema = z.strictObject({ sessionKey: z.string().min(1).max(512) });
export const ThoughtRecordInputSchema = ThoughtSessionInputSchema.extend({
  id: z.number().int().positive(),
});
export const ThoughtRecordSchema = z.strictObject({
  createdAt: z.number().int(),
  fingerprint: z.string(),
  id: z.union([z.number().int().positive(), z.string().min(1).max(128)]),
  model: z.string().nullable(),
  oversized: z.boolean(),
  oversizedBytes: z.number().int().nonnegative().nullable(),
  oversizedSha256: z.string().nullable(),
  signature: z.string().nullable(),
  sourceFamily: z.string().nullable(),
  thought: z.string(),
  toolIds: z.array(z.string()),
  toolNames: z.array(z.string()),
  visible: z.string(),
});
export const ThoughtRecordMetadataSchema = ThoughtRecordSchema.omit({
  thought: true,
  visible: true,
  signature: true,
});
export const ThoughtRecordOpenSchema = z
  .strictObject({
    transfer: ContentDescriptorSchema.extend({ kind: z.literal('thought') }),
    metadata: ThoughtRecordMetadataSchema,
    thoughtBytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024),
    visibleBytes: z.number().int().nonnegative(),
    signatureBytes: z.number().int().nonnegative().nullable(),
  })
  .refine(
    (value) =>
      value.thoughtBytes + value.visibleBytes + (value.signatureBytes ?? 0) ===
      value.transfer.totalBytes,
  );
export type ThoughtRecordInput = z.infer<typeof ThoughtRecordInputSchema>;
export type ThoughtRecordOpen = z.infer<typeof ThoughtRecordOpenSchema>;
export function thoughtResourceId(input: ThoughtRecordInput): string {
  return `${input.sessionKey}/${input.id}`;
}
export class ThoughtOwnerError extends Error {
  constructor() {
    super('AI reasoning history is unavailable right now. Please try again.');
    this.name = 'ThoughtOwnerError';
  }
}
export function parseThoughtResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.parse(value);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 900 * 1024) {
    throw new ThoughtOwnerError();
  }
  return result;
}
