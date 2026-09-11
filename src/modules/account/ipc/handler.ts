import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { isEqual } from 'lodash-es';
import {
  getAccountsFilePath,
  getBackupsDir,
  refreshAntigravityProcessCache,
} from '@/shared/platform/paths';
import { logger } from '@/shared/logging/logger';
import type { Account, AccountBackupData } from '@/modules/account/types';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import type {
  DeviceProfile,
  DeviceProfilesSnapshot,
  DeviceProfileVersion,
} from '@/modules/identity-profile/types';
import {
  backupAccount as dbBackup,
  extractCredentialStoreTokenFromBackup,
  restoreAccount as dbRestore,
  getCurrentAccountInfo,
} from '@/modules/account/persistence/antigravity-state-database';
import { CredentialStoreInjectionAdapter } from '@/modules/cloud-account/persistence/credential-store-injection-adapter';
import { writeAntigravityCredentialStoreToken } from '@/modules/cloud-account/persistence/antigravityCredentialStore';
import {
  applyDeviceProfile,
  ensureGlobalOriginalFromCurrentStorage,
  generateDeviceProfile,
  isIdentityProfileApplyEnabled,
  loadGlobalOriginalProfile,
  readCurrentDeviceProfile,
  saveGlobalOriginalProfile,
  getStorageDirectoryPath,
} from '@/modules/identity-profile/ipc/handler';
import { runWithSwitchGuard } from '@/modules/antigravity-runtime/switch/switchGuard';
import { executeSwitchFlow } from '@/modules/antigravity-runtime/switch/switchFlow';
import {
  mutateAccountIndex,
  readAccountIndex,
  type AccountIndex,
} from '@/modules/account/persistence/account-index-store';
import { shell } from 'electron';
import { withTimingTrace } from '@/shared/observability/timingTrace';

const SWITCH_EXIT_TIMEOUT_MS = 10000;

function getDeviceHistory(account: Account): DeviceProfileVersion[] {
  if (!account.deviceHistory) {
    account.deviceHistory = [];
  }
  return account.deviceHistory;
}

function bindDeviceProfileToAccount(
  account: Account,
  profile: DeviceProfile,
  label: string,
  addHistory: boolean,
): void {
  account.deviceProfile = profile;
  if (!addHistory) {
    return;
  }

  const history = getDeviceHistory(account);
  for (const version of history) {
    version.isCurrent = false;
  }

  history.push({
    id: uuidv4(),
    createdAt: Math.floor(Date.now() / 1000),
    label,
    profile,
    isCurrent: true,
  });
}

/**
 * Reads a detached accounts snapshot through the persistence transaction gate.
 */
function readAccountsIndex(): Promise<AccountIndex> {
  return readAccountIndex(getAccountsFilePath());
}

/**
 * Mutates the latest accounts index through the persistence transaction gate.
 */
function mutateAccountsIndex<T>(mutation: (draft: AccountIndex) => T): Promise<T> {
  return mutateAccountIndex(getAccountsFilePath(), mutation);
}

function sanitizeAccountId(accountId: string): string {
  return accountId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function getAccountOrThrow(accounts: AccountIndex, accountId: string): Account {
  const account = accounts[accountId];
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }
  return account;
}

/**
 * Lists the accounts data.
 * @returns {Account[]} The list of accounts.
 * @throws {Error} If the accounts index cannot be loaded.
 */
export async function listAccountsData(): Promise<Account[]> {
  const accountIndex = await readAccountsIndex();
  const accountList = Object.values(accountIndex);
  // NOTE: Sort by last_used descending
  accountList.sort((leftAccount, rightAccount) => {
    const leftLastUsed = leftAccount.last_used || '';
    const rightLastUsed = rightAccount.last_used || '';
    return rightLastUsed.localeCompare(leftLastUsed);
  });
  return accountList;
}

/**
 * Adds an account snapshot.
 * @returns {Account} The added account.
 * @throws {Error} If the account cannot be added.
 */
