import { os, ORPCError } from '@orpc/server';
import type { AuditFileOperations } from './audit-file-owner.service';
import {
  AuditFileExportInputSchema,
  AuditFileExportResultSchema,
  AuditSessionFileExportInputSchema,
} from './audit-file-owner.schema';

export function createAuditFileRouter(owner: AuditFileOperations) {
  return os.router({
    exportSession: os
      .input(AuditSessionFileExportInputSchema)
      .output(AuditFileExportResultSchema)
      .handler(async ({ input }) => {
        try {
          return await owner.exportSession(input);
        } catch {
          throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'Audit export is unavailable.' });
        }
      }),
    exportBody: os
      .input(AuditFileExportInputSchema)
      .output(AuditFileExportResultSchema)
      .handler(async ({ input }) => {
        try {
          return await owner.exportBody(input);
        } catch {
          throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'Audit export is unavailable.' });
        }
      }),
  });
}
