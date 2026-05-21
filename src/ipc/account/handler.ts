import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getAccountsFilePath, getBackupsDir } from '../../utils/paths';
import { logger } from '../../utils/logger';
import {
  Account,
  AccountBackupData,
  DeviceProfile,
  DeviceProfilesSnapshot,
  DeviceProfileVersion,
} from '../../types/account';
import {
  backupAccount as dbBackup,
  restoreAccount as dbRestore,
  getCurrentAccountInfo,
} from '../database/handler';
import {
  applyDeviceProfile,
  ensureGlobalOriginalFromCurrentStorage,
  generateDeviceProfile,
  isIdentityProfileApplyEnabled,
  loadGlobalOriginalProfile,
  readCurrentDeviceProfile,
  saveGlobalOriginalProfile,
  getStorageDirectoryPath,
} from '../device/handler';
import { runWithSwitchGuard } from '../switchGuard';
import { executeSwitchFlow } from '../switchFlow';
import { shell } from 'electron';
import { ConfigManager } from '../config/manager';

type AccountIndex = Record<string, Account>;
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
 * Loads the accounts index from the file system.
 * @returns {AccountIndex} The accounts index.
 */
function loadAccountsIndex(): AccountIndex {
  const filePath = getAccountsFilePath();
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    logger.error('Failed to load accounts index', error);
    return {};
  }
}

/**
 * Saves the accounts index to the file system.
 * @param accounts {AccountIndex} The accounts index to save.
 * @throws {Error} If the accounts index cannot be saved.
 */
function saveAccountsIndex(accounts: AccountIndex): void {
  const filePath = getAccountsFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(accounts, null, 2));
  } catch (error) {
    logger.error('Failed to save accounts index', error);
    throw error;
  }
}

/**
 * Lists the accounts data.
 * @returns {Account[]} The list of accounts.
 * @throws {Error} If the accounts index cannot be loaded.
 */
export async function listAccountsData(): Promise<Account[]> {
  const accountsObj = loadAccountsIndex();
  const accountsList = Object.values(accountsObj);
  // NOTE: Sort by last_used descending
  accountsList.sort((a, b) => {
    const aTime = a.last_used || '';
    const bTime = b.last_used || '';
    return bTime.localeCompare(aTime);
  });
  return accountsList;
}

/**
 * Adds an account snapshot.
 * @returns {Account} The added account.
 * @throws {Error} If the account cannot be added.
 */
export async function addAccountSnapshot(): Promise<Account> {
  logger.info('Adding account snapshot...');

  // NOTE Get current account info from DB
  const info = getCurrentAccountInfo();
  if (!info.isAuthenticated) {
    const errorMsg =
      'No authenticated account found. Please ensure Antigravity is running and you are logged in.';
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  const accounts = loadAccountsIndex();
  const now = new Date().toISOString();

  // NOTE Find existing account by email
  let existingId: string | null = null;
  for (const [id, acc] of Object.entries(accounts)) {
    if (acc.email === info.email) {
      existingId = id;
      break;
    }
  }

  let account: Account;
  let backupPath: string;

  if (existingId) {
    // NOTE Update existing account
    account = accounts[existingId];

    // NOTE Preserve custom name: only update if we have a name from DB AND it's not the default email prefix
    // NOTE  if not name or name == email.split("@")[0]: name = existing_account.get("name", name)
    const defaultName = info.email.split('@')[0];
    if (!info.name || info.name === defaultName) {
      // NOTE Keep the existing custom name
      // (account.name is already set, no change needed)
    } else {
      // NOTE We have a non-default name from DB, use it
      account.name = info.name;
    }

    account.last_used = now;

    // NOTE Use existing backup path if available, otherwise generate new one
    backupPath = account.backup_file || path.join(getBackupsDir(), `${account.id}.json`);

    logger.info(`Updating existing account: ${info.email}`);
  } else {
    const accountId = uuidv4();

    // NOTE Generate name with edge case handling
    let accountName: string;
    if (info.name) {
      accountName = info.name;
    } else if (info.email && info.email !== 'Unknown') {
      accountName = info.email.split('@')[0];
    } else {
      // Edge case: email is "Unknown" or invalid
      accountName = `Account_${Date.now()}`;
    }

    backupPath = path.join(getBackupsDir(), `${accountId}.json`);

    account = {
      id: accountId,
      name: accountName,
      email: info.email,
      backup_file: backupPath,
      deviceHistory: [],
      created_at: now,
      last_used: now,
    };
    accounts[accountId] = account;
    logger.info(`Creating new account: ${info.email}`);
  }

  // NOTE  Backup data from DB
  const backupData = dbBackup(account);

  // NOTE Save backup file
  const backupsDir = getBackupsDir();
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }
  fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));

  // NOTE Update backup_file in account object and save
  account.backup_file = backupPath;
  saveAccountsIndex(accounts);

  return account;
}

/**
 * Switches to an account.
 * @param accountId {string} The ID of the account to switch to.
 * @throws {Error} If the account cannot be found or the backup file cannot be found.
 */