export async function addAccountSnapshot(): Promise<Account> {
  logger.info('Adding account snapshot...');
  await refreshAntigravityProcessCache();

  // NOTE Get current account info from DB
  const currentAccountInfo = getCurrentAccountInfo();
  if (!currentAccountInfo.isAuthenticated) {
    const message =
      'No authenticated account found. Please ensure Antigravity is running and you are logged in.';
    logger.error(message);
    throw new Error(message);
  }

  const accounts = await readAccountsIndex();
  const now = new Date().toISOString();

  // NOTE Find existing account by email
  let existingAccountId: string | null = null;
  for (const [accountId, existingAccount] of Object.entries(accounts)) {
    if (existingAccount.email === currentAccountInfo.email) {
      existingAccountId = accountId;
      break;
    }
  }

  let account: Account;
  let backupPath: string;

  if (existingAccountId) {
    // NOTE Update existing account
    account = accounts[existingAccountId];

    // NOTE Preserve custom name: only update if we have a name from DB AND it's not the default email prefix
    // NOTE  if not name or name == email.split("@")[0]: name = existing_account.get("name", name)
    const defaultName = currentAccountInfo.email.split('@')[0];
    if (!currentAccountInfo.name || currentAccountInfo.name === defaultName) {
      // NOTE Keep the existing custom name
      // (account.name is already set, no change needed)
    } else {
      // NOTE We have a non-default name from DB, use it
      account.name = currentAccountInfo.name;
    }

    account.last_used = now;

    // NOTE Use existing backup path if available, otherwise generate new one
    backupPath = account.backup_file || path.join(getBackupsDir(), `${account.id}.json`);

    logger.info(`Updating existing account: ${sanitizeAccountId(account.id)}`);
  } else {
    const accountId = uuidv4();

    // NOTE Generate name with edge case handling
    let accountName: string;
    if (currentAccountInfo.name) {
      accountName = currentAccountInfo.name;
    } else if (currentAccountInfo.email && currentAccountInfo.email !== 'Unknown') {
      accountName = currentAccountInfo.email.split('@')[0];
    } else {
      // Edge case: email is "Unknown" or invalid
      accountName = `Account_${Date.now()}`;
    }

    backupPath = path.join(getBackupsDir(), `${accountId}.json`);

    account = {
      id: accountId,
      name: accountName,
      email: currentAccountInfo.email,
      backup_file: backupPath,
      deviceHistory: [],
      created_at: now,
      last_used: now,
    };
    accounts[accountId] = account;
    logger.info(`Creating new account: ${sanitizeAccountId(accountId)}`);
  }

  // NOTE  Backup data from DB
  const backupData = dbBackup(account);

  // NOTE Save backup file
  const backupsDir = getBackupsDir();
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }
  fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));

  // NOTE Re-read the latest index before committing account metadata.
  return mutateAccountsIndex((latestAccounts) => {
    const latestAccount = Object.values(latestAccounts).find(
      (candidate) => candidate.email === currentAccountInfo.email,
    );

    if (latestAccount) {
      const defaultName = currentAccountInfo.email.split('@')[0];
      if (currentAccountInfo.name && currentAccountInfo.name !== defaultName) {
        latestAccount.name = currentAccountInfo.name;
      }
      latestAccount.last_used = now;
      latestAccount.backup_file = backupPath;
      return latestAccount;
    }

    account.backup_file = backupPath;
    latestAccounts[account.id] = account;
    return account;
  });
}

/**
 * Switches to an account.
 * @param accountId {string} The ID of the account to switch to.
 * @throws {Error} If the account cannot be found or the backup file cannot be found.
 */
