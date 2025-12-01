import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getAccountsFilePath, getBackupsDir } from '../../utils/paths';
import { logger } from '../../utils/logger';
import { Account, AccountBackupData } from '../../types/account';
import {
  backupAccount as dbBackup,
  restoreAccount as dbRestore,
  getCurrentAccountInfo,
} from '../database/handler';
import { closeAntigravity, startAntigravity } from '../process/handler';

type AccountIndex = Record<string, Account>;

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

  // NOTE Close Antigravity (with error handling)
  try {
    await closeAntigravity();
  } catch (error) {
    // NOTE Continue even if close fails
    logger.warn('Unable to close Antigravity, attempting forced restore...', error);
  }

  // NOTE Load backup file
  const backupContent = fs.readFileSync(backupPath, 'utf-8');
  const backupData: AccountBackupData = JSON.parse(backupContent);

  // NOTE Restore data to DB
  dbRestore(backupData);

  // NOTE Update last used
  account.last_used = new Date().toISOString();
  saveAccountsIndex(accounts);

  // NOTE Start Antigravity
  await startAntigravity();
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
