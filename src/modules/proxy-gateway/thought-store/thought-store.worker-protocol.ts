import { z } from 'zod';

const SessionKeyPayloadSchema = z.object({ sessionKey: z.string().min(1) });
const CleanupPayloadSchema = z.object({
  maxSessions: z.number().int().positive(),
  retentionDays: z.number().nonnegative(),
});
const SavePayloadSchema = z.object({
  createdAt: z.number().int().nonnegative(),
  fingerprint: z.string(),
  maxSessionBytes: z.number().int().positive(),
  maxSessions: z.number().int().positive(),
  maxTurns: z.number().int().positive(),
  meaningful: z.boolean(),
  model: z.string().nullable(),
  sessionKey: z.string().min(1),
  signature: z.string().nullable(),
  sourceFamily: z.string().nullable(),
  thought: z.string(),
  toolIds: z.array(z.string()),
  toolNames: z.array(z.string()),
  visible: z.string(),
});

export const ThoughtStoreWorkerCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('save'), payload: SavePayloadSchema }),
  z.object({
    operation: z.literal('ingestHistory'),
    payload: z.object({
      records: z.array(SavePayloadSchema),
      sessionKey: z.string().min(1),
    }),
  }),
  z.object({ operation: z.literal('load'), payload: SessionKeyPayloadSchema }),
  z.object({
    operation: z.literal('listSessions'),
    payload: z.object({
      limit: z.number().int().positive(),
      model: z.string().max(256).optional(),
      offset: z.number().int().nonnegative(),
      search: z.string().max(512).optional(),
    }),
  }),
  z.object({ operation: z.literal('getSession'), payload: SessionKeyPayloadSchema }),
  z.object({ operation: z.literal('listRecords'), payload: SessionKeyPayloadSchema }),
  z.object({
    operation: z.literal('getRecord'),
    payload: z.object({ id: z.number().int().positive(), sessionKey: z.string().min(1) }),
  }),
  z.object({ operation: z.literal('touch'), payload: SessionKeyPayloadSchema }),
  z.object({ operation: z.literal('end'), payload: SessionKeyPayloadSchema }),
  z.object({ operation: z.literal('deleteSession'), payload: SessionKeyPayloadSchema }),
  z.object({ operation: z.literal('clear'), payload: z.null() }),
  z.object({ operation: z.literal('cleanup'), payload: CleanupPayloadSchema }),
  z.object({ operation: z.literal('stats'), payload: z.null() }),
  z.object({ operation: z.literal('shutdown'), payload: z.null() }),
]);

export type ThoughtStoreWorkerCommand = z.infer<typeof ThoughtStoreWorkerCommandSchema>;

export const ThoughtStoreWorkerMessageSchema = z.object({
  id: z.number().int().positive(),
  operation: z.string(),
  payload: z.unknown(),
});
