import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const errorWindowMeta = sqliteTable('error_window_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const errorWindowRecords = sqliteTable('error_window_records', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  id: text('record_id').notNull().unique(),
  createdAt: text('created_at').notNull(),
  source: text('source').notNull(),
  category: text('category').notNull(),
  requestId: text('request_id'),
  attemptId: text('attempt_id'),
  status: integer('status'),
  message: text('message').notNull(),
  body: text('body').notNull(),
  bytes: integer('bytes').notNull(),
});
