import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sqliteSchema = sqliteTable('sqlite_master', {
  name: text('name').notNull(),
  type: text('type').notNull(),
});
