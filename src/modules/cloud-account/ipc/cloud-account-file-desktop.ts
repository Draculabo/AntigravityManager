import { dialog } from 'electron';
import { getCloudAccountAdapter } from './cloud-account-adapter';
import type { ImportStrategy } from '../services/cloud-account-file.schema';
import { toCloudAccountFileORPCError } from '../services/cloud-account-file.error';

const filters = [{ name: 'JSON', extensions: ['json'] }];

export async function chooseAndImportCloudAccountFile(strategy: ImportStrategy) {
  // Capture the owner before the dialog yields; a selection change must not redirect work.
  const owner = getCloudAccountAdapter();
  try {
    const selection = await dialog.showOpenDialog({ filters, properties: ['openFile'] });
    if (selection.canceled || selection.filePaths.length === 0) {
      return { status: 'cancelled' as const };
    }
    const summary = await owner.importFile(selection.filePaths[0], strategy);
    return { status: 'imported' as const, ...summary };
  } catch (error) {
    throw toCloudAccountFileORPCError(error, 'import-failed');
  }
}

export async function chooseAndExportCloudAccountFile(stripTokens: boolean) {
  const owner = getCloudAccountAdapter();
  try {
    const selection = await dialog.showSaveDialog({
      filters,
      defaultPath: `cloud-accounts-export-${new Date().toISOString().split('T')[0]}.json`,
    });
    if (selection.canceled || !selection.filePath) {
      return { status: 'cancelled' as const };
    }
    return await owner.exportFile(selection.filePath, stripTokens);
  } catch (error) {
    throw toCloudAccountFileORPCError(error, 'write-failed');
  }
}
