import type Database from 'better-sqlite3';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { accounts } from '@/shared/persistence/database/schema';
import { sqliteSchema } from '@/shared/persistence/database/sqlite-metadata';
import { TableInfoRowSchema } from '@/shared/persistence/database/types';

/** A stored incarnation changes only on INSERT, including inserts made by older releases. */
export function ensureCloudAccountLifecycleSchema(db: Database.Database): void {
  const columns = TableInfoRowSchema.array().parse(db.pragma('table_info(accounts)'));
  const hasColumn = columns.some((column) => column.name === 'lifecycle_generation');
  const orm = drizzle(db);
  const hasTrigger = orm
    .select({ name: sqliteSchema.name })
    .from(sqliteSchema)
    .where(
      and(
        eq(sqliteSchema.type, 'trigger'),
        eq(sqliteSchema.name, 'accounts_assign_lifecycle_generation'),
      ),
    )
    .get();
  if (hasColumn && hasTrigger) {
    return;
  }
  db.transaction(() => {
    const columns = TableInfoRowSchema.array().parse(db.pragma('table_info(accounts)'));
    if (!columns.some((column) => column.name === 'lifecycle_generation')) {
      db.exec('ALTER TABLE accounts ADD COLUMN lifecycle_generation TEXT');
    }
    orm
      .update(accounts)
      .set({ lifecycleGeneration: sql`lower(hex(randomblob(16)))` })
      .where(isNull(accounts.lifecycleGeneration))
      .run();
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS accounts_assign_lifecycle_generation
      AFTER INSERT ON accounts WHEN NEW.lifecycle_generation IS NULL
      BEGIN
        UPDATE accounts SET lifecycle_generation = lower(hex(randomblob(16)))
          WHERE id = NEW.id;
      END;
    `);
  }).immediate();
}
