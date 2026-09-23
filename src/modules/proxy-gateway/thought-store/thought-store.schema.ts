import { sql } from 'drizzle-orm';
import { blob, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const thinkingSessions = sqliteTable(
  'thinking_sessions',
  {
    sessionKey: text('session_key').primaryKey(),
    lastAccessed: integer('last_accessed').notNull(),
    endedAt: integer('ended_at'),
  },
  (table) => [index('idx_thought_accessed').on(table.lastAccessed)],
);

export const thinkingRecords = sqliteTable(
  'thinking_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionKey: text('session_key')
      .notNull()
      .references(() => thinkingSessions.sessionKey, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    thought: blob('thought', { mode: 'buffer' }),
    thoughtBytes: integer('thought_bytes').notNull().default(0),
    signature: text('signature'),
    toolIds: text('tool_ids').notNull(),
    toolNames: text('tool_names').notNull(),
    primaryToolId: text('primary_tool_id'),
    visible: text('visible').notNull(),
    model: text('model'),
    sourceFamily: text('source_family'),
    oversized: integer('oversized', { mode: 'boolean' }).notNull().default(false),
    oversizedBytes: integer('oversized_bytes'),
    oversizedSha256: text('oversized_sha256'),
    createdAt: integer('created_at').notNull(),
    lastAccessed: integer('last_accessed').notNull(),
  },
  (table) => [
    index('idx_thought_sequence').on(table.sessionKey, table.id),
    index('idx_thought_latest').on(table.sessionKey, table.id),
    index('idx_thought_tool')
      .on(table.sessionKey, table.primaryToolId)
      .where(sql`${table.primaryToolId} is not null`),
    index('idx_thought_fingerprint').on(table.sessionKey, table.fingerprint),
  ],
);

export const thoughtStoreSchema = {
  thinkingRecords,
  thinkingSessions,
};
