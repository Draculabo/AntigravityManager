import { prepareLaunchContext, prepareClientAccountWrite } from '@/modules/antigravity-runtime';
import { credentialsFromAccountBackup } from '../persistence/snapshotCredentials';
import {
  initializeAccountBackupKey,
  readAccountBackupFile,
  writeAccountBackupFile,
} from '../persistence/account-backup-file';
import { prepareDesktopIdentityStorage } from '@/modules/identity-profile/public';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { isEqual } from 'lodash-es';
import { getBackupsDir, refreshAntigravityProcessCache } from '@/shared/platform/paths';
import { logger } from '@/shared/logging/logger';
import type { Account } from '@/modules/account/types';
import { LocalAccountError } from './local-account.schema';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { backupAccount as dbBackup } from '@/modules/account/persistence/antigravity-state-database';
import { getCurrentAccountInfo } from './current-account.service';
import {
  ensureGlobalOriginalFromCurrentStorage,
  generateDeviceProfile,
  isIdentityProfileApplyEnabled,
  saveGlobalOriginalProfile,
} from '@/modules/identity-profile/ipc/handler';
import { runWithSwitchGuard } from '@/modules/antigravity-runtime/switch/switchGuard';
import { executeSwitchFlow } from '@/modules/antigravity-runtime/switch/switchFlow';
import {
  bindDeviceProfileToAccount,
  readAccountsIndex,
  mutateAccountsIndex,
  sanitizeAccountId,
  getAccountOrThrow,
} from './local-account-index.service';
import { withTimingTrace } from '@/shared/observability/timingTrace';

const SWITCH_EXIT_TIMEOUT_MS = 10000;

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
export async function addAccountSnapshot(appTarget?: AntigravityAppTarget): Promise<Account> {
  logger.info('Adding account snapshot...');
  await refreshAntigravityProcessCache();

  // NOTE Get current account info from DB
  const pathOptions =
    appTarget === 'agy' ? undefined : await prepareDesktopIdentityStorage(appTarget);
  const currentAccountInfo = await getCurrentAccountInfo(appTarget, pathOptions);
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
  const backupData = await dbBackup(account, appTarget, pathOptions);

  await initializeAccountBackupKey(
    Object.values(accounts).flatMap((saved) => (saved.backup_file ? [saved.backup_file] : [])),
  );
  await writeAccountBackupFile(backupPath, backupData);

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
  await runWithSwitchGuard(
    'local-account-switch',
    async () => {
      const sanitizedAccountId = sanitizeAccountId(accountId);
      logger.info(`Switching to account: ${sanitizedAccountId}`);
      const accounts = await readAccountsIndex();
      const account = getAccountOrThrow(accounts, accountId);
      const startingDeviceProfile = structuredClone(account.deviceProfile);
      const startingDeviceHistory = structuredClone(account.deviceHistory);
      let generatedIdentityState = false;

      // NOTE Get backup file path from account data
      const backupPath = account.backup_file || path.join(getBackupsDir(), `${accountId}.json`);

      if (!fs.existsSync(backupPath)) {
        throw new LocalAccountError('snapshot-not-found');
      }

      const backup = await readAccountBackupFile(backupPath);
      if (backup.account.email.trim().toLowerCase() !== account.email.trim().toLowerCase()) {
        throw new Error('Account backup identity does not match the selected account');
      }
      const credentials = credentialsFromAccountBackup(backup);

      const launchContext =
        appTarget === 'agy'
          ? undefined
          : await withTimingTrace(
              'switch.local.prepare',
              { accountId: sanitizedAccountId, appTarget: appTarget || 'classic' },
              (trace) =>
                trace.phase('preflightMs', () =>
                  prepareLaunchContext(appTarget === 'ide' ? 'ide' : 'classic'),
                ),
            );
      const preparedWrite = await prepareClientAccountWrite(
        credentials,
        appTarget,
        launchContext?.pathOptions,
      );
      if (appTarget !== 'agy') {
        ensureGlobalOriginalFromCurrentStorage(appTarget, launchContext?.pathOptions);
      }
      if (!account.deviceProfile) {
        const generated = generateDeviceProfile();
        saveGlobalOriginalProfile(generated);
        bindDeviceProfileToAccount(account, generated, 'auto_generated', true);
        generatedIdentityState = true;
      }

      await executeSwitchFlow({
        scope: 'local',
        launchContext,
        appTarget,
        targetProfile: account.deviceProfile || null,
        applyFingerprint: isIdentityProfileApplyEnabled(),
        useCredentialStore: preparedWrite.storage === 'credential-store',
        processExitTimeoutMs: SWITCH_EXIT_TIMEOUT_MS,
        performSwitch: preparedWrite.write,
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
    },
    appTarget,
  );
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
