import { ipc } from '@/ipc/manager';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import type { DeviceProfile } from '@/modules/identity-profile/types';

export function listAccounts() {
  return ipc.client.account.listAccounts();
}

export function addAccountSnapshot() {
  return ipc.client.account.addAccountSnapshot();
}

export function switchAccount(accountId: string, appTarget?: AntigravityAppTarget) {
  return ipc.client.account.switchAccount({ accountId, appTarget });
}

export function deleteAccount(accountId: string) {
  return ipc.client.account.deleteAccount({ accountId });
}

export function previewGenerateIdentityProfile() {
  return ipc.client.account.previewGenerateIdentityProfile();
}

export function getIdentityProfiles(accountId: string) {
  return ipc.client.account.getIdentityProfiles({ accountId });
}

export function bindIdentityProfile(accountId: string, mode: 'capture' | 'generate') {
  return ipc.client.account.bindIdentityProfile({ accountId, mode });
}

export function bindIdentityProfileWithPayload(accountId: string, profile: DeviceProfile) {
  return ipc.client.account.bindIdentityProfileWithPayload({ accountId, profile });
}

export function applyBoundIdentityProfile(accountId: string) {
  return ipc.client.account.applyBoundIdentityProfile({ accountId });
}

export function restoreIdentityProfileRevision(accountId: string, versionId: string) {
  return ipc.client.account.restoreIdentityProfileRevision({ accountId, versionId });
}

export function deleteIdentityProfileRevision(accountId: string, versionId: string) {
  return ipc.client.account.deleteIdentityProfileRevision({ accountId, versionId });
}

export function restoreBaselineProfile(accountId: string) {
  return ipc.client.account.restoreBaselineProfile({ accountId });
}

export function openIdentityStorageFolder() {
  return ipc.client.account.openIdentityStorageFolder();
}
