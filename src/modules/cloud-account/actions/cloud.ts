import { ipc } from '@/ipc/manager';
import type { SetCloudAccountRoutingInput } from '../services/cloud-account-routing.schema';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import type { DeviceProfile } from '@/modules/identity-profile/types';
import { isValidProxyUrl } from '@/shared/utils/url';
import type { WeeklyWarmupConfig } from '@/modules/cloud-account/services/weekly-warmup-contract';
import type {
  FetchAccountProjectIdInput,
  GetAccountProjectIdInput,
  SetAccountProjectIdInput,
} from '../services/cloud-account-project-id.schema';

export function listCloudAccounts() {
  return ipc.client.cloud.listCloudAccounts();
}

export function deleteCloudAccount(input: { accountId: string }) {
  return ipc.client.cloud.deleteCloudAccount(input);
}

export function getAccountProjectId(input: GetAccountProjectIdInput) {
  return ipc.client.cloud.getAccountProjectId(input);
}

export function setAccountProjectId(input: SetAccountProjectIdInput) {
  return ipc.client.cloud.setAccountProjectId(input);
}

export function fetchAccountProjectId(input: FetchAccountProjectIdInput) {
  return ipc.client.cloud.fetchAccountProjectId(input);
}

export function openAccountValidationLink(input: { accountId: string }) {
  return ipc.client.cloud.openAccountValidationLink(input);
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

export function getWeeklyWarmupConfig() {
  return ipc.client.cloud.getWeeklyWarmupConfig();
}

export function setWeeklyWarmupConfig(config: WeeklyWarmupConfig) {
  return ipc.client.cloud.setWeeklyWarmupConfig(config);
}

export function prepareOAuthSession(oauthClientKey?: string) {
  return ipc.client.cloud.oauthSession.prepare(oauthClientKey ? { oauthClientKey } : {});
}

export function openOAuthSession(sessionId: string) {
  return ipc.client.cloud.oauthSession.open({ sessionId });
}

export function copyOAuthSessionLink(sessionId: string) {
  return ipc.client.cloud.oauthSession.copy({ sessionId });
}

export function waitForOAuthSession(sessionId: string) {
  return ipc.client.cloud.oauthSession.wait({ sessionId });
}

export function submitOAuthSessionCallback(sessionId: string, code: string) {
  return ipc.client.cloud.oauthSession.submit({ sessionId, code });
}

export function cancelOAuthSession(sessionId: string) {
  return ipc.client.cloud.oauthSession.cancel({ sessionId });
}

export function importCloudAccountRefreshToken(refreshToken: string, oauthClientKey?: string) {
  return ipc.client.cloud.credentialImport.importToken({ refreshToken, oauthClientKey });
}

export function listOAuthClients() {
  return ipc.client.cloud.listOAuthClients();
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

export function setAccountRouting(input: SetCloudAccountRoutingInput) {
  return ipc.client.cloud.setAccountRouting(input);
}

export function exportCloudAccounts(input: { stripTokens?: boolean }) {
  return ipc.client.cloud.exportCloudAccounts(input);
}

export function importCloudAccounts(input: { strategy?: 'merge' | 'overwrite' | 'skip-existing' }) {
  return ipc.client.cloud.importCloudAccounts(input);
}
