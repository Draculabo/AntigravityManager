import { z } from 'zod';
import { omitThoughtSignaturePlaceholder } from '../antigravity/ThoughtSignatureCompat';
import { ThoughtPartSignaturesSchema } from './thought-part-signatures';
import { ThoughtRecordPageInputSchema } from './thought-management.schema';
import { ThoughtProvenanceSchema } from './thought-record-provenance';
import { ThoughtCandidateInputSchema } from './thought-candidate-query';
import { ThoughtToolRecoveryInputSchema } from './thought-tool-recovery.schema';

const SessionKeyPayloadSchema = z.object({ sessionKey: z.string().min(1).max(512) });
const CleanupPayloadSchema = z.object({
  protectedSessionKeys: z.array(z.string().min(1).max(512)).max(2000).optional(),
  maxSessions: z.number().int().nonnegative().max(2000),
  retentionDays: z.number().nonnegative(),
  maxDiskBytes: z
    .number()
    .int()
    .min(1)
    .max(16_384 * 1024 * 1024)
    .optional(),
});
const SavePayloadSchema = z.object({
  ...ThoughtProvenanceSchema.shape,
  createdAt: z.number().int().nonnegative(),
  fingerprint: z.string().max(512),
  maxSessionBytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  maxSessions: z.number().int().positive().max(2000),
  maxTurns: z.number().int().positive().max(10_000),
  maxDiskBytes: z
    .number()
    .int()
    .min(1)
    .max(16_384 * 1024 * 1024)
    .optional(),
  meaningful: z.boolean(),
  model: z.string().max(256).nullable(),
  sessionKey: z.string().min(1).max(512),
  signature: z
    .string()
    .max(16 * 1024 * 1024)
    .nullable()
    .transform(omitThoughtSignaturePlaceholder),
  partSignatures: ThoughtPartSignaturesSchema,
  sourceFamily: z.string().max(128).nullable(),
  thought: z.string().max(64 * 1024 * 1024),
  toolIds: z.array(z.string().max(512)).max(2000),
  toolNames: z.array(z.string().max(256)).max(2000),
  visible: z.string().max(64 * 1024 * 1024),
});

export const ThoughtStoreWorkerCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('save'), payload: SavePayloadSchema }),
  z.object({
    operation: z.literal('ingestHistory'),
    payload: z.object({
      records: z.array(SavePayloadSchema).max(10_000),
      sessionKey: z.string().min(1).max(512),
    }),
  }),
  z.object({
    operation: z.literal('load'),
    payload: SessionKeyPayloadSchema.extend({
      maxTurns: z.number().int().min(1).max(10_000).optional(),
      maxSessionBytes: z
        .number()
        .int()
        .min(1)
        .max(64 * 1024 * 1024)
        .optional(),
    }),
  }),
  z.object({
    operation: z.literal('listSessions'),
    payload: z.object({
      limit: z.number().int().positive().max(200),
      model: z.string().max(256).optional(),
      offset: z.number().int().nonnegative(),
      search: z.string().max(512).optional(),
    }),
  }),
  z.object({ operation: z.literal('getSession'), payload: SessionKeyPayloadSchema }),
  z.object({ operation: z.literal('listRecords'), payload: SessionKeyPayloadSchema }),
  z.object({ operation: z.literal('listRecordPage'), payload: ThoughtRecordPageInputSchema }),
  z.object({ operation: z.literal('findCandidates'), payload: ThoughtCandidateInputSchema }),
  z.object({
    operation: z.literal('toolRecoverySnapshot'),
    payload: ThoughtToolRecoveryInputSchema,
  }),
  z.object({
    operation: z.literal('getRecord'),
    payload: z.object({ id: z.number().int().positive(), sessionKey: z.string().min(1).max(512) }),
  }),
  z.object({
    operation: z.literal('touch'),
    payload: SessionKeyPayloadSchema.extend({
      maxDiskBytes: CleanupPayloadSchema.shape.maxDiskBytes,
    }),
  }),
  z.object({
    operation: z.literal('end'),
    payload: SessionKeyPayloadSchema.extend({
      maxDiskBytes: CleanupPayloadSchema.shape.maxDiskBytes,
    }),
  }),
  z.object({ operation: z.literal('deleteSession'), payload: SessionKeyPayloadSchema }),
  z.object({ operation: z.literal('clear'), payload: z.null() }),
  z.object({ operation: z.literal('cleanup'), payload: CleanupPayloadSchema }),
  z.object({ operation: z.literal('stats'), payload: z.null() }),
  z.object({ operation: z.literal('shutdown'), payload: z.null() }),
]);

export type ThoughtStoreWorkerCommand = z.infer<typeof ThoughtStoreWorkerCommandSchema>;

export const ThoughtCleanupResultSchema = z.object({
  removedSessions: z.number().int().nonnegative(),
  moreWorkPending: z.boolean(),
  removedRecords: z.number().int().nonnegative().optional(),
  invalidatedSessions: z.array(z.string().min(1).max(512)).max(64).optional(),
  blockedReason: z
    .enum(['checkpoint_busy', 'no_progress', 'oversized_record', 'active_sessions'])
    .optional(),
});

export const ThoughtStoreWorkerMessageSchema = z.object({
  id: z.number().int().positive(),
  operation: z.string(),
  payload: z.unknown(),
});
