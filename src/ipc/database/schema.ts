import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  email: text('email').notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  tokenJson: text('token_json').notNull(),
  quotaJson: text('quota_json'),
  createdAt: integer('created_at').notNull(),
  lastUsed: integer('last_used').notNull(),
  status: text('status'),
  isActive: integer('is_active').notNull().default(0),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const itemTable = sqliteTable('ItemTable', {
  key: text('key').primaryKey(),
  value: text('value'),
});
