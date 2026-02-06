import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { AccountBackupData, AccountInfo } from '../../types/account';
import { ItemTableValueRowSchema, type ItemTableKey } from '../../types/db';
import { logger } from '../../utils/logger';
import { getAntigravityDbPaths } from '../../utils/paths';
import { parseRow } from '../../utils/sqlite';
import { openDrizzleConnection } from './dbConnection';
import { itemTable } from './schema';

const KEYS_TO_BACKUP: ItemTableKey[] = [
  'antigravityAuthStatus',
  'jetskiStateSync.agentManagerInitState',
  'antigravityUnifiedStateSync.oauthToken',
];

function openIdeDb(dbPath: string, readOnly = false): ReturnType<typeof openDrizzleConnection> {
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

    const { raw } = getDatabaseConnection();
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
export function getDatabaseConnection(dbPath?: string): ReturnType<typeof openDrizzleConnection> {
  const targetPath = dbPath || getAntigravityDbPaths()[0];

  if (!targetPath) {
    throw new Error('No Antigravity database path found');
  }

  ensureDatabaseExists(targetPath);

  try {
    return openIdeDb(targetPath);
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

/**
 * Gets the current account info.
 * @returns {AccountInfo} The current account info.
 */
export function getCurrentAccountInfo(): AccountInfo {
  // NOTE Database existence is now handled by getDatabaseConnection
  let connection: ReturnType<typeof openDrizzleConnection> | null = null;
  try {
    connection = getDatabaseConnection();
    const { orm } = connection;

    // Query for auth status
    const authValue = readItemValue(
      orm,
      'antigravityAuthStatus',
      'ide.itemTable.antigravityAuthStatus',
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
      'ide.itemTable.jetskiStateSync.agentManagerInitState',
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
      'ide.itemTable.google.antigravity',
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
      'ide.itemTable.antigravityUserSettings.allUserSettings',
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
      if (!obj) return '';
      if (typeof obj.email === 'string') return obj.email;
      if (obj.user && typeof obj.user.email === 'string') return obj.user.email;
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
  } catch (error) {
    logger.error('Failed to get current account info', error);
    throw error;
  } finally {
    if (connection) {
      connection.raw.close();
    }
  }
}

export function backupAccount(account: AccountBackupData['account']): AccountBackupData {
  let connection: ReturnType<typeof openDrizzleConnection> | null = null;
  try {
    connection = getDatabaseConnection();
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
export function restoreAccount(backup: AccountBackupData): void {
  const dbPaths = getAntigravityDbPaths();
  if (dbPaths.length === 0) {
    throw new Error('No Antigravity database paths found');
  }

  let successCount = 0;

  for (const dbPath of dbPaths) {
    // NOTE Restore main DB
    if (_restoreSingleDb(dbPath, backup)) {
      successCount++;
    }

    // NOTE Restore backup DB (if exists)
    const backupDbPath = dbPath.replace(/\.vscdb$/, '.vscdb.backup');
    if (fs.existsSync(backupDbPath)) {
      if (_restoreSingleDb(backupDbPath, backup)) {
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
function _restoreSingleDb(dbPath: string, backup: AccountBackupData): boolean {
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
          const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
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
