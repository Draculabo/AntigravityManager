import { shell } from 'electron';
import { getStorageDirectoryPath } from '@/modules/identity-profile/ipc/handler';

export async function openIdentityStorageFolder(): Promise<void> {
  const directory = getStorageDirectoryPath();
  const result = await shell.openPath(directory);
  if (result) {
    throw new Error(`Failed to open device folder: ${result}`);
  }
}
