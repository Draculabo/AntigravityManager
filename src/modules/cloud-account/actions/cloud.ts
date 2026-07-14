import { ipc } from '@/ipc/manager';
import type { AntigravityAppTarget } from '@/modules/account/types';
import type { DeviceProfile } from '@/modules/identity-profile/types';
import { isValidProxyUrl } from '@/shared/utils/url';

export function addGoogleAccount(input: { authCode: string; oauthClientKey?: string }) {
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

export function switchCloudAccount(input: { accountId: string; appTarget?: AntigravityAppTarget }) {
  return ipc.client.cloud.switchCloudAccount(input);
}

export function getAutoSwitchEnabled() {
  return ipc.client.cloud.getAutoSwitchEnabled();
}

export function setAutoSwitchEnabled(input: { enabled: boolean }) {
  return ipc.client.cloud.setAutoSwitchEnabled(input);
}

export async function getAutoSwitchModelsConfig(): Promise<
  Record<string, { enabled: boolean; priority: boolean }>
> {
  const result = await ipc.client.cloud.getAutoSwitchModelsConfig();
  return result as Record<string, { enabled: boolean; priority: boolean }>;
}

export function setAutoSwitchModelsConfig(
  config: Record<string, { enabled: boolean; priority: boolean }>,
) {
  return ipc.client.cloud.setAutoSwitchModelsConfig(config);
}

export function forcePollCloudMonitor() {
  return ipc.client.cloud.forcePollCloudMonitor();
}

export function syncLocalAccount(input?: { appTarget?: AntigravityAppTarget }) {
  return ipc.client.cloud.syncLocalAccount(input);
}

export interface OAuthClientDescriptor {
  key: string;
  label: string;
  client_id: string;
  is_active: boolean;
  is_builtin: boolean;
}

export function startAuthFlow(input?: { oauthClientKey?: string }) {
  return ipc.client.cloud.startAuthFlow(input);
}

export function listOAuthClients() {
  return ipc.client.cloud.listOAuthClients() as Promise<OAuthClientDescriptor[]>;
}

export async function getActiveOAuthClient() {
  const response = await ipc.client.cloud.getActiveOAuthClient();
  return response.client_key;
}

export function setActiveOAuthClient(input: { clientKey: string }) {
  return ipc.client.cloud.setActiveOAuthClient(input);
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
