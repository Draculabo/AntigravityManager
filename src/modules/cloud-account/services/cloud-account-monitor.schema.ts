import { z } from 'zod';
import { WeeklyWarmupGroupSchema } from './weekly-warmup-contract';

export const CloudMonitorEnabledInputSchema = z.strictObject({ enabled: z.boolean() });
export const CloudMonitorModelsSchema = z
  .record(
    z.string().min(1).max(256),
    z.strictObject({
      enabled: z.boolean(),
      priority: z.boolean(),
    }),
  )
  .refine((value) => Object.keys(value).length <= 256);
// Bound the encoded write independently from compatible, larger saved reads.
export const CloudMonitorModelsInputSchema = CloudMonitorModelsSchema.refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 3000,
);
export const CloudMonitorWarmupSchema = z.strictObject({
  enabled: z.boolean(),
  groups: z.array(WeeklyWarmupGroupSchema).max(64),
});
export const CloudMonitorMutationResultSchema = z.strictObject({ success: z.literal(true) });
