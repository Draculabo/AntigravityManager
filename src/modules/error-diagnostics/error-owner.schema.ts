import { z } from 'zod';
import { ContentDescriptorSchema } from '@/shared/observability/content-capability.schema';
import {
  ErrorAllocationSchema,
  ErrorWindowMetadataSchema,
  ErrorWindowStatsSchema,
} from './error-window.schema';

const CounterSchema = z.number().int().safe().nonnegative();
export const ErrorRoleSchema = z.enum(['app', 'core']);
export const ErrorOwnerStatusSchema = z.object({
  storagePath: z.string().min(1).max(4096),
  role: ErrorRoleSchema,
  counters: z.object({
    captured: CounterSchema,
    accepted: CounterSchema,
    persisted: CounterSchema,
    rejected: CounterSchema,
    failed: CounterSchema,
    cleared: CounterSchema,
    fallbackEvicted: CounterSchema,
    discarded: CounterSchema,
  }),
  fallbackRecords: z.number().int().nonnegative().max(64),
  fallbackBytes: z
    .number()
    .int()
    .nonnegative()
    .max(1024 * 1024),
  lastFailure: z
    .enum([
      'record_too_large',
      'projection_failed',
      'queue_full',
      'store_unavailable',
      'write_failed',
      'cleared_generation',
      'disk_budget',
      'checkpoint_busy',
      'read_only',
      'disk_full',
      'disk_usage_unknown',
      'reclaim_failed',
      'closed',
    ])
    .nullable(),
  maintenanceBlocked: z
    .enum(['checkpoint_busy', 'no_progress', 'oversized_record', 'reclaim_failed'])
    .nullable(),
  queue: z
    .object({
      alive: z.boolean(),
      pendingBytes: z
        .number()
        .int()
        .nonnegative()
        .max(32 * 1024 * 1024),
      pendingCommands: z.number().int().nonnegative().max(256),
    })
    .nullable(),
  storage: z.discriminatedUnion('state', [
    ErrorWindowStatsSchema.extend({ state: z.literal('ready') }),
    z.object({
      state: z.literal('unavailable'),
      allocationBytes: ErrorAllocationSchema.nullable(),
    }),
  ]),
});
export const ErrorOpenInputSchema = z.object({ id: z.string().uuid() });
export const ErrorOpenSchema = z.object({
  metadata: ErrorWindowMetadataSchema.omit({ sequence: true }),
  transfer: ContentDescriptorSchema.extend({ kind: z.literal('error') }),
});
