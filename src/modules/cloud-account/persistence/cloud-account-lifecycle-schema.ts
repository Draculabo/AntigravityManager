import type Database from 'better-sqlite3';
import { TableInfoRowSchema } from '@/shared/persistence/database/types';

/** A stored incarnation changes only on INSERT, including inserts made by older releases. */
export function ensureCloudAccountLifecycleSchema(db: Database.Database): void {
  const columns = TableInfoRowSchema.array().parse(db.pragma('table_info(accounts)'));
  const hasColumn = columns.some((column) => column.name === 'lifecycle_generation');
  const hasTrigger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get('accounts_assign_lifecycle_generation');
  if (hasColumn && hasTrigger) {
    return;
  }
  db.transaction(() => {
    const columns = TableInfoRowSchema.array().parse(db.pragma('table_info(accounts)'));
    if (!columns.some((column) => column.name === 'lifecycle_generation')) {
      db.exec('ALTER TABLE accounts ADD COLUMN lifecycle_generation TEXT');
    }
    db.exec(`
      UPDATE accounts SET lifecycle_generation = lower(hex(randomblob(16)))
        WHERE lifecycle_generation IS NULL;
      CREATE TRIGGER IF NOT EXISTS accounts_assign_lifecycle_generation
      AFTER INSERT ON accounts WHEN NEW.lifecycle_generation IS NULL
      BEGIN
        UPDATE accounts SET lifecycle_generation = lower(hex(randomblob(16)))
          WHERE id = NEW.id;
      END;
    `);
  }).immediate();
}
