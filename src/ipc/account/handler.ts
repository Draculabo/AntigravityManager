import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { getAccountsFilePath, getBackupsDir } from "../../utils/paths";
import { logger } from "../../utils/logger";
import { Account, AccountBackupData } from "../../types/account";
import {
  backupAccount as dbBackup,
  restoreAccount as dbRestore,
  getCurrentAccountInfo,
} from "../database/handler";
import { closeAntigravity, startAntigravity } from "../process/handler";

// Account index is stored as object with IDs as keys (matching Python)
type AccountIndex = Record<string, Account>;

// Helper to load accounts index
function loadAccountsIndex(): AccountIndex {
  const filePath = getAccountsFilePath();
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    logger.error("Failed to load accounts index", error);
    return {};
  }
}

// Helper to save accounts index
function saveAccountsIndex(accounts: AccountIndex): void {
  const filePath = getAccountsFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(accounts, null, 2));
  } catch (error) {
    logger.error("Failed to save accounts index", error);
    throw error;
  }
}

export async function listAccountsData(): Promise<Account[]> {
  const accountsObj = loadAccountsIndex();
  const accountsList = Object.values(accountsObj);
  // Sort by last_used descending (matching Python)
  accountsList.sort((a, b) => {
    const aTime = a.last_used || "";
    const bTime = b.last_used || "";
    return bTime.localeCompare(aTime);
  });
  return accountsList;
}

export async function addAccountSnapshot(): Promise<Account> {
  logger.info("Adding account snapshot...");

  // 1. Get current account info from DB
  const info = getCurrentAccountInfo();
  if (!info.isAuthenticated) {
    const errorMsg =
      "No authenticated account found. Please ensure Antigravity is running and you are logged in.";
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  const accounts = loadAccountsIndex();
  const now = new Date().toISOString();

  // Find existing account by email
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
    // Update existing account
    account = accounts[existingId];

    // Preserve custom name: only update if we have a name from DB AND it's not the default email prefix
    // This matches Python logic: if not name or name == email.split("@")[0]: name = existing_account.get("name", name)
    const defaultName = info.email.split("@")[0];
    if (!info.name || info.name === defaultName) {
      // Keep the existing custom name
      // (account.name is already set, no change needed)
    } else {
      // We have a non-default name from DB, use it
      account.name = info.name;
    }

    account.last_used = now;

    // Use existing backup path if available, otherwise generate new one
    backupPath = account.backup_file || path.join(getBackupsDir(), `${account.id}.json`);

    logger.info(`Updating existing account: ${info.email}`);
  } else {
    // Create new account
    const accountId = uuidv4();

    // Generate name with edge case handling (matching Python)
    let accountName: string;
    if (info.name) {
      accountName = info.name;
    } else if (info.email && info.email !== "Unknown") {
      accountName = info.email.split("@")[0];
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

  // 2. Backup data from DB
  const backupData = dbBackup(account);

  // 3. Save backup file
  const backupsDir = getBackupsDir();
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }
  fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));

  // 4. Update backup_file in account object and save
  account.backup_file = backupPath;
  saveAccountsIndex(accounts);

  return account;
}

export async function switchAccount(accountId: string): Promise<void> {
  logger.info(`Switching to account: ${accountId}`);

  const accounts = loadAccountsIndex();
  const account = accounts[accountId];
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  // Get backup file path from account data (matching Python)
  const backupPath = account.backup_file || path.join(getBackupsDir(), `${accountId}.json`);

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  // 1. Close Antigravity (with error handling - matching Python)
  try {
    await closeAntigravity();
  } catch (error) {
    // Continue even if close fails (matching Python behavior)
    logger.warn("Unable to close Antigravity, attempting forced restore...", error);
  }

  // 2. Load backup file
  const backupContent = fs.readFileSync(backupPath, "utf-8");
  const backupData: AccountBackupData = JSON.parse(backupContent);

  // 3. Restore data to DB
  dbRestore(backupData);

  // 4. Update last used
  account.last_used = new Date().toISOString();
  saveAccountsIndex(accounts);

  // 5. Start Antigravity
  await startAntigravity();
}

export async function deleteAccount(accountId: string): Promise<void> {
  logger.info(`Deleting account: ${accountId}`);

  const accounts = loadAccountsIndex();
  const account = accounts[accountId];
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  // 1. Remove backup file using stored path (matching Python)
  const backupPath = account.backup_file || path.join(getBackupsDir(), `${accountId}.json`);

  if (fs.existsSync(backupPath)) {
    try {
      fs.unlinkSync(backupPath);
      logger.info(`Backup file deleted: ${backupPath}`);
    } catch (error) {
      logger.warn(`Failed to delete backup file: ${backupPath}`, error);
    }
  }

  // 2. Remove from index
  delete accounts[accountId];
  saveAccountsIndex(accounts);
}
