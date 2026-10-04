import fs from 'node:fs/promises';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';
import { CloudAccountFileError } from './cloud-account-file.error';
import { exportCloudAccounts, importCloudAccounts } from './cloud-account-file-policy.service';
import {
  CLOUD_ACCOUNT_IMPORT_MAX_BYTES,
  CloudAccountImportFileInputSchema,
  CloudAccountExportFileInputSchema,
  type ImportStrategy,
} from './cloud-account-file.schema';

export async function importCloudAccountFile(filePath: string, strategy: ImportStrategy) {
  if (!CloudAccountImportFileInputSchema.safeParse({ filePath, strategy }).success) {
    throw new CloudAccountFileError('read-failed');
  }
  let content: string;
  try {
    const file = await fs.open(filePath, 'r');
    try {
      const stats = await file.stat();
      if (!stats.isFile()) {
        throw new CloudAccountFileError('read-failed');
      }
      if (stats.size > CLOUD_ACCOUNT_IMPORT_MAX_BYTES) {
        throw new CloudAccountFileError('file-too-large');
      }
      // Read at most one byte beyond the limit even if the file grows after stat.
      const bytes = Buffer.alloc(CLOUD_ACCOUNT_IMPORT_MAX_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
        if (bytesRead === 0) {
          break;
        }
        size += bytesRead;
      }
      if (size > CLOUD_ACCOUNT_IMPORT_MAX_BYTES) {
        throw new CloudAccountFileError('file-too-large');
      }
      content = bytes.subarray(0, size).toString('utf8');
    } finally {
      await file.close();
    }
  } catch (error) {
    throw error instanceof CloudAccountFileError ? error : new CloudAccountFileError('read-failed');
  }
  try {
    return await importCloudAccounts(content, strategy);
  } catch (error) {
    throw error instanceof CloudAccountFileError
      ? error
      : new CloudAccountFileError('import-failed');
  }
}

export async function exportCloudAccountFile(
  filePath: string,
  stripTokens: boolean,
): Promise<{ status: 'saved' }> {
  if (!CloudAccountExportFileInputSchema.safeParse({ filePath, stripTokens }).success) {
    throw new CloudAccountFileError('write-failed');
  }
  try {
    const content = await exportCloudAccounts(stripTokens);
    await writeFileAtomic(filePath, content, { mode: 0o600 });
    return { status: 'saved' };
  } catch {
    throw new CloudAccountFileError('write-failed');
  }
}
