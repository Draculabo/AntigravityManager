import { z } from 'zod';
import { UsagePricesSchema } from './usage-overview.schema';
import { TrafficAuditListInputSchema } from './traffic-audit.types';

export const UsageTrendsInputSchema = z.strictObject({
  window: z.enum(['1h', '24h']),
  modelView: z.enum(['requested', 'actual']),
  accountId: z.string().min(1).max(256).optional(),
  model: z.string().min(1).max(256).optional(),
  includeActivity: z.boolean().optional(),
  prices: UsagePricesSchema.optional(),
});
export type UsageTrendsInput = z.infer<typeof UsageTrendsInputSchema>;

export const UsageTrendsWorkerInputSchema = UsageTrendsInputSchema.extend({
  asOf: z.number().int().nonnegative().safe(),
});
export type UsageTrendsWorkerInput = z.infer<typeof UsageTrendsWorkerInputSchema>;

const count = z.number().int().nonnegative().safe();
export const USAGE_ACTIVITY_WEEKS = 53;
const usageActivityDay = z.strictObject({
  date: z.iso.date(),
  requests: count,
  attempts: count,
  observedTokens: count.nullable(),
  incompleteRequests: count,
  estimatedCostUsd: z.number().nonnegative().nullable(),
  pricedAttempts: count,
});
export type UsageActivityDay = z.infer<typeof usageActivityDay>;
export const UsageActivityDaysSchema = z
  .array(usageActivityDay)
  .min((USAGE_ACTIVITY_WEEKS - 1) * 7 + 1)
  .max(USAGE_ACTIVITY_WEEKS * 7);
export const UsageActivityInputSchema = z.strictObject({
  filters: TrafficAuditListInputSchema.omit({ limit: true, offset: true, trafficClass: true }).strict(),
  prices: UsagePricesSchema.optional(),
});
export const UsageActivityWorkerInputSchema = UsageActivityInputSchema.extend({ asOf: count });
export type UsageActivityInput = z.infer<typeof UsageActivityInputSchema>;
export type UsageActivityWorkerInput = z.infer<typeof UsageActivityWorkerInputSchema>;
const metrics = z.strictObject({
  requests: count,
  attempts: count,
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  totalTokens: count.nullable(),
  incompleteRequests: count,
});
export const USAGE_TRENDS_MODEL_LIMIT = 50;
const modelId = z.string().max(256).nullable();
const modelVariant = metrics.extend({ model: modelId });
const modelFamily = metrics.extend({
  family: modelId,
  variants: z.array(modelVariant).max(USAGE_TRENDS_MODEL_LIMIT),
  variantsTruncated: z.boolean(),
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
  modelFamilies: z.array(modelFamily).max(USAGE_TRENDS_MODEL_LIMIT),
  modelFamiliesTruncated: z.boolean(),
  activity: UsageActivityDaysSchema.optional(),
});
export type UsageTrendsResult = z.infer<typeof UsageTrendsResultSchema>;
