import { z } from 'zod';

import { TrafficClassSchema } from './traffic-classifier';

const NullableString = z.string().nullable();
const NullableInteger = z.number().int().nullable();
const RetentionPayloadSchema = z.object({
  bodyRetentionHours: z.number().nonnegative(),
  maxDiskBytes: z.number().int().nonnegative(),
  maxRows: z.number().int().nonnegative(),
  summaryRetentionDays: z.number().nonnegative(),
});
const FinalizePayloadSchema = z.object({
  completedAt: z.number().int().nonnegative(),
  droppedReason: NullableString,
  errorSummary: NullableString,
  id: z.string().min(1),
  logicalBytes: z.number().int().nonnegative(),
  oversized: z.number().int().min(0).max(1),
  parseErrorOffset: NullableInteger,
  partial: z.number().int().min(0).max(1),
  rawBytes: NullableInteger,
  sha256: NullableString,
  sha256Scope: z.string(),
  state: z.string(),
  terminalStatus: NullableString,
});

export const TrafficAuditWorkerCommandSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('insertParent'),
    payload: z.object({
      clientIp: NullableString,
      id: z.string().min(1),
      method: z.string(),
      model: NullableString,
      operation: NullableString,
      protocol: z.string(),
      requestHeaders: z.string(),
      requestQuery: NullableString,
      sessionId: NullableString,
      timestamp: z.number().int().nonnegative(),
      trafficClass: TrafficClassSchema,
      url: z.string(),
      username: NullableString,
    }),
  }),
  z.object({
    operation: z.literal('completeParent'),
    payload: z.object({
      cachedTokens: NullableInteger,
      completedAt: z.number().int().nonnegative(),
      durationMs: z.number().int().nonnegative(),
      error: NullableString,
      id: z.string().min(1),
      hasImageOutput: z.boolean().nullable(),
      hasTextOutput: z.boolean().nullable(),
      inputTokens: NullableInteger,
      mappedModel: NullableString,
      outcome: z.string(),
      outputTokens: NullableInteger,
      reasoningTokens: NullableInteger,
      responseHeaders: NullableString,
      responsePartial: z.number().int().min(0).max(1),
      status: NullableInteger,
    }),
  }),
  z.object({
    operation: z.literal('insertAttempt'),
    payload: z.object({
      accountId: NullableString,
      accountIdHash: NullableString,
      attemptIndex: z.number().int().positive(),
      endpoint: z.string(),
      id: z.string().min(1),
      model: NullableString,
      operation: z.string(),
      parentId: z.string().min(1),
      requestHeaders: z.string(),
      timestamp: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    operation: z.literal('completeAttempt'),
    payload: z.object({
      completedAt: z.number().int().nonnegative(),
      durationMs: z.number().int().nonnegative(),
      error: NullableString,
      id: z.string().min(1),
      outcome: z.string(),
      responseHeaders: NullableString,
      responsePartial: z.number().int().min(0).max(1),
      status: NullableInteger,
    }),
  }),
  z.object({
    operation: z.literal('beginPayload'),
    payload: z.object({
      createdAt: z.number().int().nonnegative(),
      direction: z.enum(['request', 'response']),
      id: z.string().min(1),
      kind: z.string(),
      ownerId: z.string().min(1),
      ownerKind: z.enum(['parent', 'attempt']),
      parentId: z.string().min(1),
      representation: z.string(),
    }),
  }),
  z.object({
    operation: z.literal('appendPayloadChunk'),
    payload: z.object({
      data: z.string(),
      payloadId: z.string().min(1),
      sequence: z.number().int().nonnegative(),
    }),
  }),
  z.object({ operation: z.literal('finalizePayload'), payload: FinalizePayloadSchema }),
  z.object({
    operation: z.literal('finalizeSsePayload'),
    payload: z.object({
      completedAt: z.number().int().nonnegative(),
      droppedReason: NullableString,
      errorSummary: NullableString,
      id: z.string().min(1),
      parseErrorOffset: NullableInteger,
      partial: z.number().int().min(0).max(1),
      rawBytes: z.number().int().nonnegative(),
      sanitizedBytes: z.number().int().nonnegative(),
      sanitizedSha256: NullableString,
      terminalStatus: z.string(),
    }),
  }),
  z.object({
    operation: z.literal('drop'),
    payload: z.object({
      count: z.number().int().positive(),
      droppedBytes: z.number().int().nonnegative(),
      lastSeen: z.number().int().nonnegative(),
      reason: z.string(),
      trafficClass: TrafficClassSchema,
    }),
  }),
  z.object({
    operation: z.literal('adminEvent'),
    payload: z.object({
      affectedCount: NullableInteger,
      error: NullableString,
      operation: z.string(),
      outcome: z.string(),
      timestamp: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    operation: z.literal('list'),
    payload: z.object({
      accountId: z.string().optional(),
      from: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive(),
      model: z.string().optional(),
      modelFamily: z.string().optional(),
      modality: z.enum(['text', 'image', 'none', 'unknown']).optional(),
      offset: z.number().int().nonnegative(),
      protocol: z.string().optional(),
      requestId: z.string().optional(),
      status: z.number().int().optional(),
      statusMode: z
        .enum(['all', '1xx', '2xx', '3xx', '4xx', '5xx', 'exact', 'unfinished', 'no-status'])
        .optional(),
      trafficClass: TrafficClassSchema.optional(),
      search: z.string().optional(),
      to: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({ operation: z.literal('filterOptions'), payload: z.null() }),
  z.object({ operation: z.literal('detail'), payload: z.object({ id: z.string().min(1) }) }),
  z.object({
    operation: z.literal('bodyPage'),
    payload: z.object({
      bodyId: z.string().min(1),
      cursor: z.number().int().nonnegative(),
      limitBytes: z.number().int().positive(),
    }),
  }),
  z.object({
    operation: z.literal('bodySearch'),
    payload: z.object({
      bodyId: z.string().min(1),
      limit: z.number().int().positive().max(200),
      query: z.string().min(1).max(512),
    }),
  }),
  z.object({ operation: z.literal('delete'), payload: z.object({ id: z.string().min(1) }) }),
  z.object({
    operation: z.literal('clear'),
    payload: z.object({ trafficClass: TrafficClassSchema.nullable() }),
  }),
  z.object({ operation: z.literal('stats'), payload: z.null() }),
  z.object({ operation: z.literal('maintenance'), payload: RetentionPayloadSchema }),
  z.object({ operation: z.literal('configure'), payload: RetentionPayloadSchema }),
  z.object({ operation: z.literal('shutdown'), payload: z.null() }),
]);

export type TrafficAuditWorkerCommand = z.infer<typeof TrafficAuditWorkerCommandSchema>;

export const TrafficAuditWorkerMessageSchema = z.object({
  id: z.number().int().positive(),
  operation: z.string(),
  payload: z.unknown(),
});
