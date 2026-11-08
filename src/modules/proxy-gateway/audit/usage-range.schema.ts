import { z } from 'zod';

const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const modelIds = z.array(z.string().min(1).max(256)).min(1).max(128);
export const UsageRangeInputSchema = z
  .strictObject({
    accountId: z.string().min(1).max(256),
    modelIds,
    from: safeCount,
    to: safeCount,
  })
  .refine(({ from, to }) => to > from && to - from <= 7 * 24 * 60 * 60 * 1000, {
    message: 'Usage range must be positive and no longer than seven days',
  });
export type UsageRangeInput = z.infer<typeof UsageRangeInputSchema>;

export const UsageRangeWorkerInputSchema = z.strictObject({
  range: UsageRangeInputSchema,
  accountGenerationHash: z.string().regex(/^[a-f0-9]{64}$/u),
  accountSubjectHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  accountGrantHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  asOf: safeCount,
});
export type UsageRangeWorkerInput = z.infer<typeof UsageRangeWorkerInputSchema>;

export const UsageRangeTotalsSchema = z.strictObject({
  recordedRequests: safeCount,
  countedRequests: safeCount,
  ambiguousRequests: safeCount,
  missingUsageRequests: safeCount,
  missingCachedRequests: safeCount,
  inputTokens: safeCount,
  outputTokens: safeCount,
  cachedTokens: safeCount,
});
export const UsageRangeResultSchema = UsageRangeTotalsSchema.extend({
  accountId: z.string().min(1).max(256),
  modelIds,
  from: safeCount,
  to: safeCount,
  asOf: safeCount,
  coverage: z.literal('retained-local-records'),
  accountIdentity: z.enum(['current-account-incarnation', 'verified-google-account']),
  timeBasis: z.literal('attempt-start'),
  ambiguousTimeBasis: z.literal('attempt-start-or-unattributed-request-start'),
  totalTokens: safeCount,
}).refine(
  (value) =>
    value.to > value.from &&
    value.to - value.from <= 7 * 24 * 60 * 60 * 1000 &&
    value.totalTokens === value.inputTokens + value.outputTokens &&
    value.recordedRequests ===
      value.countedRequests + value.ambiguousRequests + value.missingUsageRequests &&
    value.missingCachedRequests <= value.countedRequests + value.missingUsageRequests,
);
export type UsageRangeResult = z.infer<typeof UsageRangeResultSchema>;
