import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { isString } from 'lodash-es';
import type { AccountBackupData, AccountInfo } from '@/modules/account/types';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { ItemTableValueRowSchema, type ItemTableKey } from '@/shared/persistence/database/types';
import { logger } from '@/shared/logging/logger';
import { getAntigravityDbPaths } from '@/shared/platform/paths';
import { parseRow } from '@/shared/persistence/database/sqlite';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
import { openDrizzleConnection } from '@/shared/persistence/database/dbConnection';
import { itemTable } from '@/shared/persistence/database/schema';
import type { CredentialStoreTokenInput } from '@/shared/auth/credentialStoreToken';

const KEYS_TO_BACKUP: ItemTableKey[] = [
  'antigravityAuthStatus',
  'jetskiStateSync.agentManagerInitState',
  'antigravityUnifiedStateSync.oauthToken',
];

function openAntigravityStateDb(
  dbPath: string,
  readOnly = false,
): ReturnType<typeof openDrizzleConnection> {
  return openDrizzleConnection(
    dbPath,
    { readonly: readOnly, fileMustExist: false },
    { readOnly, busyTimeoutMs: 3000 },
  );
}

/**
 * Initializes the database and ensures WAL mode is enabled.
 * Should be called on application startup.
 */
export function initDatabase(): void {
  try {
    const dbPaths = getAntigravityDbPaths();
    if (dbPaths.length === 0) {
      return;
    }

    const { raw } = getDatabaseConnection(undefined);
    raw.close();
    logger.info('Database initialized and verified (WAL mode)');
  } catch (error) {
    logger.error('Failed to initialize database on startup', error);
  }
}

/**
 * Ensures that the database file exists.
 * @param dbPath {string} The path to the database file.
 * @returns {void}
 */
