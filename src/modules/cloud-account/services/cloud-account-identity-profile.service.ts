import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountDeviceBindingStore } from '@/modules/cloud-account/persistence/cloud-account-device-binding-store';
import {
  ensureGlobalOriginalFromCurrentStorage,
  generateDeviceProfile,
  loadGlobalOriginalProfile,
  readCurrentDeviceProfile,
  saveGlobalOriginalProfile,
} from '@/modules/identity-profile/ipc/handler';
import type { DeviceProfile, DeviceProfilesSnapshot } from '@/modules/identity-profile/types';
import { logger } from '@/shared/logging/logger';
import {
  CloudIdentityProfileError,
  classifyCloudIdentityProfileError,
} from './cloud-account-identity-profile.error';
import type { CloudIdentityProfileErrorCode } from './cloud-account-identity-profile.schema';

async function profileOperation<T>(
  operation: string,
  fallback: CloudIdentityProfileErrorCode,
  work: () => Promise<T> | T,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const profileCode = classifyCloudIdentityProfileError(error, fallback);
    logger.error('Cloud identity profile operation failed', { operation, profileCode });
    throw new CloudIdentityProfileError(profileCode);
  }
}

async function requireAccount(accountId: string) {
  const account = await CloudAccountRepo.getAccount(accountId);
  if (!account) {
    throw new CloudIdentityProfileError('account-not-found');
  }
  return account;
}

export function getCloudIdentityProfiles(accountId: string): Promise<DeviceProfilesSnapshot> {
  return profileOperation('snapshot', 'profile-operation-failed', async () => {
    const account = await requireAccount(accountId);
    let currentStorage: DeviceProfile | undefined;
    try {
      currentStorage = readCurrentDeviceProfile();
    } catch (error) {
      logger.warn('Failed to read current storage device profile', error);
    }
    return {
      currentStorage,
      boundProfile: account.device_profile,
      history: account.device_history || [],
      baseline: loadGlobalOriginalProfile() || undefined,
    };
  });
}

export function previewGenerateCloudIdentityProfile(): Promise<DeviceProfile> {
  return profileOperation('preview', 'profile-operation-failed', generateDeviceProfile);
}

export function bindCloudIdentityProfile(
  accountId: string,
  mode: 'capture' | 'generate',
): Promise<DeviceProfile> {
  return profileOperation('bind', 'profile-write-failed', async () => {
    const account = await requireAccount(accountId);
    const profile = mode === 'capture' ? readCurrentDeviceProfile() : generateDeviceProfile();
    ensureGlobalOriginalFromCurrentStorage();
    saveGlobalOriginalProfile(profile);
    CloudAccountDeviceBindingStore.setDeviceBinding(account.id, profile, mode);
    return profile;
  });
}

export function bindCloudIdentityProfileWithPayload(
  accountId: string,
  profile: DeviceProfile,
): Promise<DeviceProfile> {
  return profileOperation('bind-payload', 'profile-write-failed', async () => {
    const account = await requireAccount(accountId);
    ensureGlobalOriginalFromCurrentStorage();
    saveGlobalOriginalProfile(profile);
    CloudAccountDeviceBindingStore.setDeviceBinding(account.id, profile, 'generated');
    return profile;
  });
}

export function restoreCloudIdentityProfileRevision(
  accountId: string,
  versionId: string,
): Promise<DeviceProfile> {
  return profileOperation('restore-revision', 'profile-write-failed', () => {
    const baseline = loadGlobalOriginalProfile();
    return CloudAccountDeviceBindingStore.restoreDeviceVersion(accountId, versionId, baseline);
  });
}

export function restoreCloudBaselineProfile(accountId: string): Promise<DeviceProfile> {
  return profileOperation('restore-baseline', 'profile-write-failed', () => {
    const baseline = loadGlobalOriginalProfile();
    if (!baseline) {
      throw new CloudIdentityProfileError('baseline-unavailable');
    }
    return CloudAccountDeviceBindingStore.restoreDeviceVersion(accountId, 'baseline', baseline);
  });
}

export function deleteCloudIdentityProfileRevision(
  accountId: string,
  versionId: string,
): Promise<void> {
  return profileOperation('delete-revision', 'profile-write-failed', () => {
    CloudAccountDeviceBindingStore.deleteDeviceVersion(accountId, versionId);
  });
}
