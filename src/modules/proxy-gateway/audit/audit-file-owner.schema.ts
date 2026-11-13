import { z } from 'zod';
import path from 'node:path';
import { AuditScopedSessionIdSchema } from './audit-session-export.schema';

export const AuditFileExportInputSchema = z
  .strictObject({
    bodyId: z.string().uuid(),
    filePath: z.string().min(1).max(4096).refine(path.isAbsolute),
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 3000);
export const AuditFileExportResultSchema = z.strictObject({ status: z.literal('saved') });
export type AuditFileExportInput = z.infer<typeof AuditFileExportInputSchema>;
export const AuditSessionFileExportInputSchema = z
  .strictObject({
    sessionId: AuditScopedSessionIdSchema,
    filePath: z.string().min(1).max(4096).refine(path.isAbsolute),
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 3000);
export type AuditSessionFileExportInput = z.infer<typeof AuditSessionFileExportInputSchema>;
export const AuditHarFileExportInputSchema = z
  .strictObject({
    requestId: z.string().uuid(),
    filePath: z.string().min(1).max(4096).refine(path.isAbsolute),
  })
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 3000);
export type AuditHarFileExportInput = z.infer<typeof AuditHarFileExportInputSchema>;

export class AuditFileOwnerError extends Error {
  constructor() {
    super('Audit export is unavailable.');
  }
}
