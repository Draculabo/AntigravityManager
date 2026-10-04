import { z } from 'zod';

export const DIAGNOSTIC_CHUNK_BYTES = 64 * 1024;
export const DIAGNOSTIC_RETAINED_BYTES = 256 * 1024 * 1024;
export const DIAGNOSTIC_CONTENT_TTL_MS = 5 * 60 * 1000;
export const ContentIdentitySchema = z.strictObject({
  epoch: z.uuid(),
  capabilityId: z.uuid(),
  kind: z.enum(['thought', 'curl']),
  resourceId: z.string().min(1).max(1024),
});
export const ContentDescriptorSchema = ContentIdentitySchema.extend({
  totalBytes: z.number().int().nonnegative().max(DIAGNOSTIC_RETAINED_BYTES),
  chunkBytes: z.literal(DIAGNOSTIC_CHUNK_BYTES),
  expiresAt: z.number().int().nonnegative(),
});
export const ContentReadInputSchema = ContentIdentitySchema.extend({
  cursor: z.number().int().nonnegative().max(DIAGNOSTIC_RETAINED_BYTES),
});
export const ContentChunkSchema = z.strictObject({
  cursor: z.number().int().nonnegative().max(DIAGNOSTIC_RETAINED_BYTES),
  nextCursor: z.number().int().nonnegative().max(DIAGNOSTIC_RETAINED_BYTES),
  complete: z.boolean(),
  data: z
    .string()
    .max(Math.ceil(DIAGNOSTIC_CHUNK_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export const ContentClosedSchema = z.strictObject({ closed: z.literal(true) });
export type ContentIdentity = z.infer<typeof ContentIdentitySchema>;
export type ContentDescriptor = z.infer<typeof ContentDescriptorSchema>;
export type ContentReadInput = z.infer<typeof ContentReadInputSchema>;
export type ContentChunk = z.infer<typeof ContentChunkSchema>;

export class DiagnosticContentError extends Error {
  constructor() {
    super('Diagnostic content is unavailable.');
    this.name = 'DiagnosticContentError';
  }
}
