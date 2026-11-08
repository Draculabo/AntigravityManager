import { z } from 'zod';
import { MAX_ERROR_RECORD_BYTES } from './error-record';

export const ErrorAllocationSchema = z
  .number()
  .int()
  .safe()
  .min(512 * 1024)
  .max(5120 * 1024 * 1024);
const GenerationSchema = z.string().uuid();
export const ErrorWindowQuerySchema = z.object({
  afterSequence: z.number().int().safe().nonnegative().default(0),
  throughSequence: z.number().int().safe().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  source: z.string().min(1).max(512).optional(),
  category: z.string().min(1).max(512).optional(),
  requestId: z.string().min(1).max(512).optional(),
});
export type ErrorWindowQuery = z.input<typeof ErrorWindowQuerySchema>;
export const ErrorWindowCommandSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('initialize'),
    payload: z.object({ generation: GenerationSchema, allocationBytes: ErrorAllocationSchema }),
  }),
  z.object({
    operation: z.literal('insert'),
    payload: z.object({
      generation: GenerationSchema,
      body: z.string().max(MAX_ERROR_RECORD_BYTES),
    }),
  }),
  z.object({ operation: z.literal('query'), payload: ErrorWindowQuerySchema }),
  z.object({ operation: z.literal('detail'), payload: z.object({ id: z.string().uuid() }) }),
  z.object({ operation: z.literal('clear'), payload: z.object({ generation: GenerationSchema }) }),
  z.object({
    operation: z.literal('configure'),
    payload: z.object({ allocationBytes: ErrorAllocationSchema, generation: GenerationSchema }),
  }),
  z.object({ operation: z.literal('maintain'), payload: z.null() }),
  z.object({ operation: z.literal('stats'), payload: z.null() }),
  z.object({ operation: z.literal('shutdown'), payload: z.null() }),
]);
export type ErrorWindowCommand = z.infer<typeof ErrorWindowCommandSchema>;

export const ErrorWindowMetadataSchema = z.object({
  sequence: z.number().int().safe().positive(),
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  source: z.string().min(1).max(512),
  category: z.string().min(1).max(512),
  requestId: z.string().max(512).nullable(),
  attemptId: z.string().max(512).nullable(),
  status: z.number().int().safe().nonnegative().nullable(),
  message: z.string().max(256),
  bytes: z.number().int().safe().nonnegative(),
});
export const ErrorWindowPageSchema = z.object({
  generation: GenerationSchema,
  records: z.array(ErrorWindowMetadataSchema).max(200),
  throughSequence: z.number().int().safe().nonnegative(),
  nextSequence: z.number().int().safe().positive().nullable(),
  complete: z.boolean(),
});

export const ErrorWindowStatsSchema = z.object({
  generation: GenerationSchema,
  role: z.enum(['app', 'core']),
  allocationBytes: ErrorAllocationSchema,
  maintenanceCeiling: ErrorAllocationSchema,
  reclaiming: z.boolean(),
  databaseBytes: z.number().int().safe().nonnegative(),
  records: z.number().int().safe().nonnegative(),
});
export const ErrorWindowMaintenanceSchema = z.object({
  removedRecords: z.number().int().safe().nonnegative().max(32),
  databaseBytes: z.number().int().safe().nonnegative(),
  moreWorkPending: z.boolean(),
  reclaimedBytes: z.number().int().safe().nonnegative().optional(),
  blockedReason: z.enum(['checkpoint_busy', 'no_progress', 'oversized_record']).optional(),
});
export const ErrorWindowClearSchema = z.object({
  generation: GenerationSchema,
  records: z.number().int().safe().nonnegative(),
});
