import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getCloudAccountsDbPath, getAntigravityDbPaths } from '../../utils/paths';
import { logger } from '../../utils/logger';
import { CloudAccount } from '../../types/cloudAccount';
import { decryptWithMigration, encrypt, type KeySource } from '../../utils/security';
import { ProtobufUtils } from '../../utils/protobuf';
import { GoogleAPIService } from '../../services/GoogleAPIService';

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
    db.pragma('journal_mode = WAL');

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
    const tableInfo = db.pragma('table_info(accounts)') as any[];
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
function getDb(): Database.Database {
  const dbPath = getCloudAccountsDbPath();
  ensureDatabaseInitialized(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
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
  db: Database.Database,
  accountId: string,
  field: 'token_json' | 'quota_json',
  value: string | null,
): Promise<{ value: string | null; migrated: boolean; usedFallback?: KeySource }> {
  if (!value) {
    return { value: null, migrated: false };
  }

  const result = await decryptWithMigration(value);
  if (result.reencrypted) {
    if (field === 'token_json') {
      db.prepare('UPDATE accounts SET token_json = ? WHERE id = ?').run(
        result.reencrypted,
        accountId,
      );
    } else {
      db.prepare('UPDATE accounts SET quota_json = ? WHERE id = ?').run(
        result.reencrypted,
        accountId,
      );
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
  static async init(): Promise<void> {
    const dbPath = getCloudAccountsDbPath();
    ensureDatabaseInitialized(dbPath);
    await this.migrateToEncrypted();
  }

  static async migrateToEncrypted(): Promise<void> {
    const db = getDb();
    try {
      const rows = db.prepare('SELECT id, token_json, quota_json FROM accounts').all() as any[];

      for (const row of rows) {
        let changed = false;
        let newToken = row.token_json;
        let newQuota = row.quota_json;

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
          db.prepare('UPDATE accounts SET token_json = ?, quota_json = ? WHERE id = ?').run(
            newToken,
            newQuota,
            row.id,
          );
          logger.info(`Migrated account ${row.id} to encrypted storage`);
        }
      }
    } catch (e) {
      logger.error('Failed to migrate data', e);
    } finally {
      db.close();
    }
  }

  static async addAccount(account: CloudAccount): Promise<void> {
    const db = getDb();

    try {
      const tokenEncrypted = await encrypt(JSON.stringify(account.token));
      const quotaEncrypted = account.quota ? await encrypt(JSON.stringify(account.quota)) : null;

      const transaction = db.transaction(() => {
        // If this account is being set to active, deactivate all others first
        if (account.is_active) {
          logger.info(
            `[DEBUG] addAccount: Deactivating all other accounts because ${account.email} is active`,
          );
          const info = db.prepare('UPDATE accounts SET is_active = 0').run();
          logger.info(`[DEBUG] addAccount: Deactivation changed ${info.changes} rows`);
        }

        const stmt = db.prepare(`
          INSERT OR REPLACE INTO accounts (
            id, provider, email, name, avatar_url, token_json, quota_json, created_at, last_used, status, is_active
          ) VALUES (
            @id, @provider, @email, @name, @avatar_url, @token_json, @quota_json, @created_at, @last_used, @status, @is_active
          )
        `);

        stmt.run({
          id: account.id,
          provider: account.provider,
          email: account.email,
          name: account.name || null,
          avatar_url: account.avatar_url || null,
          token_json: tokenEncrypted,
          quota_json: quotaEncrypted,
          created_at: account.created_at,
          last_used: account.last_used,
          status: account.status || 'active',
          is_active: account.is_active ? 1 : 0,
        });
      });

      transaction();
      logger.info(`Added/Updated cloud account: ${account.email}`);
    } finally {
      db.close();
    }
  }

  static async getAccounts(): Promise<CloudAccount[]> {
    const db = getDb();
    const migrationStats = createMigrationStats();

    try {
      const stmt = db.prepare('SELECT * FROM accounts ORDER BY last_used DESC');
      const rows = stmt.all() as any[];

      // DEBUG LOGS
      const activeRows = rows.filter((r) => r.is_active);
      logger.info(
        `[DEBUG] getAccounts: Found ${rows.length} accounts, ${activeRows.length} active.`,
      );
      activeRows.forEach((r) => logger.info(`[DEBUG] Active Account: ${r.email} (${r.id})`));

      const accounts: CloudAccount[] = [];
      for (const row of rows) {
        let tokenResult: DecryptFieldResult;
        try {
          tokenResult = await decryptAndMigrateField(db, row.id, 'token_json', row.token_json);
        } catch (error) {
          migrationStats.failedFields += 1;
          logger.error(`Failed to decrypt token for account ${row.id}`, error);
          throw error;
        }

        let quotaResult: DecryptFieldResult;
        try {
          quotaResult = await decryptAndMigrateField(db, row.id, 'quota_json', row.quota_json);
        } catch (error) {
          migrationStats.failedFields += 1;
          logger.error(`Failed to decrypt quota for account ${row.id}`, error);
          throw error;
        }

        if (!tokenResult.value) {
          throw new Error(`Missing token data for account ${row.id}`);
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

        accounts.push({
          id: row.id,
          provider: row.provider,
          email: row.email,
          name: row.name,
          avatar_url: row.avatar_url,
          token: JSON.parse(tokenResult.value),
          quota: quotaResult.value ? JSON.parse(quotaResult.value) : undefined,
          created_at: row.created_at,
          last_used: row.last_used,
          status: row.status,
          is_active: Boolean(row.is_active),
        });
      }

      return accounts;
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
      db.close();
    }
  }

  static async getAccount(id: string): Promise<CloudAccount | undefined> {
    const db = getDb();

    try {
      const stmt = db.prepare('SELECT * FROM accounts WHERE id = ?');
      const row = stmt.get(id) as any;

      if (!row) return undefined;

      const tokenResult = await decryptAndMigrateField(db, row.id, 'token_json', row.token_json);
      const quotaResult = await decryptAndMigrateField(db, row.id, 'quota_json', row.quota_json);

      if (!tokenResult.value) {
        throw new Error(`Missing token data for account ${row.id}`);
      }

      return {
        id: row.id,
        provider: row.provider,
        email: row.email,
        name: row.name,
        avatar_url: row.avatar_url,
        token: JSON.parse(tokenResult.value),
        quota: quotaResult.value ? JSON.parse(quotaResult.value) : undefined,
        created_at: row.created_at,
        last_used: row.last_used,
        status: row.status,
        is_active: Boolean(row.is_active),
      };
    } finally {
      db.close();
    }
  }

  static async removeAccount(id: string): Promise<void> {
    const db = getDb();
    try {
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      logger.info(`Removed cloud account: ${id}`);
    } finally {
      db.close();
    }
  }

  static async updateToken(id: string, token: any): Promise<void> {
    const db = getDb();

    try {
      const encrypted = await encrypt(JSON.stringify(token));
      db.prepare('UPDATE accounts SET token_json = ? WHERE id = ?').run(encrypted, id);
    } finally {
      db.close();
    }
  }

  static async updateQuota(id: string, quota: any): Promise<void> {
    const db = getDb();

    try {
      const encrypted = await encrypt(JSON.stringify(quota));
      db.prepare('UPDATE accounts SET quota_json = ? WHERE id = ?').run(encrypted, id);
    } finally {
      db.close();
    }
  }

  static updateLastUsed(id: string): void {
    const db = getDb();
    try {
      db.prepare('UPDATE accounts SET last_used = ? WHERE id = ?').run(
        Math.floor(Date.now() / 1000),
        id,
      );
    } finally {
      db.close();
    }
  }

  static setActive(id: string): void {
    const db = getDb();
    const updateAll = db.prepare('UPDATE accounts SET is_active = 0');
    const updateOne = db.prepare('UPDATE accounts SET is_active = 1 WHERE id = ?');

    const transaction = db.transaction(() => {
      updateAll.run();
      updateOne.run(id);
    });

    try {
      transaction();
      logger.info(`Set account ${id} as active`);
    } finally {
      db.close();
    }
  }

  static injectCloudToken(account: CloudAccount): void {
    const dbPaths = getAntigravityDbPaths();
    const dbPath = dbPaths.find((p) => fs.existsSync(p)) ?? null;

    if (!dbPath) {
      throw new Error(`Antigravity database not found. Checked paths: ${dbPaths.join(', ')}`);
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    try {
      const row = db
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('jetskiStateSync.agentManagerInitState') as { value: string } | undefined;

      if (!row || !row.value) {
        logger.warn(
          'jetskiStateSync.agentManagerInitState not found. ' +
            'Injecting minimal auth state only. User may need to complete onboarding in the IDE first.',
        );

        // Inject minimal state: auth status and onboarding flag only
        const authStatus = {
          name: account.name || account.email,
          email: account.email,
          apiKey: account.token.access_token,
        };

        db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
          'antigravityAuthStatus',
          JSON.stringify(authStatus),
        );

        db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
          'antigravityOnboarding',
          'true',
        );

        db.prepare('DELETE FROM ItemTable WHERE key = ?').run('google.antigravity');

        logger.info(
          `Injected minimal auth state for ${account.email} (no protobuf state available)`,
        );

        return; // Early return - skip protobuf manipulation
      }

      // 1. Decode Base64
      const buffer = Buffer.from(row.value, 'base64');
      const data = new Uint8Array(buffer);

      // 2. Remove Field 6
      const cleanData = ProtobufUtils.removeField(data, 6);

      // 3. Create New Field 6
      const newField = ProtobufUtils.createOAuthTokenInfo(
        account.token.access_token,
        account.token.refresh_token,
        account.token.expiry_timestamp,
      );

      // 4. Concatenate
      const finalData = new Uint8Array(cleanData.length + newField.length);
      finalData.set(cleanData, 0);
      finalData.set(newField, cleanData.length);

      // 5. Encode Base64
      const finalB64 = Buffer.from(finalData).toString('base64');

      // 6. Write back
      db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(
        finalB64,
        'jetskiStateSync.agentManagerInitState',
      );

      // 7. Inject Onboarding Flag
      db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
        'antigravityOnboarding',
        'true',
      );

      // 8. Update Auth Status (Fix for switching issue)
      // This ensures the UI reflects the user we just switched to
      const authStatus = {
        name: account.name || account.email,
        email: account.email,
        apiKey: account.token.access_token, // Critical for session recognition
        // userStatusProtoBinaryBase64: ... // We cannot generate this easily, hoping IDE fetches it
      };

      db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
        'antigravityAuthStatus',
        JSON.stringify(authStatus),
      );

      // 9. Remove google.antigravity to prevent conflicts
      // This key often holds old state that might override our injected state
      db.prepare('DELETE FROM ItemTable WHERE key = ?').run('google.antigravity');

      logger.info(
        `Successfully injected cloud token and identity for ${account.email} into Antigravity database at ${dbPath}.`,
      );
    } finally {
      db.close();
    }
  }

  static getSetting<T>(key: string, defaultValue: T): T {
    const db = getDb();
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      if (!row) return defaultValue;
      return JSON.parse(row.value) as T;
    } catch (e) {
      logger.error(`Failed to get setting ${key}`, e);
      return defaultValue;
    } finally {
      db.close();
    }
  }

  static setSetting(key: string, value: any): void {
    const db = getDb();
    try {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        key,
        JSON.stringify(value),
      );
    } finally {
      db.close();
    }
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
    const ideDb = new Database(dbPath, { readonly: true });
    ideDb.pragma('journal_mode = WAL');
    try {
      // 1. Read Raw Token Data
      const row = ideDb
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('jetskiStateSync.agentManagerInitState') as { value: string } | undefined;

      if (!row || !row.value) {
        const errorMsg =
          'No cloud account found in IDE. Please login to a Google account in Antigravity IDE first.';
        logger.warn(`SyncLocal: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      // 2. Decode Protobuf
      const buffer = Buffer.from(row.value, 'base64');
      const data = new Uint8Array(buffer);
      const tokenInfo = ProtobufUtils.extractOAuthTokenInfo(data);

      if (!tokenInfo) {
        const errorMsg =
          'No OAuth token found in IDE state. Please login to a Google account in Antigravity IDE first.';
        logger.warn(`SyncLocal: ${errorMsg}`);
        throw new Error(errorMsg);
      }

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
    } finally {
      ideDb.close();
    }
  }
}
