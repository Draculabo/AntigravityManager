import { os } from '@orpc/server';
import {
  CloudAccountCredentialImportInputSchema,
  CloudAccountCredentialImportResultSchema,
  type CloudAccountCredentialImport,
} from './cloud-account-credential-import.schema';

export function createCloudAccountCredentialImportRouter(
  importToken: CloudAccountCredentialImport,
) {
  return os.router({
    importToken: os
      .input(CloudAccountCredentialImportInputSchema)
      .output(CloudAccountCredentialImportResultSchema)
      .handler(async ({ input }) => {
        try {
          return await importToken(input);
        } catch {
          return { status: 'failed', reason: 'save-failed' };
        }
      }),
  });
}
