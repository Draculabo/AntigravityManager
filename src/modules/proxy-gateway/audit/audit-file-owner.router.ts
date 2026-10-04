import { os, ORPCError } from '@orpc/server';
import type { AuditFileOperations } from './audit-file-owner.service';
import { AuditFileExportInputSchema, AuditFileExportResultSchema } from './audit-file-owner.schema';

export function createAuditFileRouter(owner: AuditFileOperations) {
  return os.router({
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
