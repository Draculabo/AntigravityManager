import Database from 'better-sqlite3';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { TableInfoRowSchema } from '@/shared/persistence/database/types';

export function ensureGoogleUsageIdentitySchema(database: Database.Database, path: string): void {
  const columns = TableInfoRowSchema.array().parse(database.pragma('table_info(accounts)'));
  if (columns.some((column) => column.name === 'google_usage_identity_json')) {
    return;
  }
  const source = fs.lstatSync(path);
  if (!source.isFile() || source.isSymbolicLink()) {
    throw new Error('Account identity migration requires a regular database file');
  }
  const backupPath = `${path}.google-usage-backup-${Date.now()}-${randomUUID()}`;
  const descriptor = fs.openSync(backupPath, 'wx', 0o600);
  fs.closeSync(descriptor);
  database.prepare('VACUUM INTO ?').run(backupPath);
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    if (backup.pragma('quick_check', { simple: true }) !== 'ok') {
      throw new Error('Account identity migration backup verification failed');
    }
  } finally {
    backup.close();
  }
  const backupDescriptor = fs.openSync(backupPath, 'r+');
  try {
    fs.fsyncSync(backupDescriptor);
  } finally {
    fs.closeSync(backupDescriptor);
  }
  database.transaction(() => {
    const current = TableInfoRowSchema.array().parse(database.pragma('table_info(accounts)'));
    if (!current.some((column) => column.name === 'google_usage_identity_json')) {
      database.exec('ALTER TABLE accounts ADD COLUMN google_usage_identity_json TEXT');
    }
  }).immediate();
}
