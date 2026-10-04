import { z } from 'zod';
import path from 'node:path';

export const AuditFileExportInputSchema = z
  .strictObject({
    bodyId: z.string().uuid(),
    filePath: z.string().min(1).max(4096).refine(path.isAbsolute),
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 3000);
export const AuditFileExportResultSchema = z.strictObject({ status: z.literal('saved') });
export type AuditFileExportInput = z.infer<typeof AuditFileExportInputSchema>;

export class AuditFileOwnerError extends Error {
  constructor() {
    super('Audit export is unavailable.');
  }
}