function ensureDatabaseExists(dbPath: string): void {
  if (fs.existsSync(dbPath)) {
    return;
  }

  logger.info(`Database file not found at ${dbPath}. Creating new database...`);

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    // NOTE Initialize schema
    db.exec(`
      CREATE TABLE IF NOT EXISTS ItemTable (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    logger.info('Created new database with ItemTable schema.');
  } catch (error) {
    logger.error('Failed to create new database', error);
    throw error;
  } finally {
    if (db) db.close();
  }
}

/**
 * Gets a database connection.
 * @param dbPath {string} The path to the database file.
 * @returns {ReturnType<typeof openDrizzleConnection>} The database connection.
 */
export function getDatabaseConnection(
  dbPath?: string,
  target?: AntigravityAppTarget | null,
): ReturnType<typeof openDrizzleConnection> {
  const targetPath = dbPath || getAntigravityDbPaths(target)[0];

  if (!targetPath) {
    throw new Error('No Antigravity database path found');
  }

  ensureDatabaseExists(targetPath);

  try {
    return openAntigravityStateDb(targetPath);
  } catch (error: unknown) {
    const err = error as { code?: string };
    if (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED') {
      throw new Error('Database is locked. Please close Antigravity before proceeding.');
    }
    throw error;
  }
}

function readItemValue(
  orm: ReturnType<typeof openDrizzleConnection>['orm'],
  key: string,
  context: string,
): string | null {
  const rows = orm
    .select({ value: itemTable.value })
    .from(itemTable)
    .where(eq(itemTable.key, key))
    .all();
  const row = parseRow(ItemTableValueRowSchema, rows[0], context);
  return row?.value ?? null;
}

function readCurrentAccountInfoFromDbPath(
  dbPath: string,
  target?: AntigravityAppTarget | null,
): AccountInfo {
  let connection: ReturnType<typeof openDrizzleConnection> | null = null;
  try {
    connection = getDatabaseConnection(dbPath);
    const { orm } = connection;
    const contextPrefix = `${target ?? 'default'}.itemTable`;

    // Query for auth status
    const authValue = readItemValue(
      orm,
      'antigravityAuthStatus',
      `${contextPrefix}.antigravityAuthStatus`,
    );
    let authStatus = null;
    if (authValue) {
      try {
        authStatus = JSON.parse(authValue);
      } catch {
        // NOTE Ignore JSON parse errors
      }
    }

    // NOTE Query for user info (usually in jetskiStateSync.agentManagerInitState or similar)
    const initValue = readItemValue(
      orm,
      'jetskiStateSync.agentManagerInitState',
      `${contextPrefix}.jetskiStateSync.agentManagerInitState`,
    );
    let initState = null;
    if (initValue) {
      try {
        initState = JSON.parse(initValue);
      } catch {
        // Ignore JSON parse errors (this key often contains non-JSON data)
      }
    }

    // Query for google.antigravity
    const googleValue = readItemValue(
      orm,
      'google.antigravity',
      `${contextPrefix}.google.antigravity`,
    );
    let googleState = null;
    if (googleValue) {
      try {
        googleState = JSON.parse(googleValue);
      } catch {
        // Ignore JSON parse errors
      }
    }

    // Query for antigravityUserSettings.allUserSettings
    const settingsValue = readItemValue(
      orm,
      'antigravityUserSettings.allUserSettings',
      `${contextPrefix}.antigravityUserSettings.allUserSettings`,
    );
    let settingsState = null;
    if (settingsValue) {
      try {
        settingsState = JSON.parse(settingsValue);
      } catch {
        // Ignore JSON parse errors
      }
    }

    // Helper to find email in object
    const findEmail = (obj: { email?: string; user?: { email?: string } }): string => {
      if (!obj) {
        return '';
      }
      if (isString(obj.email)) {
        return obj.email;
      }
      if (obj.user && isString(obj.user.email)) {
        return obj.user.email;
      }
      return '';
    };

    const email =
      findEmail(authStatus) ||
      findEmail(initState) ||
      findEmail(googleState) ||
      findEmail(settingsState) ||
      '';

    const name = authStatus?.user?.name || initState?.user?.name || authStatus?.name || '';
    const isAuthenticated = !!email;

    logger.info(`Account info: authenticated=${isAuthenticated}, email=${email || 'none'}`);

    return {
      email,
      name,
      isAuthenticated,
    };
  } finally {
    if (connection) {
      connection.raw.close();
    }
  }
}

/**
 * Gets the current account info.
 * @returns {AccountInfo} The current account info.
 */
export function getCurrentAccountInfo(target?: AntigravityAppTarget | null): AccountInfo {
  const dbPaths = getAntigravityDbPaths(target);
  if (dbPaths.length === 0) {
    return { email: '', isAuthenticated: false };
  }

  let lastError: unknown;
  for (const dbPath of dbPaths) {
    if (!fs.existsSync(dbPath)) {
      continue;
    }

    try {
      const accountInfo = readCurrentAccountInfoFromDbPath(dbPath, target);
      if (accountInfo.isAuthenticated) {
        return accountInfo;
      }
    } catch (error) {
      lastError = error;
      logger.warn(`Failed to read current account info from ${dbPath}`, error);
    }
  }

  if (lastError) {
    logger.error('Failed to get current account info', lastError);
    throw lastError;
  }

  return { email: '', isAuthenticated: false };
}

export function backupAccount(account: AccountBackupData['account']): AccountBackupData {
  let connection: ReturnType<typeof openDrizzleConnection> | null = null;
  try {
    connection = getDatabaseConnection(undefined);
    const { orm } = connection;

    // NOTE Backup only specific keys
    const data: Record<string, unknown> = {};

    for (const key of KEYS_TO_BACKUP) {
      const value = readItemValue(orm, key, `ide.itemTable.backup.${key}`);
      if (value) {
        try {
          data[key] = JSON.parse(value);
        } catch {
          data[key] = value;
        }
        logger.debug(`Backed up key: ${key}`);
      } else {
        logger.debug(`Key not found: ${key}`);
      }
    }

    // NOTE Add metadata
    data['account_email'] = account.email;
    data['backup_time'] = new Date().toISOString();

    return {
      version: '1.0',
      account,
      data,
    };
  } catch (error) {
    logger.error('Failed to backup account', error);
    throw error;
  } finally {
    if (connection) {
      connection.raw.close();
    }
  }
}

/**
 * Restores the account data to the database.
 * @param backup {AccountBackupData} The backup data to restore.
 * @throws {Error} If the backup data cannot be restored.
 */
export function extractCredentialStoreTokenFromBackup(
  backup: AccountBackupData,
): CredentialStoreTokenInput {
  const unified = backup.data['antigravityUnifiedStateSync.oauthToken'];
  if (!isString(unified)) {
    throw new Error('Backup does not contain antigravityUnifiedStateSync.oauthToken');
  }

  const parsed = ProtobufUtils.extractOAuthTokenDetailsFromUnifiedStateEntry(unified);
  if (!parsed) {
    throw new Error('Unable to extract OAuth token from backup');
  }

  return {
    access_token: parsed.accessToken,
    refresh_token: parsed.refreshToken,
    expiry_timestamp: parsed.expiryTimestamp,
  };
}

export function restoreAccount(backup: AccountBackupData, appTarget?: AntigravityAppTarget): void {
  const dbPaths = getAntigravityDbPaths(appTarget);
  if (dbPaths.length === 0) {
    throw new Error('No Antigravity database paths found');
  }

  let successCount = 0;

  for (const dbPath of dbPaths) {
    // NOTE Restore main DB
    if (restoreSingleDatabase(dbPath, backup)) {
      successCount++;
    }

    // NOTE Restore backup DB (if exists)
    const backupDbPath = dbPath.replace(/\.vscdb$/, '.vscdb.backup');
    if (fs.existsSync(backupDbPath)) {
      if (restoreSingleDatabase(backupDbPath, backup)) {
        successCount++;
      }
    }
  }

  if (successCount > 0) {
    logger.info(`Account data restored successfully to ${successCount} files`);
  } else {
    throw new Error('Failed to restore account data to any database file');
  }
}

/**
 * Restores a single database file.
 * @param dbPath {string} The path to the database file.
 * @param backup {AccountBackupData} The backup data to restore.
 * @returns {boolean} True if the database file was restored successfully, false otherwise.
 */
function restoreSingleDatabase(dbPath: string, backup: AccountBackupData): boolean {
  if (!fs.existsSync(dbPath)) {
    return false;
  }

  logger.info(`Restoring database: ${dbPath}`);
  let connection: ReturnType<typeof openDrizzleConnection> | null = null;

  try {
    connection = getDatabaseConnection(dbPath);
    const { orm } = connection;
    orm.transaction((tx) => {
      // NOTE Only restore the keys that were backed up
      for (const key of KEYS_TO_BACKUP) {
        if (key in backup.data) {
          const value = backup.data[key];
          const stringValue = isString(value) ? value : JSON.stringify(value);
          tx.insert(itemTable)
            .values({ key, value: stringValue })
            .onConflictDoUpdate({
              target: itemTable.key,
              set: { value: stringValue },
            })
            .run();
          logger.debug(`Restored key: ${key}`);
        }
      }
    });
    logger.info(`Database restoration complete: ${dbPath}`);
    return true;
  } catch (error) {
    logger.error(`Failed to restore database: ${dbPath}`, error);
    return false;
  } finally {
    if (connection) {
      connection.raw.close();
    }
  }
}
