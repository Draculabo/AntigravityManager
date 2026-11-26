import { isNotNull } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { blob, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const thinkingMeta = sqliteTable('thinking_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

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
    operationId: text('operation_id'),
    causalAnchor: text('causal_anchor'),
    completedAt: integer('completed_at'),
    captureState: text('capture_state', { enum: ['complete', 'partial', 'history', 'legacy'] })
      .notNull()
      .default('legacy'),
    thought: blob('thought', { mode: 'buffer' }),
    thoughtBytes: integer('thought_bytes').notNull().default(0),
    signature: text('signature'),
    partSignatures: text('part_signatures').notNull(),
    signatureBytes: integer('signature_bytes').notNull(),
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
      .where(isNotNull(table.primaryToolId)),
    index('idx_thought_fingerprint').on(table.sessionKey, table.fingerprint),
    index('idx_thought_operation').on(table.sessionKey, table.operationId),
    index('idx_thought_causal').on(table.sessionKey, table.causalAnchor, table.model),
  ],
);

export const thinkingToolLinks = sqliteTable(
  'thinking_tool_links',
  {
    recordId: integer('record_id')
      .notNull()
      .references(() => thinkingRecords.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    completedAt: integer('completed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.recordId, table.position] }),
    index('idx_thought_tool_expiry').on(table.completedAt, table.recordId, table.position),
  ],
);

export const thoughtStoreSchema = {
  thinkingMeta,
  thinkingRecords,
  thinkingSessions,
  thinkingToolLinks,
};

export type ThoughtStoreDatabase = BetterSQLite3Database<typeof thoughtStoreSchema>;
