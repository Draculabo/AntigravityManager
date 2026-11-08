import type Database from 'better-sqlite3';
import {
  UsageRangeResultSchema,
  UsageRangeTotalsSchema,
  type UsageRangeWorkerInput,
} from './usage-range.schema';

/** Each physical attempt contributes once; parent responses never supply account usage. */
export function readUsageRange(
  raw: Database.Database,
  { range, asOf, accountGenerationHash, accountSubjectHash, accountGrantHash }: UsageRangeWorkerInput,
) {
  const placeholders = range.modelIds.map((_, index) => `@model${index}`).join(',');
  const query = `WITH candidates AS (
    SELECT a.parent_id,a.input_tokens,a.output_tokens,a.cached_tokens,a.response_partial,
      CASE WHEN a.usage_scope='generation' AND (
        (@subject IS NOT NULL AND a.account_subject_hash=@subject) OR
        (@subject IS NULL AND @grant IS NOT NULL
          AND a.account_generation_hash=@generation AND a.account_grant_hash=@grant))
      THEN 1 ELSE 0 END identified,
      CASE WHEN a.completed_at IS NOT NULL AND a.completed_at<=@asOf
        AND a.outcome<>'in_progress' THEN 1 ELSE 0 END terminal
    FROM upstream_attempts a JOIN request_logs r ON r.id=a.parent_id
    WHERE a.model IN (${placeholders})
      AND a.timestamp>=@from AND a.timestamp<@to AND a.timestamp<=@asOf
      AND ((@subject IS NOT NULL AND a.account_subject_hash=@subject)
        OR (a.account_id=@accountId
          AND (a.account_subject_hash IS NULL OR (@subject IS NULL AND a.account_grant_hash=@grant))
          AND (a.account_generation_hash=@generation OR a.account_generation_hash IS NULL)
          AND (a.account_grant_hash=@grant OR a.account_grant_hash IS NULL)))
      AND (a.usage_scope='generation' OR (a.usage_scope IS NULL AND r.traffic_class='model'))
    UNION ALL
    SELECT r.id,NULL,NULL,NULL,1,0,0 FROM request_logs r
    WHERE r.traffic_class='model' AND r.attributed_account_id=@accountId
      AND r.physical_model IN (${placeholders})
      AND r.timestamp>=@from AND r.timestamp<@to AND r.timestamp<=@asOf
      AND (NOT EXISTS(SELECT 1 FROM upstream_attempts a WHERE a.parent_id=r.id)
        OR EXISTS(SELECT 1 FROM upstream_attempts a WHERE a.parent_id=r.id
          AND (a.usage_scope='generation' OR a.usage_scope IS NULL)
          AND (a.account_generation_hash=@generation OR a.account_generation_hash IS NULL)
          AND a.account_subject_hash IS NULL
          AND (a.account_grant_hash=@grant OR a.account_grant_hash IS NULL)
          AND (a.account_id=@accountId OR a.account_id IS NULL)
          AND (a.model IN (${placeholders}) OR a.model IS NULL)
          AND (a.account_id IS NULL OR a.model IS NULL)))
  ), measured AS (
    SELECT *,
      CASE WHEN identified=1 AND terminal=1 AND typeof(input_tokens)='integer'
        AND input_tokens BETWEEN 0 AND 9007199254740991 THEN 1 ELSE 0 END has_input,
      CASE WHEN identified=1 AND terminal=1 AND typeof(output_tokens)='integer'
        AND output_tokens BETWEEN 0 AND 9007199254740991 THEN 1 ELSE 0 END has_output,
      CASE WHEN identified=1 AND terminal=1 AND typeof(cached_tokens)='integer'
        AND cached_tokens BETWEEN 0 AND 9007199254740991 THEN 1 ELSE 0 END has_cached
    FROM candidates
  ), requests AS (
    SELECT parent_id,
      MAX(identified=0) ambiguous,
      MAX(has_input=0 OR has_output=0 OR response_partial<>0) missing,
      MAX(has_cached=0 OR response_partial<>0) missing_cached,
      SUM(CASE WHEN has_input=1 THEN input_tokens ELSE 0 END) input_tokens,
      SUM(CASE WHEN has_output=1 THEN output_tokens ELSE 0 END) output_tokens,
      SUM(CASE WHEN has_cached=1 THEN cached_tokens ELSE 0 END) cached_tokens
    FROM measured GROUP BY parent_id
  ) SELECT COUNT(*) recordedRequests,
    COALESCE(SUM(ambiguous=0 AND missing=0),0) countedRequests,
    COALESCE(SUM(ambiguous=1),0) ambiguousRequests,
    COALESCE(SUM(ambiguous=0 AND missing=1),0) missingUsageRequests,
    COALESCE(SUM(ambiguous=0 AND missing_cached=1),0) missingCachedRequests,
    COALESCE(SUM(input_tokens),0) inputTokens,
    COALESCE(SUM(output_tokens),0) outputTokens,
    COALESCE(SUM(cached_tokens),0) cachedTokens FROM requests`;
  const row = raw.prepare(query).get({
    subject: accountSubjectHash,
    grant: accountGrantHash,
    generation: accountGenerationHash,
    accountId: range.accountId,
    from: range.from,
    to: range.to,
    asOf,
    ...Object.fromEntries(range.modelIds.map((model, index) => [`model${index}`, model])),
  });
  const totals = UsageRangeTotalsSchema.parse(row);
  return UsageRangeResultSchema.parse({
    ...range,
    asOf,
    ...totals,
    totalTokens: totals.inputTokens + totals.outputTokens,
    coverage: 'retained-local-records',
    accountIdentity: accountSubjectHash ? 'verified-google-account' : 'current-account-incarnation',
    timeBasis: 'attempt-start',
    ambiguousTimeBasis: 'attempt-start-or-unattributed-request-start',
  });
}
