import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getCloudAccountsDbPath, getAntigravityDbPaths } from '../../utils/paths';
import { logger } from '../../utils/logger';
import { CloudAccount } from '../../types/cloudAccount';
import { ItemTableValueRowSchema, TableInfoRowSchema } from '../../types/db';
import { decryptWithMigration, encrypt, type KeySource } from '../../utils/security';
import { ProtobufUtils } from '../../utils/protobuf';
import { GoogleAPIService } from '../../services/GoogleAPIService';
import { getAntigravityVersion, isNewVersion } from '../../utils/antigravityVersion';
import { parseRow, parseRows } from '../../utils/sqlite';
import { configureDatabase, openDrizzleConnection } from './dbConnection';
import { accounts, itemTable, settings } from './schema';
import * as drizzleSchema from './schema';

const SQLITE_BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);
const SQLITE_BUSY_TIMEOUT_MS = 3000;
const SQLITE_RETRY_DELAY_MS = 150;
const SQLITE_MAX_RETRIES = 3;

type DrizzleExecutor = Pick<
  BetterSQLite3Database<typeof drizzleSchema>,
  'insert' | 'update' | 'delete' | 'select'
>;

function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as { code?: string; message?: string };
  if (err.code && SQLITE_BUSY_CODES.has(err.code)) {
    return true;
  }
  if (typeof err.message === 'string') {
    return err.message.includes('SQLITE_BUSY') || err.message.includes('SQLITE_LOCKED');
  }
  return false;
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const array = new Int32Array(buffer);
  Atomics.wait(array, 0, 0, ms);
}

/**
 * Ensures that the cloud database file and schema exist.
 * @param dbPath {string} The path to the database file.
 */