export async function switchAccount(accountId: string): Promise<void> {
  await runWithSwitchGuard('local-account-switch', async () => {
    logger.info(`Switching to account: ${accountId}`);

    const accounts = loadAccountsIndex();
    const account = accounts[accountId];
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    // NOTE Get backup file path from account data
    const backupPath = account.backup_file || path.join(getBackupsDir(), `${accountId}.json`);

    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${backupPath}`);
    }

    ensureGlobalOriginalFromCurrentStorage();
    if (!account.deviceProfile) {
      const generated = generateDeviceProfile();
      saveGlobalOriginalProfile(generated);
      bindDeviceProfileToAccount(account, generated, 'auto_generated', true);
    }

    await executeSwitchFlow({
      scope: 'local',
      targetProfile: account.deviceProfile || null,
      applyFingerprint: isIdentityProfileApplyEnabled(),
      processExitTimeoutMs: SWITCH_EXIT_TIMEOUT_MS,
      edition: ConfigManager.getCachedConfig()?.ideEdition || undefined,
      performSwitch: async (edition) => {
        // NOTE Load backup file
        const backupContent = fs.readFileSync(backupPath, 'utf-8');
        const backupData: AccountBackupData = JSON.parse(backupContent);

        // NOTE Restore data to DB
        dbRestore(backupData, edition);

        // NOTE Update last used
        account.last_used = new Date().toISOString();
        saveAccountsIndex(accounts);
      },
    });
  });
}

export async function previewGenerateIdentityProfile(): Promise<DeviceProfile> {
  return generateDeviceProfile();
}

export async function getIdentityProfiles(accountId: string): Promise<DeviceProfilesSnapshot> {
  const accounts = loadAccountsIndex();
  const account = accounts[accountId];
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

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
  const accounts = loadAccountsIndex();
  const account = accounts[accountId];
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  let profile: DeviceProfile;
  if (mode === 'capture') {
    profile = readCurrentDeviceProfile();
  } else {
    profile = generateDeviceProfile();
  }

  ensureGlobalOriginalFromCurrentStorage();
  saveGlobalOriginalProfile(profile);
  applyDeviceProfile(profile);
  bindDeviceProfileToAccount(account, profile, mode, true);
  saveAccountsIndex(accounts);
  return profile;
}

export async function bindIdentityProfileWithPayload(
  accountId: string,
  profile: DeviceProfile,
): Promise<DeviceProfile> {
  const accounts = loadAccountsIndex();
  const account = accounts[accountId];
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  ensureGlobalOriginalFromCurrentStorage();
  saveGlobalOriginalProfile(profile);
  applyDeviceProfile(profile);
  bindDeviceProfileToAccount(account, profile, 'generated', true);
  saveAccountsIndex(accounts);
  return profile;
}

export async function applyBoundIdentityProfile(accountId: string): Promise<DeviceProfile> {
  const accounts = loadAccountsIndex();
  const account = accounts[accountId];
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }
  if (!account.deviceProfile) {
    throw new Error('Account has no bound device profile');
  }

  applyDeviceProfile(account.deviceProfile);
  account.last_used = new Date().toISOString();
  saveAccountsIndex(accounts);
  return account.deviceProfile;
}

export async function restoreIdentityProfileRevision(
  accountId: string,
  versionId: string,
): Promise<DeviceProfile> {
  const accounts = loadAccountsIndex();
  const account = accounts[accountId];
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  let targetProfile: DeviceProfile | null = null;
  if (versionId === 'baseline') {
    targetProfile = loadGlobalOriginalProfile();
    if (!targetProfile) {
      throw new Error('Global original profile not found');
    }
    for (const version of getDeviceHistory(account)) {
      version.isCurrent = false;
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
    for (const version of history) {
      version.isCurrent = version.id === versionId;
    }
  }

  applyDeviceProfile(targetProfile);
  account.deviceProfile = targetProfile;
  saveAccountsIndex(accounts);
  return targetProfile;
}

export async function deleteIdentityProfileRevision(
  accountId: string,
  versionId: string,
): Promise<void> {
  if (versionId === 'baseline') {
    throw new Error('Original profile cannot be deleted');
  }

  const accounts = loadAccountsIndex();
  const account = accounts[accountId];
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  const history = getDeviceHistory(account);
  if (history.some((version) => version.id === versionId && version.isCurrent)) {
    throw new Error('Currently bound profile cannot be deleted');
  }

  const before = history.length;
  account.deviceHistory = history.filter((version) => version.id !== versionId);
  if (account.deviceHistory.length === before) {
    throw new Error('Historical device profile not found');
  }

  saveAccountsIndex(accounts);
}

export async function restoreBaselineProfile(accountId: string): Promise<DeviceProfile> {
  const accounts = loadAccountsIndex();
  const account = accounts[accountId];
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  const baseline = loadGlobalOriginalProfile();
  if (!baseline) {
    throw new Error('Global original profile not found');
  }

  account.deviceProfile = baseline;
  for (const version of getDeviceHistory(account)) {
    version.isCurrent = false;
  }
  saveAccountsIndex(accounts);

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
  logger.info(`Deleting account: ${accountId}`);

  const accounts = loadAccountsIndex();
  const account = accounts[accountId];
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

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

  // NOTE Remove from index
  delete accounts[accountId];
  saveAccountsIndex(accounts);
}