export async function switchAccount(
  accountId: string,
  appTarget?: AntigravityAppTarget,
): Promise<void> {
  await runWithSwitchGuard('local-account-switch', async () => {
    const sanitizedAccountId = sanitizeAccountId(accountId);
    logger.info(`Switching to account: ${sanitizedAccountId}`);
    await withTimingTrace(
      'switch.local.prepare',
      {
        accountId: sanitizedAccountId,
        appTarget: appTarget || 'classic',
      },
      async (trace) => {
        await trace.phase('refreshProcessCacheMs', async () => {
          await refreshAntigravityProcessCache(appTarget);
        });
      },
    );

    const accounts = await readAccountsIndex();
    const account = getAccountOrThrow(accounts, accountId);
    const startingDeviceProfile = structuredClone(account.deviceProfile);
    const startingDeviceHistory = structuredClone(account.deviceHistory);
    let generatedIdentityState = false;

    // NOTE Get backup file path from account data
    const backupPath = account.backup_file || path.join(getBackupsDir(), `${accountId}.json`);

    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${backupPath}`);
    }

    if (appTarget !== 'agy') {
      ensureGlobalOriginalFromCurrentStorage(appTarget);
    }
    if (!account.deviceProfile) {
      const generated = generateDeviceProfile();
      saveGlobalOriginalProfile(generated);
      bindDeviceProfileToAccount(account, generated, 'auto_generated', true);
      generatedIdentityState = true;
    }

    const usesCredentialStore =
      CredentialStoreInjectionAdapter.shouldInjectTokenIntoCredentialStore(appTarget);

    await executeSwitchFlow({
      scope: 'local',
      appTarget,
      targetProfile: account.deviceProfile || null,
      applyFingerprint: isIdentityProfileApplyEnabled(),
      useCredentialStore: usesCredentialStore,
      processExitTimeoutMs: SWITCH_EXIT_TIMEOUT_MS,
      performSwitch: async () => {
        // NOTE Load backup file
        const backupContent = fs.readFileSync(backupPath, 'utf-8');
        const backupData: AccountBackupData = JSON.parse(backupContent);

        if (usesCredentialStore) {
          const token = extractCredentialStoreTokenFromBackup(backupData);
          if (appTarget === 'agy') {
            writeAntigravityCredentialStoreToken(token, {
              email: account.email,
              syncGoogleOAuthFiles: true,
            });
          } else {
            writeAntigravityCredentialStoreToken(token);
          }
        } else {
          // NOTE Restore data to DB
          dbRestore(backupData, appTarget);
        }
      },
      afterSwitchSuccess: async () => {
        const completedAt = new Date().toISOString();
        await mutateAccountsIndex((latestAccounts) => {
          const latestAccount = latestAccounts[accountId];
          if (!latestAccount) {
            logger.warn(`Account was deleted before switch completion: ${sanitizedAccountId}`);
            return;
          }

          latestAccount.last_used =
            latestAccount.last_used.localeCompare(completedAt) >= 0
              ? latestAccount.last_used
              : completedAt;

          if (!generatedIdentityState) {
            return;
          }

          const identitySnapshotUnchanged =
            isEqual(latestAccount.deviceProfile, startingDeviceProfile) &&
            isEqual(latestAccount.deviceHistory, startingDeviceHistory);
          if (!identitySnapshotUnchanged) {
            logger.warn(
              `Preserved newer account identity state after switch: ${sanitizedAccountId}`,
            );
            return;
          }

          latestAccount.deviceProfile = account.deviceProfile;
          latestAccount.deviceHistory = account.deviceHistory;
        });
      },
    });
  });
}

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

export async function openIdentityStorageFolder(): Promise<void> {
  const directory = getStorageDirectoryPath();
  const result = await shell.openPath(directory);
  if (result) {
    throw new Error(`Failed to open device folder: ${result}`);
  }
}

/**
 * Deletes an account.
 * @param accountId {string} The ID of the account to delete.
 * @throws {Error} If the account cannot be found or the backup file cannot be found.
 */
export async function deleteAccount(accountId: string): Promise<void> {
  logger.info(`Deleting account: ${sanitizeAccountId(accountId)}`);

  const account = getAccountOrThrow(await readAccountsIndex(), accountId);

  // NOTE Remove backup file using stored path
  const backupPath = account.backup_file || path.join(getBackupsDir(), `${accountId}.json`);

  if (fs.existsSync(backupPath)) {
    try {
      fs.unlinkSync(backupPath);
      logger.info(`Backup file deleted: ${backupPath}`);
    } catch (error) {
      logger.warn(`Failed to delete backup file: ${backupPath}`, error);
    }
  }

  // NOTE Deletion wins over any operation that retained an earlier detached snapshot.
  await mutateAccountsIndex((accounts) => {
    delete accounts[accountId];
  });
}
