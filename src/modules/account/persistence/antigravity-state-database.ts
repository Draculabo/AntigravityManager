import type { PathResolutionOptions } from '@/shared/platform/paths';
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
import { openDrizzleConnection } from '@/shared/persistence/database/dbConnection';
import { itemTable } from '@/shared/persistence/database/schema';
import {
  prepareClientAccountWrite,
  prepareLaunchContext,
  readClientAccountToken,
  resolveClientAccountStorage,
} from '@/modules/antigravity-runtime';
import { credentialsFromAccountBackup } from './snapshotCredentials';
import { hasErrorCode } from '@/shared/errors/error-guards';
import { ProtobufUtils } from '@/shared/serialization/protobuf';

const KEYS_TO_BACKUP: ItemTableKey[] = [
  'antigravityAuthStatus',
  'jetskiStateSync.agentManagerInitState',
  'antigravityUnifiedStateSync.oauthToken',
  'antigravityUnifiedStateSync.userStatus',
  'antigravityUnifiedStateSync.enterprisePreferences',
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
  } catch (error) {
    if (hasErrorCode(error, 'SQLITE_BUSY') || hasErrorCode(error, 'SQLITE_LOCKED')) {
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
export function getCurrentAccountInfo(
  target?: AntigravityAppTarget | null,
  pathOptions?: PathResolutionOptions,
): AccountInfo {
  const dbPaths = getAntigravityDbPaths(target, pathOptions);
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

/** Captures only authentication state from the explicitly selected installation. */
export async function backupAccount(
  account: AccountBackupData['account'],
  target?: AntigravityAppTarget,
  pathOptions?: PathResolutionOptions,
): Promise<AccountBackupData> {
  const data: AccountBackupData['data'] = {
    account_email: account.email,
    backup_time: new Date().toISOString(),
  };
  const storage = await resolveClientAccountStorage(target, pathOptions);
  if (storage === 'credential-store') {
    const token = await readClientAccountToken(target);
    if (!token?.accessToken || !token.expiryTimestamp) {
      throw new Error('Client credential store does not contain complete snapshot credentials');
    }
    data['antigravityUnifiedStateSync.oauthToken'] = ProtobufUtils.createUnifiedOAuthToken(
      token.accessToken,
      token.refreshToken,
      token.expiryTimestamp,
      false,
      token.idToken,
      account.email,
    );
    if (token.projectId) {
      data['antigravityUnifiedStateSync.enterprisePreferences'] =
        ProtobufUtils.createUnifiedStateEntry(
          'enterpriseGcpProjectId',
          ProtobufUtils.createStringValuePayload(token.projectId),
        );
    }
  } else {
    const dbPath = getAntigravityDbPaths(target, pathOptions).find((file) => fs.existsSync(file));
    if (!dbPath) {
      throw new Error('Selected client state database does not exist');
    }
    const { raw, orm } = openAntigravityStateDb(dbPath, true);
    try {
      const snapshot = orm.transaction((transaction) => {
        const result: AccountBackupData['data'] = {};
        for (const key of KEYS_TO_BACKUP) {
          const value = readItemValue(transaction, key, 'client-snapshot.' + key);
          if (value) {
            result[key] = value;
          }
        }
        return result;
      });
      Object.assign(data, snapshot);
    } finally {
      raw.close();
    }
  }
  return { version: '1.0', account: structuredClone(account), data };
}

/** Restores normalized credentials to the selected primary store, never a recovery copy. */
export async function restoreAccount(
  backup: AccountBackupData,
  appTarget?: AntigravityAppTarget,
  pathOptions?: PathResolutionOptions,
): Promise<void> {
  const credentials = credentialsFromAccountBackup(backup);
  const context =
    appTarget === 'agy' || pathOptions
      ? undefined
      : await prepareLaunchContext(appTarget === 'ide' ? 'ide' : 'classic');
  const prepared = await prepareClientAccountWrite(
    credentials,
    appTarget,
    pathOptions ?? context?.pathOptions,
  );
  await prepared.write();
}
