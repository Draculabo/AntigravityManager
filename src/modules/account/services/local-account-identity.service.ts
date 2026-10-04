import type { DeviceProfile, DeviceProfilesSnapshot } from '@/modules/identity-profile/types';
import { logger } from '@/shared/logging/logger';
import {
  applyDeviceProfile,
  ensureGlobalOriginalFromCurrentStorage,
  generateDeviceProfile,
  loadGlobalOriginalProfile,
  readCurrentDeviceProfile,
  saveGlobalOriginalProfile,
} from '@/modules/identity-profile/ipc/handler';
import {
  getDeviceHistory,
  bindDeviceProfileToAccount,
  readAccountsIndex,
  mutateAccountsIndex,
  getAccountOrThrow,
} from './local-account-index.service';
export async function previewGenerateIdentityProfile(): Promise<DeviceProfile> {
  return generateDeviceProfile();
}

export async function getIdentityProfiles(accountId: string): Promise<DeviceProfilesSnapshot> {
  const accounts = await readAccountsIndex();
  const account = getAccountOrThrow(accounts, accountId);

  let currentStorage: DeviceProfile | undefined;
  try {
    currentStorage = readCurrentDeviceProfile();
  } catch (error) {
    logger.warn('Failed to read current storage device profile', error);
  }

  return {
    currentStorage,
    boundProfile: account.deviceProfile,
    history: account.deviceHistory || [],
    baseline: loadGlobalOriginalProfile() || undefined,
  };
}

export async function bindIdentityProfile(
  accountId: string,
  mode: 'capture' | 'generate',
): Promise<DeviceProfile> {
  getAccountOrThrow(await readAccountsIndex(), accountId);

  let profile: DeviceProfile;
  if (mode === 'capture') {
    profile = readCurrentDeviceProfile();
  } else {
    profile = generateDeviceProfile();
  }

  ensureGlobalOriginalFromCurrentStorage();
  saveGlobalOriginalProfile(profile);
  applyDeviceProfile(profile);
  await mutateAccountsIndex((accounts) => {
    bindDeviceProfileToAccount(getAccountOrThrow(accounts, accountId), profile, mode, true);
  });
  return profile;
}

export async function bindIdentityProfileWithPayload(
  accountId: string,
  profile: DeviceProfile,
): Promise<DeviceProfile> {
  getAccountOrThrow(await readAccountsIndex(), accountId);

  ensureGlobalOriginalFromCurrentStorage();
  saveGlobalOriginalProfile(profile);
  applyDeviceProfile(profile);
  await mutateAccountsIndex((accounts) => {
    bindDeviceProfileToAccount(getAccountOrThrow(accounts, accountId), profile, 'generated', true);
  });
  return profile;
}

export async function applyBoundIdentityProfile(accountId: string): Promise<DeviceProfile> {
  const account = getAccountOrThrow(await readAccountsIndex(), accountId);
  if (!account.deviceProfile) {
    throw new Error('Account has no bound device profile');
  }

  applyDeviceProfile(account.deviceProfile);
  const completedAt = new Date().toISOString();
  await mutateAccountsIndex((accounts) => {
    const latestAccount = getAccountOrThrow(accounts, accountId);
    latestAccount.last_used =
      latestAccount.last_used.localeCompare(completedAt) >= 0
        ? latestAccount.last_used
        : completedAt;
  });
  return account.deviceProfile;
}

export async function restoreIdentityProfileRevision(
  accountId: string,
  versionId: string,
): Promise<DeviceProfile> {
  const account = getAccountOrThrow(await readAccountsIndex(), accountId);

  let targetProfile: DeviceProfile | null = null;
  if (versionId === 'baseline') {
    targetProfile = loadGlobalOriginalProfile();
    if (!targetProfile) {
      throw new Error('Global original profile not found');
    }
  } else if (versionId === 'current') {
    targetProfile = account.deviceProfile || null;
    if (!targetProfile) {
      throw new Error('No currently bound profile');
    }
  } else {
    const history = getDeviceHistory(account);
    const targetVersion = history.find((version) => version.id === versionId);
    if (!targetVersion) {
      throw new Error('Device profile version not found');
    }
    targetProfile = targetVersion.profile;
  }

  applyDeviceProfile(targetProfile);
  await mutateAccountsIndex((accounts) => {
    const latestAccount = getAccountOrThrow(accounts, accountId);
    if (versionId === 'baseline') {
      for (const version of getDeviceHistory(latestAccount)) {
        version.isCurrent = false;
      }
    } else if (versionId !== 'current') {
      const history = getDeviceHistory(latestAccount);
      if (!history.some((version) => version.id === versionId)) {
        throw new Error('Device profile version not found');
      }
      for (const version of history) {
        version.isCurrent = version.id === versionId;
      }
    }

    latestAccount.deviceProfile = targetProfile;
  });
  return targetProfile;
}

export async function deleteIdentityProfileRevision(
  accountId: string,
  versionId: string,
): Promise<void> {
  if (versionId === 'baseline') {
    throw new Error('Original profile cannot be deleted');
  }

  await mutateAccountsIndex((accounts) => {
    const account = getAccountOrThrow(accounts, accountId);
    const history = getDeviceHistory(account);
    if (history.some((version) => version.id === versionId && version.isCurrent)) {
      throw new Error('Currently bound profile cannot be deleted');
    }

    const before = history.length;
    account.deviceHistory = history.filter((version) => version.id !== versionId);
    if (account.deviceHistory.length === before) {
      throw new Error('Historical device profile not found');
    }
  });
}

export async function restoreBaselineProfile(accountId: string): Promise<DeviceProfile> {
  getAccountOrThrow(await readAccountsIndex(), accountId);

  const baseline = loadGlobalOriginalProfile();
  if (!baseline) {
    throw new Error('Global original profile not found');
  }

  await mutateAccountsIndex((accounts) => {
    const account = getAccountOrThrow(accounts, accountId);
    account.deviceProfile = baseline;
    for (const version of getDeviceHistory(account)) {
      version.isCurrent = false;
    }
  });

  return baseline;
}
