import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  email: text('email').notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  tokenJson: text('token_json').notNull(),
  quotaJson: text('quota_json'),
  healthJson: text('health_json'),
  deviceProfileJson: text('device_profile_json'),
  deviceHistoryJson: text('device_history_json'),
  createdAt: integer('created_at').notNull(),
  lastUsed: integer('last_used').notNull(),
  status: text('status', { enum: ['active', 'rate_limited', 'expired'] }).default('active'),
  statusReason: text('status_reason'),
  isActive: integer('is_active').notNull().default(0),
  proxyUrl: text('proxy_url'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const itemTable = sqliteTable('ItemTable', {
  key: text('key').primaryKey(),
  value: text('value'),
});

export const workspaceProfiles = sqliteTable('workspace_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  accountId: text('account_id').notNull(),
  projectPath: text('project_path').notNull(),
  userDataDir: text('user_data_dir').notNull(),
  createdAt: integer('created_at').notNull(),
  lastLaunchedAt: integer('last_launched_at'),
});

export type WorkspaceProfileSelect = typeof workspaceProfiles.$inferSelect;
export type WorkspaceProfileInsert = typeof workspaceProfiles.$inferInsert;
