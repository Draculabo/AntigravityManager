import type Database from 'better-sqlite3';
import { z } from 'zod';

export type ErrorDiagnosticRole = 'app' | 'core';
const ObjectsSchema = z.array(z.object({ name: z.string(), type: z.string() })).max(3);
const RoleSchema = z.object({ value: z.enum(['app', 'core']) });
const OWNED_TABLES = new Set(['error_window_meta', 'error_window_records']);

/** A new dedicated format; unknown databases are refused without rebuilding their data. */
export function initializeErrorWindow(
  database: Database.Database,
  role: ErrorDiagnosticRole,
): void {
  const version = database.pragma('user_version', { simple: true });
  if (version !== 0 && version !== 1) {
    throw new Error('Unsupported local error diagnostic schema');
  }
  const objects = ObjectsSchema.parse(
    database
      .prepare(
        "SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','trigger') LIMIT 3",
      )
      .all(),
  );
  if (
    objects.some((entry) => entry.type !== 'table' || !OWNED_TABLES.has(entry.name)) ||
    (version === 0 && objects.length > 0) ||
    (version === 1 && objects.length !== 2)
  ) {
    throw new Error('Local error diagnostic database contains unowned objects');
  }
  if (version === 1) {
    const savedRole = RoleSchema.parse(
      database.prepare("SELECT value FROM error_window_meta WHERE key='role'").get(),
    );
    if (savedRole.value !== role) {
      throw new Error('Local error diagnostic role mismatch');
    }
    database
      .prepare(
        'SELECT sequence,record_id,created_at,source,category,request_id,attempt_id,status,message,body,bytes FROM error_window_records LIMIT 0',
      )
      .all();
  } else {
    database.pragma('auto_vacuum = INCREMENTAL');
    database
      .transaction(() => {
        database.exec(
          'CREATE TABLE error_window_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);' +
            'CREATE TABLE error_window_records(' +
            'sequence INTEGER PRIMARY KEY AUTOINCREMENT,record_id TEXT NOT NULL UNIQUE,' +
            'created_at TEXT NOT NULL,source TEXT NOT NULL,category TEXT NOT NULL,' +
            'request_id TEXT,attempt_id TEXT,status INTEGER,message TEXT NOT NULL,' +
            'body TEXT NOT NULL,bytes INTEGER NOT NULL);' +
            'CREATE INDEX idx_error_window_oldest ON error_window_records(created_at,sequence);' +
            'CREATE INDEX idx_error_window_request ON error_window_records(request_id,sequence);' +
            'CREATE INDEX idx_error_window_sizes ON error_window_records(bytes);',
        );
        database.prepare('INSERT INTO error_window_meta(key,value) VALUES(?,?)').run('role', role);
        database.pragma('user_version = 1');
      })
      .immediate();
  }
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 0');
}
