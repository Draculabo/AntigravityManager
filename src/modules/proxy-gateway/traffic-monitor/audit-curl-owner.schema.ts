import { z } from 'zod';
import { ContentDescriptorSchema } from '../diagnostics/content-capability.schema';
export const AuditCurlInputSchema = z.strictObject({
  id: z.string().min(1).max(128),
  attemptId: z.string().min(1).max(128).optional(),
  includeCredentials: z.boolean(),
});
export const AuditCurlOpenSchema = ContentDescriptorSchema.extend({
  kind: z.literal('curl'),
  totalBytes: z
    .number()
    .int()
    .nonnegative()
    .max(64 * 1024 * 1024),
});
export type AuditCurlInput = z.infer<typeof AuditCurlInputSchema>;
export function curlResourceId(input: AuditCurlInput): string {
  return JSON.stringify([input.id, input.attemptId ?? null, input.includeCredentials]);
}
export class AuditCurlOwnerError extends Error {
  constructor() {
    super('Unable to copy this request right now. Please try again.');
    this.name = 'AuditCurlOwnerError';
  }
}
