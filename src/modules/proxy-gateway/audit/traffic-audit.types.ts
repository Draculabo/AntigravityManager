import { z } from 'zod';

import { TrafficClassSchema, type TrafficClass } from './traffic-classifier';

export const AuditOutcomeSchema = z.enum([
  'in_progress',
  'completed',
  'client_cancelled',
  'client_disconnected',
  'timeout',
  'upstream_error',
  'auth_failed',
  'internal_error',
]);

export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

export interface AuditPayloadFields {
  bodyBytes: number;
  bodyKind: string;
  bodySha256: string | null;
  bodyText: string | null;
  oversized: boolean;
}

export interface StartAuditParentInput {
  clientIp?: string;
  headers?: Record<string, unknown>;
  method: string;
  model?: string;
  operation?: string;
  protocol: string;
  query?: Record<string, unknown> | string;
  requestBody?: unknown;
  sessionId?: string;
  trafficClass: TrafficClass;
  url: string;
  username?: string;
}

export interface CompleteAuditParentInput {
  error?: unknown;
  mappedModel?: string;
  outcome: AuditOutcome;
  partial?: boolean;
  parseErrorOffset?: number;
  responseRepresentation?: 'reconstructed_sse' | 'redacted_raw_sse';
  responseBody?: unknown;
  responseHeaders?: Record<string, unknown>;
  responsePayloadHandled?: boolean;
  status?: number;
  usage?: {
    cachedTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
  };
  outputModalities?: { hasText: boolean; hasImage: boolean } | null;
}

export interface StartUpstreamAttemptInput {
  accountId?: string;
  endpoint: string;
  headers?: Record<string, unknown>;
  model?: string;
  operation: string;
  requestBody?: unknown;
}

export interface CompleteUpstreamAttemptInput {
  error?: unknown;
  outcome: AuditOutcome;
  partial?: boolean;
  parseErrorOffset?: number;
  responseRepresentation?: 'reconstructed_sse' | 'redacted_raw_sse';
  responseBody?: unknown;
  responseHeaders?: Record<string, unknown>;
  responsePayloadHandled?: boolean;
  status?: number;
}

export const TrafficAuditListInputSchema = z.object({
  accountId: z.string().trim().max(256).optional(),
  from: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  model: z.string().trim().optional(),
  modelFamily: z.string().trim().max(256).optional(),
  modality: z.enum(['text', 'image', 'none', 'unknown']).optional(),
  offset: z.number().int().nonnegative().default(0),
  protocol: z.string().trim().optional(),
  requestId: z.string().trim().optional(),
  status: z.number().int().min(0).max(599).optional(),
  statusMode: z
    .enum(['all', '1xx', '2xx', '3xx', '4xx', '5xx', 'exact', 'unfinished', 'no-status'])
    .optional(),
  trafficClass: TrafficClassSchema.optional(),
  search: z.string().trim().max(512).optional(),
  to: z.number().int().nonnegative().optional(),
});

export type TrafficAuditListInput = z.infer<typeof TrafficAuditListInputSchema>;

export const TrafficAuditSummarySchema = z.object({
  attributedAccountId: z.string().nullable(),
  completedAt: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  id: z.string(),
  hasImageOutput: z.boolean().nullable(),
  hasTextOutput: z.boolean().nullable(),
  inputTokens: z.number().int().nullable(),
  mappedModel: z.string().nullable(),
  method: z.string(),
  model: z.string().nullable(),
  outcome: AuditOutcomeSchema,
  outputTokens: z.number().int().nullable(),
  physicalModel: z.string().nullable(),
  physicalModelFamily: z.string().nullable(),
  protocol: z.string(),
  recordKind: z.enum(['request', 'admin']),
  status: z.number().int().nullable(),
  timestamp: z.number().int(),
  trafficClass: TrafficClassSchema,
  url: z.string(),
});

export type TrafficAuditSummary = z.infer<typeof TrafficAuditSummarySchema>;

export const TrafficAuditBodyDescriptorSchema = z.object({
  chunkCount: z.number().int().nonnegative(),
  completedAt: z.number().int().nullable(),
  direction: z.enum(['request', 'response']),
  droppedReason: z.string().nullable(),
  errorSummary: z.string().nullable(),
  id: z.string().uuid(),
  kind: z.enum(['empty', 'json', 'text', 'binary', 'sse']),
  logicalBytes: z.number().int().nonnegative(),
  oversized: z.boolean(),
  ownerId: z.string(),
  ownerKind: z.enum(['parent', 'attempt']),
  parseErrorOffset: z.number().int().nonnegative().nullable(),
  partial: z.boolean(),
  representation: z.enum([
    'sanitized_json',
    'sanitized_text',
    'binary_summary',
    'reconstructed_sse',
    'redacted_raw_sse',
  ]),
  sha256: z.string().nullable(),
  sha256Scope: z.enum(['full', 'stored_prefix', 'unavailable']),
  state: z.enum(['writing', 'complete', 'incomplete', 'expired']),
  storedBytes: z.number().int().nonnegative(),
  terminalStatus: z.string().nullable(),
});

export type TrafficAuditBodyDescriptor = z.infer<typeof TrafficAuditBodyDescriptorSchema>;

