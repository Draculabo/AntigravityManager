import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export interface DbConfigOptions {
  readOnly?: boolean;
  busyTimeoutMs?: number;
  enableWal?: boolean;
}

export interface DrizzleConnection {
  raw: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
}

export function configureDatabase(db: Database.Database, options: DbConfigOptions = {}): void {
  const busyTimeoutMs = options.busyTimeoutMs ?? 3000;
  const enableWal = options.enableWal ?? !options.readOnly;
  if (enableWal) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
}

export function openDrizzleConnection(
  dbPath: string,
  options: Database.Options = {},
  config: DbConfigOptions = {},
): DrizzleConnection {
  const raw = new Database(dbPath, options);
  configureDatabase(raw, config);
  const orm = drizzle(raw, { schema });
  return { raw, orm };
}
