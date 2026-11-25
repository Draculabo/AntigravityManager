import { z } from 'zod';
import { AuditClientSchema } from './audit-client-identity';
import { TrafficAuditListInputSchema } from './traffic-audit.types';

const count = z.number().int().nonnegative().safe();
const id = z.string().min(1).max(256);
const session = z.string().min(1).max(512);
export const USAGE_OVERVIEW_LIMIT = 30;
export const USAGE_SESSION_MAX_OFFSET = 3000;
export const AUDIT_SESSION_TITLE_LIMIT = 120;
export const USAGE_OVERVIEW_MAX_MS = 32 * 86_400_000;
export const USAGE_PRICE_LIMIT = 64;
export const UsageRankingSortSchema = z.enum(['tokens', 'requests', 'cost', 'name']);
export const UsageSeriesGroupSchema = z.enum(['models', 'accounts', 'clients', 'protocols']);

const rate = z.number().min(0).max(100_000);
export const UsagePriceSchema = z.strictObject({
  model: id,
  inputPerMillion: rate,
  outputPerMillion: rate,
  cachedPerMillion: rate.optional(),
});
export const UsagePricesSchema = z
  .array(UsagePriceSchema)
  .max(USAGE_PRICE_LIMIT)
  .refine((prices) => new Set(prices.map(({ model }) => model)).size === prices.length);
export type UsagePrice = z.infer<typeof UsagePriceSchema>;

const range = z.strictObject({
  from: count,
  to: count,
  accountId: id.optional(),
  model: id.optional(),
  prices: UsagePricesSchema.optional(),
  protocol: id.optional(),
  client: AuditClientSchema.optional(),
  sessionId: session.optional(),
  sessionSearch: session.optional(),
  sessionOffset: z.number().int().min(0).max(USAGE_SESSION_MAX_OFFSET).optional(),
  includeAnalytics: z.boolean().optional(),
  observedThrough: count.optional(),
  requestFilters: TrafficAuditListInputSchema.pick({
    accountId: true,
    modelFamily: true,
    modality: true,
    search: true,
    statusMode: true,
    status: true,
    usageState: true,
  })
    .strict()
    .optional(),
  allRetained: z.boolean().optional(),
  sort: UsageRankingSortSchema.optional(),
  seriesGroup: UsageSeriesGroupSchema.optional(),
});
function validRange({
  from,
  to,
  allRetained,
}: Pick<z.infer<typeof range>, 'from' | 'to' | 'allRetained'>) {
  return from <= to && (allRetained || to - from <= USAGE_OVERVIEW_MAX_MS);
}

export const UsageOverviewInputSchema = range.refine(validRange);
export const UsageOverviewWorkerInputSchema = range.extend({ asOf: count }).refine(validRange);
export type UsageOverviewInput = z.infer<typeof UsageOverviewInputSchema>;
export type UsageOverviewWorkerInput = z.infer<typeof UsageOverviewWorkerInputSchema>;

export const UsageOverviewMetricsSchema = z.strictObject({
  requests: count,
  attempts: count,
  retriedRequests: count,
  failedRequests: count,
  incompleteRequests: count,
  inputTokens: count,
  peakInputTokens: count.nullable(),
  outputTokens: count,
  cacheReadTokens: count,
  cacheInputTokens: count,
  cacheMeasuredAttempts: count,
  reasoningTokens: count,
  reasoningMeasuredAttempts: count,
  estimatedCostUsd: z.number().nonnegative().optional(),
  pricedAttempts: count.optional(),
});
export type UsageOverviewMetrics = z.infer<typeof UsageOverviewMetricsSchema>;

const ranked = <Extra extends z.ZodRawShape>(key: z.ZodString, extra: Extra) =>
  z.strictObject({
    rows: z
      .array(
        UsageOverviewMetricsSchema.extend({
          key: key.nullable(),
          contextWindow: count.positive().optional(),
          ...extra,
        }),
      )
      .max(USAGE_OVERVIEW_LIMIT),
    truncated: z.boolean(),
  });

const speedPoint = z.strictObject({
  key: id.nullable(),
  firstOutputAttempts: count,
  meanFirstOutputMs: z.number().nonnegative().nullable(),
  decodeAttempts: count,
  outputTokensPerSecond: z.number().nonnegative().nullable(),
});
export const UsageAnalyticsSchema = z.strictObject({
  protocols: ranked(id, {}),
  clients: ranked(id, {}),
  speed: z.array(speedPoint).max(USAGE_OVERVIEW_LIMIT),
  activity: z
    .array(
      z.strictObject({
        day: count,
        hour: count.max(23),
        requests: count,
      }),
    )
    .max(49 * 24),
  live: z
    .strictObject({
      asOf: count,
      inFlight: count,
      startedLastMinute: count,
    })
    .optional(),
  capture: z.strictObject({
    requests: count,
    requestBytes: count,
    responseBytes: count,
    requestBodies: count,
    responseBodies: count,
  }),
  transport: z.strictObject({
    uploadBytes: count,
    downloadBytes: count,
    uploadSamples: count,
    downloadSamples: count,
  }),
  trend: z
    .array(
      z.strictObject({
        timestamp: count,
        uploadBytes: count.nullable(),
        downloadBytes: count.nullable(),
        outputTokensPerSecond: z.number().nonnegative().nullable(),
      }),
    )
    .max(49)
    .optional(),
});

export const UsageOverviewResultSchema = z.strictObject({
  from: count,
  to: count,
  totals: UsageOverviewMetricsSchema,
  bucketMs: count.positive(),
  buckets: z.array(UsageOverviewMetricsSchema.extend({ timestamp: count })).max(49),
  accounts: ranked(id, {}),
  models: ranked(id, {}),
  sessions: ranked(session, {
    client: AuditClientSchema.nullable().optional(),
    title: z.string().min(1).max(AUDIT_SESSION_TITLE_LIMIT).optional(),
  }),
  analytics: UsageAnalyticsSchema.optional(),
  series: z
    .array(
      z.strictObject({
        key: id.nullable(),
        points: z
          .array(
            z.strictObject({
              timestamp: count,
              requests: count,
              inputTokens: count,
              outputTokens: count,
            }),
          )
          .max(49),
      }),
    )
    .max(6)
    .optional(),
});
export type UsageOverviewResult = z.infer<typeof UsageOverviewResultSchema>;
