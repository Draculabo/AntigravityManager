import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getCloudAccountsDbPath } from '@/shared/platform/paths';
import { logger } from '@/shared/logging/logger';
import { TableInfoRowSchema } from '@/shared/persistence/database/types';
import { parseRows } from '@/shared/persistence/database/sqlite';
import {
  configureDatabase,
  openDrizzleConnection,
} from '@/shared/persistence/database/dbConnection';
import * as drizzleSchema from '@/shared/persistence/database/schema';

export const CLOUD_ACCOUNT_SQLITE_BUSY_TIMEOUT_MS = 3000;

export type DrizzleExecutor = Pick<
  BetterSQLite3Database<typeof drizzleSchema>,
  'insert' | 'update' | 'delete' | 'select'
>;

function ensureDatabaseInitialized(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath);
    configureDatabase(db, { busyTimeoutMs: CLOUD_ACCOUNT_SQLITE_BUSY_TIMEOUT_MS });

    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT,
        avatar_url TEXT,
        token_json TEXT NOT NULL,
        quota_json TEXT,
        device_profile_json TEXT,
        device_history_json TEXT,
        created_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        status TEXT DEFAULT 'active',
        status_reason TEXT,
        is_active INTEGER DEFAULT 0
      );
    `);

    const tableInfoRaw = db.pragma('table_info(accounts)') as unknown[];
    const tableInfo = parseRows(TableInfoRowSchema, tableInfoRaw, 'cloud.accounts.tableInfo');
    const hasIsActive = tableInfo.some((col) => col.name === 'is_active');
    const hasDeviceProfileJson = tableInfo.some((col) => col.name === 'device_profile_json');
    const hasDeviceHistoryJson = tableInfo.some((col) => col.name === 'device_history_json');
    const hasProxyUrl = tableInfo.some((col) => col.name === 'proxy_url');
    const hasStatusReason = tableInfo.some((col) => col.name === 'status_reason');
    if (!hasIsActive) {
      db.exec('ALTER TABLE accounts ADD COLUMN is_active INTEGER DEFAULT 0');
    }
    if (!hasDeviceProfileJson) {
      db.exec('ALTER TABLE accounts ADD COLUMN device_profile_json TEXT');
    }
    if (!hasDeviceHistoryJson) {
      db.exec('ALTER TABLE accounts ADD COLUMN device_history_json TEXT');
    }
    if (!hasProxyUrl) {
      db.exec('ALTER TABLE accounts ADD COLUMN proxy_url TEXT');
    }
    if (!hasStatusReason) {
      db.exec('ALTER TABLE accounts ADD COLUMN status_reason TEXT');
    }

    db.exec(`CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS cleanup_active_cloud_account_settings
      AFTER DELETE ON accounts
      BEGIN
        DELETE FROM settings
        WHERE key IN (
          'active_cloud_account.classic',
          'active_cloud_account.ide',
          'active_cloud_account.agy'
        )
        AND value = json_quote(OLD.id);
      END;
    `);
  } catch (error) {
    logger.error('Failed to initialize cloud database schema', error);
    throw error;
  } finally {
    if (db) {
      db.close();
    }
  }
}

export function getCloudDb(): {
  raw: Database.Database;
  orm: BetterSQLite3Database<typeof drizzleSchema>;
} {
  const dbPath = getCloudAccountsDbPath();
  ensureDatabaseInitialized(dbPath);
  return openDrizzleConnection(
    dbPath,
    { readonly: false, fileMustExist: false },
    { busyTimeoutMs: CLOUD_ACCOUNT_SQLITE_BUSY_TIMEOUT_MS },
  );
}
