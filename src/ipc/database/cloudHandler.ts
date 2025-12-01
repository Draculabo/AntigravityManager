import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getCloudAccountsDbPath } from '../../utils/paths';
import { logger } from '../../utils/logger';
import { CloudAccount } from '../../types/cloudAccount';

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
  return new Database(dbPath);
}

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
      const { encrypt } = require('../../utils/security'); // Lazy import

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
    const { encrypt } = require('../../utils/security');
    try {
      const tokenEncrypted = await encrypt(JSON.stringify(account.token));
      const quotaEncrypted = account.quota ? await encrypt(JSON.stringify(account.quota)) : null;

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

      logger.info(`Added/Updated cloud account: ${account.email}`);
    } finally {
      db.close();
    }
  }

  static async getAccounts(): Promise<CloudAccount[]> {
    const db = getDb();
    const { decrypt } = require('../../utils/security');
    try {
      const stmt = db.prepare('SELECT * FROM accounts ORDER BY last_used DESC');
      const rows = stmt.all() as any[];

      const accounts = await Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          provider: row.provider,
          email: row.email,
          name: row.name,
          avatar_url: row.avatar_url,
          token: JSON.parse(await decrypt(row.token_json)),
          quota: row.quota_json ? JSON.parse(await decrypt(row.quota_json)) : undefined,
          created_at: row.created_at,
          last_used: row.last_used,
          status: row.status,
          is_active: Boolean(row.is_active),
        })),
      );

      return accounts;
    } finally {
      db.close();
    }
  }

  static async getAccount(id: string): Promise<CloudAccount | undefined> {
    const db = getDb();
    const { decrypt } = require('../../utils/security');
    try {
      const stmt = db.prepare('SELECT * FROM accounts WHERE id = ?');
      const row = stmt.get(id) as any;

      if (!row) return undefined;

      return {
        id: row.id,
        provider: row.provider,
        email: row.email,
        name: row.name,
        avatar_url: row.avatar_url,
        token: JSON.parse(await decrypt(row.token_json)),
        quota: row.quota_json ? JSON.parse(await decrypt(row.quota_json)) : undefined,
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
    const { encrypt } = require('../../utils/security');
    try {
      const encrypted = await encrypt(JSON.stringify(token));
      db.prepare('UPDATE accounts SET token_json = ? WHERE id = ?').run(encrypted, id);
    } finally {
      db.close();
    }
  }

  static async updateQuota(id: string, quota: any): Promise<void> {
    const db = getDb();
    const { encrypt } = require('../../utils/security');
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

  static injectCloudToken(token: CloudAccount['token']): void {
    const dbPath = require('../../utils/paths').getAntigravityDbPath();
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Antigravity database not found at ${dbPath}`);
    }

    const db = new Database(dbPath);
    try {
      const row = db
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('jetskiStateSync.agentManagerInitState') as { value: string } | undefined;

      if (!row || !row.value) {
        throw new Error('jetskiStateSync.agentManagerInitState not found in database');
      }

      // 1. Decode Base64
      const buffer = Buffer.from(row.value, 'base64');
      const data = new Uint8Array(buffer);

      // 2. Remove Field 6
      const cleanData = require('../../utils/protobuf').ProtobufUtils.removeField(data, 6);

      // 3. Create New Field 6
      const newField = require('../../utils/protobuf').ProtobufUtils.createOAuthTokenInfo(
        token.access_token,
        token.refresh_token,
        token.expiry_timestamp,
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

      logger.info('Successfully injected cloud token into Antigravity database.');
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
    const { getAntigravityDbPath } = require('../../utils/paths');
    const { ProtobufUtils } = require('../../utils/protobuf');
    const { GoogleAPIService } = require('../../services/GoogleAPIService');

    const dbPath = getAntigravityDbPath();
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Antigravity database not found at ${dbPath}`);
    }

    const ideDb = new Database(dbPath, { readonly: true });
    try {
      // 1. Read Raw Token Data
      const row = ideDb
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('jetskiStateSync.agentManagerInitState') as { value: string } | undefined;

      if (!row || !row.value) {
        logger.warn('SyncLocal: No token found in IDE database.');
        return null;
      }

      // 2. Decode Protobuf
      const buffer = Buffer.from(row.value, 'base64');
      const data = new Uint8Array(buffer);
      const tokenInfo = ProtobufUtils.extractOAuthTokenInfo(data);

      if (!tokenInfo) {
        logger.warn('SyncLocal: Failed to extract OAuth info from protobuf.');
        return null;
      }

      // 3. Fetch User Info
      // We need to fetch user info to know who this token belongs to
      const userInfo = await GoogleAPIService.getUserInfo(tokenInfo.accessToken);

      // 4. Check Duplicate & Construct Account
      // We use existing addAccount logic which does UPSERT (REPLACE)
      // Construct CloudAccount object
      const now = Math.floor(Date.now() / 1000);
      const account: CloudAccount = {
        id: require('uuid').v4(), // Generate new ID if new, but check existing email
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
      const existing = this.getAccounts().find((a) => a.email === account.email);
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
