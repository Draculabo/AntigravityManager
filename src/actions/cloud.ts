import { ipc } from '@/ipc/manager';
import type { DeviceProfile } from '@/types/account';
import { isValidProxyUrl } from '@/utils/url';

export function addGoogleAccount(input: { authCode: string }) {
  return ipc.client.cloud.addGoogleAccount(input);
}

export function listCloudAccounts() {
  return ipc.client.cloud.listCloudAccounts();
}

export function deleteCloudAccount(input: { accountId: string }) {
  return ipc.client.cloud.deleteCloudAccount(input);
}

export function refreshAccountQuota(input: { accountId: string }) {
  console.log(`[Action] Calling refreshAccountQuota for: ${input.accountId}`);
  return ipc.client.cloud.refreshAccountQuota(input);
}

export function switchCloudAccount(input: { accountId: string }) {
  return ipc.client.cloud.switchCloudAccount(input);
}

export function getAutoSwitchEnabled() {
  return ipc.client.cloud.getAutoSwitchEnabled();
}

export function setAutoSwitchEnabled(input: { enabled: boolean }) {
  return ipc.client.cloud.setAutoSwitchEnabled(input);
}

export function forcePollCloudMonitor() {
  return ipc.client.cloud.forcePollCloudMonitor();
}

export function syncLocalAccount() {
  return ipc.client.cloud.syncLocalAccount();
}

export function startAuthFlow() {
  return ipc.client.cloud.startAuthFlow();
}

export function getSwitchStatus() {
  return ipc.client.cloud.getSwitchStatus();
}

export function getCloudIdentityProfiles(input: { accountId: string }) {
  return ipc.client.cloud.getIdentityProfiles(input);
}

export function previewGenerateCloudIdentityProfile() {
  return ipc.client.cloud.previewIdentityProfile();
}

export function bindCloudIdentityProfile(input: {
  accountId: string;
  mode: 'capture' | 'generate';
}) {
  return ipc.client.cloud.bindIdentityProfile(input);
}

export function bindCloudIdentityProfileWithPayload(input: {
  accountId: string;
  profile: DeviceProfile;
}) {
  return ipc.client.cloud.bindIdentityProfileWithPayload(input);
}

export function restoreCloudIdentityProfileRevision(input: {
  accountId: string;
  versionId: string;
}) {
  return ipc.client.cloud.restoreIdentityProfileRevision(input);
}

export function restoreCloudBaselineProfile(input: { accountId: string }) {
  return ipc.client.cloud.restoreBaselineProfile(input);
}

export function deleteCloudIdentityProfileRevision(input: {
  accountId: string;
  versionId: string;
}) {
  return ipc.client.cloud.deleteIdentityProfileRevision(input);
}

export function openCloudIdentityStorageFolder() {
  return ipc.client.cloud.openIdentityStorageFolder();
}

export function setAccountProxy(input: { accountId: string; proxyUrl: string | null }) {
  if (input.proxyUrl && !isValidProxyUrl(input.proxyUrl)) {
    throw new Error('Invalid proxy URL format');
  }
  return ipc.client.cloud.setAccountProxy(input);
}

export function exportCloudAccounts(input: { stripTokens?: boolean }) {
  return ipc.client.cloud.exportCloudAccounts(input);
}

export function importCloudAccounts(input: {
  jsonContent: string;
  strategy?: 'merge' | 'overwrite' | 'skip-existing';
}) {
  try {
    JSON.parse(input.jsonContent);
  } catch {
    throw new Error('Invalid JSON content provided for import');
  }
  return ipc.client.cloud.importCloudAccounts(input);
}
