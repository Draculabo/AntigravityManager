import { z } from 'zod';

export const UsageTrendsInputSchema = z.strictObject({
  window: z.enum(['1h', '24h']),
  modelView: z.enum(['requested', 'actual']),
  accountId: z.string().min(1).max(256).optional(),
  model: z.string().min(1).max(256).optional(),
  includeActivity: z.boolean().optional(),
});
export type UsageTrendsInput = z.infer<typeof UsageTrendsInputSchema>;

export const UsageTrendsWorkerInputSchema = UsageTrendsInputSchema.extend({
  asOf: z.number().int().nonnegative().safe(),
});
export type UsageTrendsWorkerInput = z.infer<typeof UsageTrendsWorkerInputSchema>;

const count = z.number().int().nonnegative().safe();
const metrics = z.strictObject({
  requests: count,
  attempts: count,
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  totalTokens: count.nullable(),
  incompleteRequests: count,
});
export const UsageTrendsResultSchema = z.strictObject({
  window: z.enum(['1h', '24h']),
  modelView: z.enum(['requested', 'actual']),
  from: count,
  to: count,
  bucketMs: z.literal(60000),
  coverage: z.literal('retained-local-records'),
  totals: metrics,
  buckets: z.array(metrics.extend({ timestamp: count })).max(1441),
  models: z.array(metrics.extend({ model: z.string().max(256).nullable() })).max(50),
  modelsTruncated: z.boolean(),
  activity: z.array(z.strictObject({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    requests: count,
  })).length(30).optional(),
});
export type UsageTrendsResult = z.infer<typeof UsageTrendsResultSchema>;