export const TrafficAuditRequestDetailSchema = z.object({
  attributedAccountId: z.string().nullable(),
  cachedTokens: z.number().int().nullable(),
  clientIp: z.string().nullable(),
  completedAt: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
  id: z.string(),
  hasImageOutput: z.boolean().nullable(),
  hasTextOutput: z.boolean().nullable(),
  inputTokens: z.number().int().nullable(),
  mappedModel: z.string().nullable(),
  method: z.string(),
  model: z.string().nullable(),
  operation: z.string().nullable(),
  outcome: AuditOutcomeSchema,
  outputTokens: z.number().int().nullable(),
  physicalModel: z.string().nullable(),
  physicalModelFamily: z.string().nullable(),
  protocol: z.string(),
  reasoningTokens: z.number().int().nullable(),
  requestHeaders: z.string(),
  requestQuery: z.string().nullable(),
  responseHeaders: z.string().nullable(),
  responsePartial: z.boolean(),
  sessionId: z.string().nullable(),
  status: z.number().int().nullable(),
  timestamp: z.number().int(),
  trafficClass: TrafficClassSchema,
  url: z.string(),
  username: z.string().nullable(),
});

export const TrafficAuditAttemptDetailSchema = z.object({
  accountId: z.string().nullable(),
  accountIdHash: z.string().nullable(),
  attemptIndex: z.number().int().nonnegative(),
  completedAt: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  endpoint: z.string(),
  error: z.string().nullable(),
  id: z.string(),
  model: z.string().nullable(),
  operation: z.string(),
  outcome: AuditOutcomeSchema,
  parentId: z.string(),
  requestHeaders: z.string(),
  responseHeaders: z.string().nullable(),
  responsePartial: z.boolean(),
  status: z.number().int().nullable(),
  timestamp: z.number().int(),
});

const TrafficAuditRequestRecordDetailSchema = z.object({
  attempts: z.array(TrafficAuditAttemptDetailSchema),
  bodies: z.array(TrafficAuditBodyDescriptorSchema),
  recordKind: z.literal('request'),
  request: TrafficAuditRequestDetailSchema,
});

const TrafficAuditAdminRecordDetailSchema = z.object({
  event: z.object({
    affectedCount: z.number().int().nullable(),
    error: z.string().nullable(),
    id: z.number().int().positive(),
    operation: z.string(),
    outcome: z.string(),
    timestamp: z.number().int().nonnegative(),
  }),
  recordKind: z.literal('admin'),
});

export const TrafficAuditDetailSchema = z.discriminatedUnion('recordKind', [
  TrafficAuditRequestRecordDetailSchema,
  TrafficAuditAdminRecordDetailSchema,
]);

export type TrafficAuditDetail = z.infer<typeof TrafficAuditDetailSchema>;

export const TrafficAuditBodyPageInputSchema = z.object({
  bodyId: z.string().uuid(),
  cursor: z.number().int().nonnegative().default(0),
  limitBytes: z
    .number()
    .int()
    .min(1)
    .max(256 * 1024)
    .default(256 * 1024),
});

export type TrafficAuditBodyPageInput = z.infer<typeof TrafficAuditBodyPageInputSchema>;

export const TrafficAuditBodyPageSchema = z.object({
  body: TrafficAuditBodyDescriptorSchema,
  chunks: z.array(
    z.object({
      data: z.string(),
      sequence: z.number().int().nonnegative(),
    }),
  ),
  complete: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export type TrafficAuditBodyPage = z.infer<typeof TrafficAuditBodyPageSchema>;

export const TrafficAuditBodySearchInputSchema = z.object({
  bodyId: z.string().uuid(),
  limit: z.number().int().min(1).max(200).default(100),
  query: z.string().min(1).max(512),
});

export type TrafficAuditBodySearchInput = z.infer<typeof TrafficAuditBodySearchInputSchema>;

export const TrafficAuditBodySearchResultSchema = z.object({
  matches: z.array(
    z.object({
      length: z.number().int().positive(),
      offset: z.number().int().nonnegative(),
      sequence: z.number().int().nonnegative(),
      chunkOffset: z.number().int().nonnegative(),
      snippet: z.string(),
    }),
  ),
  truncated: z.boolean(),
});

export type TrafficAuditBodySearchResult = z.infer<typeof TrafficAuditBodySearchResultSchema>;

export const TrafficAuditListResultSchema = z.object({
  items: z.array(TrafficAuditSummarySchema),
  total: z.number().int().nonnegative(),
});

export const TrafficAuditFilterOptionsSchema = z.object({
  accountIds: z.array(z.string()),
  modelFamilies: z.array(z.string()),
});

export const TrafficAuditEventSchema = z.object({
  id: z.string(),
  kind: z.enum(['created', 'updated', 'deleted', 'cleared']),
  timestamp: z.number().int().nonnegative(),
  trafficClass: TrafficClassSchema.optional(),
});

export type TrafficAuditEvent = z.infer<typeof TrafficAuditEventSchema>;

export const TrafficAuditStatsSchema = z.object({
  bodyStoredBytes: z.number().int().nonnegative(),
  databaseBytes: z.number().int().nonnegative(),
  droppedCount: z.number().int().nonnegative(),
  incompleteBodies: z.number().int().nonnegative(),
  lastDropReason: z.string().nullable(),
  oldestTimestamp: z.number().int().nullable(),
  rows: z.number().int().nonnegative(),
  workerAlive: z.boolean(),
  workerPendingBytes: z.number().int().nonnegative(),
  workerPendingCommands: z.number().int().nonnegative(),
});

export type TrafficAuditStats = z.infer<typeof TrafficAuditStatsSchema>;