function ensureDatabaseInitialized(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    configureDatabase(db, { busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS });

    // Create accounts table
    // Storing complex objects (token, quota) as JSON strings for simplicity
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT,
        avatar_url TEXT,
        token_json TEXT NOT NULL,
        quota_json TEXT,
        created_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        status TEXT DEFAULT 'active',
        is_active INTEGER DEFAULT 0
      );
    `);

    // Migration: Check if is_active column exists
    const tableInfoRaw = db.pragma('table_info(accounts)') as any[];
    const tableInfo = parseRows(TableInfoRowSchema, tableInfoRaw, 'cloud.accounts.tableInfo');
    const hasIsActive = tableInfo.some((col) => col.name === 'is_active');
    if (!hasIsActive) {
      db.exec('ALTER TABLE accounts ADD COLUMN is_active INTEGER DEFAULT 0');
    }

    // Create index on email for faster lookups
    // Create index on email for faster lookups
    db.exec(`CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);`);

    // Create settings table
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  } catch (error) {
    logger.error('Failed to initialize cloud database schema', error);
    throw error;
  } finally {
    if (db) db.close();
  }
}

/**
 * Gets a connection to the cloud accounts database.
 */
function getCloudDb(): {
  raw: Database.Database;
  orm: BetterSQLite3Database<typeof drizzleSchema>;
} {
  const dbPath = getCloudAccountsDbPath();
  ensureDatabaseInitialized(dbPath);
  return openDrizzleConnection(
    dbPath,
    { readonly: false, fileMustExist: false },
    { busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS },
  );
}

function getIdeDb(
  dbPath: string,
  readOnly: boolean,
): { raw: Database.Database; orm: BetterSQLite3Database<typeof drizzleSchema> } {
  return openDrizzleConnection(
    dbPath,
    { readonly: readOnly },
    { readOnly, busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS },
  );
}

interface MigrationStats {
  totalFields: number;
  fallbackUsedFields: number;
  migratedFields: number;
  migratedBySource: Record<KeySource, number>;
  failedFields: number;
}

function createMigrationStats(): MigrationStats {
  return {
    totalFields: 0,
    fallbackUsedFields: 0,
    migratedFields: 0,
    migratedBySource: {
      safeStorage: 0,
      keytar: 0,
      file: 0,
    },
    failedFields: 0,
  };
}

async function decryptAndMigrateField(
  orm: DrizzleExecutor,
  accountId: string,
  field: 'tokenJson' | 'quotaJson',
  value: string | null,
): Promise<{ value: string | null; migrated: boolean; usedFallback?: KeySource }> {
  if (!value) {
    return { value: null, migrated: false };
  }

  const result = await decryptWithMigration(value);
  if (result.reencrypted) {
    if (field === 'tokenJson') {
      orm
        .update(accounts)
        .set({ tokenJson: result.reencrypted })
        .where(eq(accounts.id, accountId))
        .run();
    } else {
      orm
        .update(accounts)
        .set({ quotaJson: result.reencrypted })
        .where(eq(accounts.id, accountId))
        .run();
    }
    logger.info(
      `Migrated ${field} for account ${accountId} from ${result.usedFallback ?? 'unknown'} key`,
    );
  }

  return {
    value: result.value,
    migrated: Boolean(result.reencrypted),
    usedFallback: result.usedFallback,
  };
}

type DecryptFieldResult = Awaited<ReturnType<typeof decryptAndMigrateField>>;

export class CloudAccountRepo {
  private static versionFailureLogged = false;

  static async init(): Promise<void> {
    const dbPath = getCloudAccountsDbPath();
    ensureDatabaseInitialized(dbPath);
    await this.migrateToEncrypted();
  }

  static async migrateToEncrypted(): Promise<void> {
    const { raw, orm } = getCloudDb();
    try {
      const rows = orm
        .select({
          id: accounts.id,
          tokenJson: accounts.tokenJson,
          quotaJson: accounts.quotaJson,
        })
        .from(accounts)
        .all();

      for (const row of rows) {
        let changed = false;
        let newToken = row.tokenJson;
        let newQuota = row.quotaJson;

        // Check if plain text (starts with {)
        if (newToken && newToken.startsWith('{')) {
          newToken = await encrypt(newToken);
          changed = true;
        }
        if (newQuota && newQuota.startsWith('{')) {
          newQuota = await encrypt(newQuota);
          changed = true;
        }

        if (changed) {
          orm
            .update(accounts)
            .set({ tokenJson: newToken, quotaJson: newQuota })
            .where(eq(accounts.id, row.id))
            .run();
          logger.info(`Migrated account ${row.id} to encrypted storage`);
        }
      }
    } catch (e) {
      logger.error('Failed to migrate data', e);
    } finally {
      raw.close();
    }
  }

  static async addAccount(account: CloudAccount): Promise<void> {
    const { raw, orm } = getCloudDb();
    try {
      const tokenEncrypted = await encrypt(JSON.stringify(account.token));
      const quotaEncrypted = account.quota ? await encrypt(JSON.stringify(account.quota)) : null;
      const values = {
        id: account.id,
        provider: account.provider,
        email: account.email,
        name: account.name ?? null,
        avatarUrl: account.avatar_url ?? null,
        tokenJson: tokenEncrypted,
        quotaJson: quotaEncrypted,
        createdAt: account.created_at,
        lastUsed: account.last_used,
        status: account.status || 'active',
        isActive: account.is_active ? 1 : 0,
      };

      orm.transaction((tx) => {
        // If this account is being set to active, deactivate all others first
        if (account.is_active) {
          logger.info(
            `[DEBUG] addAccount: Deactivating all other accounts because ${account.email} is active`,
          );
          const info = tx.update(accounts).set({ isActive: 0 }).run();
          logger.info(`[DEBUG] addAccount: Deactivation changed ${info.changes} rows`);
        }
        tx.insert(accounts)
          .values(values)
          .onConflictDoUpdate({
            target: accounts.id,
            set: values,
          })
          .run();
      });
      logger.info(`Added/Updated cloud account: ${account.email}`);
    } finally {
      raw.close();
    }
  }

  static async getAccounts(): Promise<CloudAccount[]> {
    const { raw, orm } = getCloudDb();
    const migrationStats = createMigrationStats();

    try {
      const rows = orm.select().from(accounts).orderBy(desc(accounts.lastUsed)).all();

      // DEBUG LOGS
      const activeRows = rows.filter((r) => r.isActive);
      logger.info(
        `[DEBUG] getAccounts: Found ${rows.length} accounts, ${activeRows.length} active.`,
      );
      activeRows.forEach((r) => logger.info(`[DEBUG] Active Account: ${r.email} (${r.id})`));

      const cloudAccounts: CloudAccount[] = [];
      for (const normalizedRow of rows) {
        let tokenResult: DecryptFieldResult;
        try {
          tokenResult = await decryptAndMigrateField(
            orm,
            normalizedRow.id,
            'tokenJson',
            normalizedRow.tokenJson,
          );
        } catch (error) {
          migrationStats.failedFields += 1;
          logger.error(`Failed to decrypt token for account ${normalizedRow.id}`, error);
          throw error;
        }

        let quotaResult: DecryptFieldResult;
        try {
          quotaResult = await decryptAndMigrateField(
            orm,
            normalizedRow.id,
            'quotaJson',
            normalizedRow.quotaJson,
          );
        } catch (error) {
          migrationStats.failedFields += 1;
          logger.error(`Failed to decrypt quota for account ${normalizedRow.id}`, error);
          throw error;
        }

        if (!tokenResult.value) {
          throw new Error(`Missing token data for account ${normalizedRow.id}`);
        }

        if (tokenResult.value) {
          migrationStats.totalFields += 1;
        }
        if (tokenResult.usedFallback) {
          migrationStats.fallbackUsedFields += 1;
        }
        if (tokenResult.migrated) {
          migrationStats.migratedFields += 1;
          if (tokenResult.usedFallback) {
            migrationStats.migratedBySource[tokenResult.usedFallback] += 1;
          }
        }

        if (quotaResult.value) {
          migrationStats.totalFields += 1;
        }
        if (quotaResult.usedFallback) {
          migrationStats.fallbackUsedFields += 1;
        }
        if (quotaResult.migrated) {
          migrationStats.migratedFields += 1;
          if (quotaResult.usedFallback) {
            migrationStats.migratedBySource[quotaResult.usedFallback] += 1;
          }
        }

        cloudAccounts.push({
          id: normalizedRow.id,
          provider: normalizedRow.provider as CloudAccount['provider'],
          email: normalizedRow.email,
          name: normalizedRow.name ?? undefined,
          avatar_url: normalizedRow.avatarUrl ?? undefined,
          token: JSON.parse(tokenResult.value),
          quota: quotaResult.value ? JSON.parse(quotaResult.value) : undefined,
          created_at: normalizedRow.createdAt,
          last_used: normalizedRow.lastUsed,
          status: (normalizedRow.status as CloudAccount['status']) ?? undefined,
          is_active: Boolean(normalizedRow.isActive),
        });
      }

      return cloudAccounts;
    } finally {
      if (
        migrationStats.migratedFields > 0 ||
        migrationStats.fallbackUsedFields > 0 ||
        migrationStats.failedFields > 0
      ) {
        const summary = {
          totalFields: migrationStats.totalFields,
          fallbackUsedFields: migrationStats.fallbackUsedFields,
          migratedFields: migrationStats.migratedFields,
          migratedBySource: migrationStats.migratedBySource,
          failedFields: migrationStats.failedFields,
        };
        if (migrationStats.failedFields > 0) {
          logger.warn('CloudAccountRepo migration summary (with failures)', summary);
        } else {
          logger.info('CloudAccountRepo migration summary', summary);
        }
      }
      raw.close();
    }
  }

  static async getAccount(id: string): Promise<CloudAccount | undefined> {
    const { raw, orm } = getCloudDb();

    try {
      const rows = orm.select().from(accounts).where(eq(accounts.id, id)).all();
      const normalizedRow = rows[0];
      if (!normalizedRow) {
        return undefined;
      }

      const tokenResult = await decryptAndMigrateField(
        orm,
        normalizedRow.id,
        'tokenJson',
        normalizedRow.tokenJson,
      );
      const quotaResult = await decryptAndMigrateField(
        orm,
        normalizedRow.id,
        'quotaJson',
        normalizedRow.quotaJson,
      );

      if (!tokenResult.value) {
        throw new Error(`Missing token data for account ${normalizedRow.id}`);
      }

      return {
        id: normalizedRow.id,
        provider: normalizedRow.provider as CloudAccount['provider'],
        email: normalizedRow.email,
        name: normalizedRow.name ?? undefined,
        avatar_url: normalizedRow.avatarUrl ?? undefined,
        token: JSON.parse(tokenResult.value),
        quota: quotaResult.value ? JSON.parse(quotaResult.value) : undefined,
        created_at: normalizedRow.createdAt,
        last_used: normalizedRow.lastUsed,
        status: (normalizedRow.status as CloudAccount['status']) ?? undefined,
        is_active: Boolean(normalizedRow.isActive),
      };
    } finally {
      raw.close();
    }
  }

  static async removeAccount(id: string): Promise<void> {
    const { raw, orm } = getCloudDb();
    try {
      orm.delete(accounts).where(eq(accounts.id, id)).run();
      logger.info(`Removed cloud account: ${id}`);
    } finally {
      raw.close();
    }
  }

  static async updateToken(id: string, token: any): Promise<void> {
    const { raw, orm } = getCloudDb();

    try {
      const encrypted = await encrypt(JSON.stringify(token));
      orm.update(accounts).set({ tokenJson: encrypted }).where(eq(accounts.id, id)).run();
    } finally {
      raw.close();
    }
  }

  static async updateQuota(id: string, quota: any): Promise<void> {
    const { raw, orm } = getCloudDb();

    try {
      const encrypted = await encrypt(JSON.stringify(quota));
      orm.update(accounts).set({ quotaJson: encrypted }).where(eq(accounts.id, id)).run();
    } finally {
      raw.close();
    }
  }

  static updateLastUsed(id: string): void {
    const { raw, orm } = getCloudDb();
    try {
      orm
        .update(accounts)
        .set({ lastUsed: Math.floor(Date.now() / 1000) })
        .where(eq(accounts.id, id))
        .run();
    } finally {
      raw.close();
    }
  }

  static setActive(id: string): void {
    const { raw, orm } = getCloudDb();

    try {
      orm.transaction((tx) => {
        tx.update(accounts).set({ isActive: 0 }).run();
        tx.update(accounts).set({ isActive: 1 }).where(eq(accounts.id, id)).run();
      });
      logger.info(`Set account ${id} as active`);
    } finally {
      raw.close();
    }
  }

  private static upsertItemValue(db: DrizzleExecutor, key: string, value: string): void {
    db.insert(itemTable)
      .values({ key, value })
      .onConflictDoUpdate({
        target: itemTable.key,
        set: { value },
      })
      .run();
  }

  private static writeAuthStatusAndCleanup(db: DrizzleExecutor, account: CloudAccount): void {
    const authStatus = {
      name: account.name || account.email,
      email: account.email,
      apiKey: account.token.access_token,
    };

    this.upsertItemValue(db, 'antigravityAuthStatus', JSON.stringify(authStatus));
    this.upsertItemValue(db, 'antigravityOnboarding', 'true');
    db.delete(itemTable).where(eq(itemTable.key, 'google.antigravity')).run();
  }

  private static getItemValue(db: DrizzleExecutor, key: string, context: string): string | null {
    const rows = db
      .select({ value: itemTable.value })
      .from(itemTable)
      .where(eq(itemTable.key, key))
      .all();
    const row = parseRow(ItemTableValueRowSchema, rows[0], context);
    return row?.value ?? null;
  }

  private static injectNewFormat(
    orm: BetterSQLite3Database<typeof drizzleSchema>,
    account: CloudAccount,
  ): void {
    const oauthToken = ProtobufUtils.createUnifiedOAuthToken(
      account.token.access_token,
      account.token.refresh_token,
      account.token.expiry_timestamp,
    );

    orm.transaction((tx) => {
      this.upsertItemValue(tx, 'antigravityUnifiedStateSync.oauthToken', oauthToken);
      this.writeAuthStatusAndCleanup(tx, account);
    });
  }

  private static injectOldFormat(
    orm: BetterSQLite3Database<typeof drizzleSchema>,
    account: CloudAccount,
  ): void {
    const value = this.getItemValue(
      orm,
      'jetskiStateSync.agentManagerInitState',
      'ide.itemTable.jetskiStateSync.agentManagerInitState',
    );

    orm.transaction((tx) => {
      if (!value) {
        logger.warn(
          'jetskiStateSync.agentManagerInitState not found. ' +
            'Injecting minimal auth state only. User may need to complete onboarding in the IDE first.',
        );

        this.writeAuthStatusAndCleanup(tx, account);

        logger.info(
          `Injected minimal auth state for ${account.email} (no protobuf state available)`,
        );
        return;
      }

      const buffer = Buffer.from(value, 'base64');
      const data = new Uint8Array(buffer);
      const cleanData = ProtobufUtils.removeField(data, 6);
      const newField = ProtobufUtils.createOAuthTokenInfo(
        account.token.access_token,
        account.token.refresh_token,
        account.token.expiry_timestamp,
      );

      const finalData = new Uint8Array(cleanData.length + newField.length);
      finalData.set(cleanData, 0);
      finalData.set(newField, cleanData.length);

      const finalB64 = Buffer.from(finalData).toString('base64');

      tx.update(itemTable)
        .set({ value: finalB64 })
        .where(eq(itemTable.key, 'jetskiStateSync.agentManagerInitState'))
        .run();

      this.writeAuthStatusAndCleanup(tx, account);
    });
  }

  private static detectFormatCapability(db: DrizzleExecutor): 'new' | 'old' | null {
    const unifiedValue = this.getItemValue(
      db,
      'antigravityUnifiedStateSync.oauthToken',
      'ide.itemTable.antigravityUnifiedStateSync.oauthToken',
    );
    if (unifiedValue) {
      return 'new';
    }

    const oldValue = this.getItemValue(
      db,
      'jetskiStateSync.agentManagerInitState',
      'ide.itemTable.jetskiStateSync.agentManagerInitState',
    );
    if (oldValue) {
      return 'old';
    }

    return null;
  }

  private static resolveInjectionStrategy(db: DrizzleExecutor): {
    name: 'new' | 'old' | 'dual';
    reason: string;
  } {
    try {
      const version = getAntigravityVersion();
      return {
        name: isNewVersion(version) ? 'new' : 'old',
        reason: `version:${version.shortVersion}`,
      };
    } catch (error) {
      if (!this.versionFailureLogged) {
        logger.warn('Version detection failed, falling back to capability detection', error);
        this.versionFailureLogged = true;
      }
    }

    const capability = this.detectFormatCapability(db);
    if (capability) {
      return { name: capability, reason: 'capability' };
    }

    return { name: 'dual', reason: 'fallback' };
  }

  private static getStrategy(name: 'new' | 'old'): {
    name: 'new' | 'old';
    inject: (db: BetterSQLite3Database<typeof drizzleSchema>, account: CloudAccount) => void;
  } {
    if (name === 'new') {
      return { name, inject: (db, account) => this.injectNewFormat(db, account) };
    }
    return { name, inject: (db, account) => this.injectOldFormat(db, account) };
  }

  private static injectWithRetry(
    dbPath: string,
    account: CloudAccount,
  ): { strategy: string; attempts: number } {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SQLITE_MAX_RETRIES; attempt += 1) {
      const { raw, orm } = getIdeDb(dbPath, false);
      try {
        const { name, reason } = this.resolveInjectionStrategy(orm);
        if (name === 'dual') {
          let newInjected = false;
          let oldInjected = false;

          try {
            this.injectNewFormat(orm, account);
            newInjected = true;
          } catch (newError) {
            logger.warn('Failed to inject new format', newError);
          }

          try {
            this.injectOldFormat(orm, account);
            oldInjected = true;
          } catch (oldError) {
            logger.warn('Failed to inject old format', oldError);
          }

          if (!newInjected && !oldInjected) {
            throw new Error('Token injection failed for both formats');
          }

          return { strategy: `dual:${reason}`, attempts: attempt };
        }

        const strategy = this.getStrategy(name);
        strategy.inject(orm, account);
        return { strategy: `${strategy.name}:${reason}`, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (isSqliteBusyError(error) && attempt < SQLITE_MAX_RETRIES) {
          logger.warn(`SQLite busy, retrying injection (attempt ${attempt})`, error);
          sleepSync(SQLITE_RETRY_DELAY_MS);
          continue;
        }
        throw error;
      } finally {
        raw.close();
      }
    }

    throw lastError;
  }

  static injectCloudToken(account: CloudAccount): void {
    const dbPaths = getAntigravityDbPaths();
    const dbPath = dbPaths.find((p) => fs.existsSync(p)) ?? null;

    if (!dbPath) {
      throw new Error(`Antigravity database not found. Checked paths: ${dbPaths.join(', ')}`);
    }

    const result = this.injectWithRetry(dbPath, account);
    logger.info(
      `Successfully injected cloud token and identity for ${account.email} into Antigravity database at ${dbPath} (strategy=${result.strategy}, attempts=${result.attempts}).`,
    );
  }

  static getSetting<T>(key: string, defaultValue: T): T {
    const { raw, orm } = getCloudDb();
    try {
      const rows = orm
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
        .all();
      const row = rows[0];
      if (!row) {
        return defaultValue;
      }
      return JSON.parse(row.value) as T;
    } catch (e) {
      logger.error(`Failed to get setting ${key}`, e);
      return defaultValue;
    } finally {
      raw.close();
    }
  }

  static setSetting(key: string, value: any): void {
    const { raw, orm } = getCloudDb();
    try {
      const stringValue = JSON.stringify(value);
      orm
        .insert(settings)
        .values({ key, value: stringValue })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: stringValue },
        })
        .run();
    } finally {
      raw.close();
    }
  }

  private static readTokenInfoFromDb(db: DrizzleExecutor): {
    accessToken: string;
    refreshToken: string;
  } {
    const unifiedValue = this.getItemValue(
      db,
      'antigravityUnifiedStateSync.oauthToken',
      'ide.itemTable.antigravityUnifiedStateSync.oauthToken',
    );

    let tokenInfo: { accessToken: string; refreshToken: string } | null = null;
    if (unifiedValue) {
      try {
        const unifiedBuffer = Buffer.from(unifiedValue, 'base64');
        const unifiedData = new Uint8Array(unifiedBuffer);
        tokenInfo = ProtobufUtils.extractOAuthTokenInfoFromUnifiedState(unifiedData);
      } catch (error) {
        logger.warn('SyncLocal: Failed to parse unified OAuth token', error);
      }
    }

    if (!tokenInfo) {
      const value = this.getItemValue(
        db,
        'jetskiStateSync.agentManagerInitState',
        'ide.itemTable.jetskiStateSync.agentManagerInitState',
      );

      if (!value) {
        const errorMsg =
          'No cloud account found in IDE. Please login to a Google account in Antigravity IDE first.';
        logger.warn(`SyncLocal: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      const buffer = Buffer.from(value, 'base64');
      const data = new Uint8Array(buffer);
      tokenInfo = ProtobufUtils.extractOAuthTokenInfo(data);
    }

    if (!tokenInfo) {
      const errorMsg =
        'No OAuth token found in IDE state. Please login to a Google account in Antigravity IDE first.';
      logger.warn(`SyncLocal: ${errorMsg}`);
      throw new Error(errorMsg);
    }

    return tokenInfo;
  }

  private static readTokenInfoWithRetry(dbPath: string): {
    accessToken: string;
    refreshToken: string;
  } {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SQLITE_MAX_RETRIES; attempt += 1) {
      const { raw, orm } = getIdeDb(dbPath, true);
      try {
        return this.readTokenInfoFromDb(orm);
      } catch (error) {
        lastError = error;
        if (isSqliteBusyError(error) && attempt < SQLITE_MAX_RETRIES) {
          logger.warn(`SQLite busy, retrying IDE read (attempt ${attempt})`, error);
          sleepSync(SQLITE_RETRY_DELAY_MS);
          continue;
        }
        throw error;
      } finally {
        raw.close();
      }
    }
    throw lastError;
  }

  static async syncFromIDE(): Promise<CloudAccount | null> {
    // Try all possible database paths
    const dbPaths = getAntigravityDbPaths();
    logger.info(`SyncLocal: Checking database paths: ${JSON.stringify(dbPaths)}`);

    const dbPath =
      dbPaths.find((p) => {
        logger.info(`SyncLocal: Checking path: ${p}, exists: ${fs.existsSync(p)}`);
        return fs.existsSync(p);
      }) ?? null;

    if (!dbPath) {
      const errorMsg = `Antigravity database not found. Please ensure Antigravity IDE is installed. Checked paths: ${dbPaths.join(', ')}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    logger.info(`SyncLocal: Using Antigravity database at: ${dbPath}`);
    try {
      const tokenInfo = this.readTokenInfoWithRetry(dbPath);

      // 3. Fetch User Info
      // We need to fetch user info to know who this token belongs to
      let userInfo;
      try {
        userInfo = await GoogleAPIService.getUserInfo(tokenInfo.accessToken);
      } catch (apiError: any) {
        const errorMsg = `Failed to validate token with Google API. The token may be expired. Please re-login in Antigravity IDE. Error: ${apiError.message}`;
        logger.error(`SyncLocal: ${errorMsg}`, apiError);
        throw new Error(errorMsg);
      }

      // 4. Check Duplicate & Construct Account
      // We use existing addAccount logic which does UPSERT (REPLACE)
      // Construct CloudAccount object
      const now = Math.floor(Date.now() / 1000);
      const account: CloudAccount = {
        id: uuidv4(), // Generate new ID if new, but check existing email
        provider: 'google',
        email: userInfo.email,
        name: userInfo.name,
        avatar_url: userInfo.picture,
        token: {
          access_token: tokenInfo.accessToken,
          refresh_token: tokenInfo.refreshToken,
          expires_in: 3600, // Unknown, assume 1 hour validity or let it refresh
          expiry_timestamp: now + 3600,
          token_type: 'Bearer',
          email: userInfo.email,
        },
        created_at: now,
        last_used: now,
        status: 'active',
        is_active: true, // It is the active one in IDE
      };

      // Check if email already exists to preserve ID
      const accounts = await this.getAccounts();
      const existing = accounts.find((a) => a.email === account.email);
      if (existing) {
        account.id = existing.id; // Keep existing ID
        account.created_at = existing.created_at;
      }

      await this.addAccount(account);
      return account;
    } catch (error) {
      logger.error('SyncLocal: Failed to sync account from IDE', error);
      throw error;
    }
  }
}
