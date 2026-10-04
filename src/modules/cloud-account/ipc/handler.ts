import { shell } from 'electron';
import { getStorageDirectoryPath } from '@/modules/identity-profile/ipc/handler';
export { refreshAccountQuotaForDesktop as refreshAccountQuota } from './quota-refresh-desktop';

export async function openCloudIdentityStorageFolder(): Promise<void> {
  const directory = getStorageDirectoryPath();
  const result = await shell.openPath(directory);
  if (result) {
    throw new Error(`Failed to open identity storage: ${result}`);
  }
}
