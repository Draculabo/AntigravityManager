import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const requestLogs = sqliteTable(
  'request_logs',
  {
    id: text('id').primaryKey(),
    timestamp: integer('timestamp').notNull(),
    completedAt: integer('completed_at'),
    method: text('method').notNull(),
    url: text('url').notNull(),
    protocol: text('protocol').notNull(),
    trafficClass: text('traffic_class').notNull(),
    operation: text('operation'),
    model: text('model'),
    mappedModel: text('mapped_model'),
    attributedAccountId: text('attributed_account_id'),
    physicalModel: text('physical_model'),
    physicalModelFamily: text('physical_model_family'),
    hasTextOutput: integer('has_text_output', { mode: 'boolean' }),
    hasImageOutput: integer('has_image_output', { mode: 'boolean' }),
    sessionId: text('session_id'),
    clientIp: text('client_ip'),
    username: text('username'),
    requestHeaders: text('request_headers').notNull(),
    requestQuery: text('request_query'),
    status: integer('status'),
    durationMs: integer('duration_ms'),
    outcome: text('outcome').notNull(),
    error: text('error'),
    responseHeaders: text('response_headers'),
    responsePartial: integer('response_partial', { mode: 'boolean' }).notNull().default(false),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cachedTokens: integer('cached_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
  },
  (table) => [
    index('idx_request_timestamp').on(table.timestamp),
    index('idx_request_protocol_timestamp').on(table.protocol, table.timestamp),
    index('idx_request_class_timestamp').on(table.trafficClass, table.timestamp),
    index('idx_request_model_timestamp').on(table.model, table.timestamp),
    index('idx_request_status_timestamp').on(table.status, table.timestamp),
    index('idx_request_account_timestamp').on(table.attributedAccountId, table.timestamp),
    index('idx_request_family_timestamp').on(table.physicalModelFamily, table.timestamp),
    index('idx_request_session_timestamp').on(table.sessionId, table.timestamp),
  ],
);

export const upstreamAttempts = sqliteTable(
  'upstream_attempts',
  {
    id: text('id').primaryKey(),
    parentId: text('parent_id')
      .notNull()
      .references(() => requestLogs.id, { onDelete: 'cascade' }),
    attemptIndex: integer('attempt_index').notNull(),
    timestamp: integer('timestamp').notNull(),
    completedAt: integer('completed_at'),
    operation: text('operation').notNull(),
    endpoint: text('endpoint').notNull(),
    accountId: text('account_id'),
    accountIdHash: text('account_id_hash'),
    model: text('model'),
    requestHeaders: text('request_headers').notNull(),
    status: integer('status'),
    durationMs: integer('duration_ms'),
    outcome: text('outcome').notNull(),
    error: text('error'),
    responseHeaders: text('response_headers'),
    responsePartial: integer('response_partial', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [uniqueIndex('idx_attempt_parent_order').on(table.parentId, table.attemptIndex)],
);

export const auditPayloads = sqliteTable(
  'audit_payloads',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id')
      .notNull()
      .references(() => requestLogs.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    representation: text('representation').notNull(),
    state: text('state').notNull(),
    logicalBytes: integer('logical_bytes').notNull().default(0),
    storedBytes: integer('stored_bytes').notNull().default(0),
    rawBytes: integer('raw_bytes'),
    sha256: text('sha256'),
    sha256Scope: text('sha256_scope').notNull().default('unavailable'),
    chunkCount: integer('chunk_count').notNull().default(0),
    oversized: integer('oversized', { mode: 'boolean' }).notNull().default(false),
    partial: integer('partial', { mode: 'boolean' }).notNull().default(false),
    terminalStatus: text('terminal_status'),
    parseErrorOffset: integer('parse_error_offset'),
    errorSummary: text('error_summary'),
    droppedReason: text('dropped_reason'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (table) => [
    index('idx_payload_request_created').on(table.requestId, table.createdAt),
    index('idx_payload_retention').on(table.state, table.createdAt),
  ],
);

export const auditPayloadChunks = sqliteTable(
  'audit_payload_chunks',
  {
    payloadId: text('payload_id')
      .notNull()
      .references(() => auditPayloads.id, { onDelete: 'cascade' }),
    sequence: integer('seq').notNull(),
    payload: blob('payload', { mode: 'buffer' }).notNull(),
    byteLength: integer('byte_length').notNull(),
    encoding: text('encoding').notNull().default('raw'),
  },
  (table) => [primaryKey({ columns: [table.payloadId, table.sequence] })],
);

export const requestBodyRefs = sqliteTable(
  'request_body_refs',
  {
    requestId: text('request_id')
      .notNull()
      .references(() => requestLogs.id, { onDelete: 'cascade' }),
    direction: text('direction').notNull(),
    payloadId: text('payload_id')
      .notNull()
      .references(() => auditPayloads.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.requestId, table.direction] })],
);

export const attemptBodyRefs = sqliteTable(
  'attempt_body_refs',
  {
    attemptId: text('attempt_id')
      .notNull()
      .references(() => upstreamAttempts.id, { onDelete: 'cascade' }),
    direction: text('direction').notNull(),
    payloadId: text('payload_id')
      .notNull()
      .references(() => auditPayloads.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.attemptId, table.direction] })],
);

export const auditDropStats = sqliteTable(
  'audit_drop_stats',
  {
    trafficClass: text('traffic_class').notNull(),
    reason: text('reason').notNull(),
    count: integer('count').notNull(),
    droppedBytes: integer('dropped_bytes').notNull().default(0),
    lastSeen: integer('last_seen').notNull(),
  },
  (table) => [primaryKey({ columns: [table.trafficClass, table.reason] })],
);

export const auditAdminEvents = sqliteTable('audit_admin_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp').notNull(),
  operation: text('operation').notNull(),
  outcome: text('outcome').notNull(),
  affectedCount: integer('affected_count'),
  error: text('error'),
});

export const trafficAuditSchema = {
  attemptBodyRefs,
  auditAdminEvents,
  auditDropStats,
  auditPayloadChunks,
  auditPayloads,
  requestBodyRefs,
  requestLogs,
  upstreamAttempts,
};
