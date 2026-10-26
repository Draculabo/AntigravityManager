import type Database from 'better-sqlite3';
import {
  UsageRangeResultSchema,
  UsageRangeTotalsSchema,
  type UsageRangeWorkerInput,
} from './usage-range.schema';

/** Aggregates only scalar metadata on the SQLite worker; no bodies or history leave it. */
export function readUsageRange(raw: Database.Database, { range, asOf }: UsageRangeWorkerInput) {
  const placeholders = range.modelIds.map(() => '?').join(',');
  // Parent usage has no per-attempt ownership. Reject every multi-attempt parent
  // rather than assigning its entire usage to the repository's preferred attempt.
  const query = `WITH candidates AS (
    SELECT r.completed_at,r.outcome,r.input_tokens,r.output_tokens,r.cached_tokens,
      (SELECT COUNT(*) FROM upstream_attempts a WHERE a.parent_id=r.id) attempt_count,
      EXISTS(SELECT 1 FROM upstream_attempts a WHERE a.parent_id=r.id
        AND a.account_id=r.attributed_account_id AND a.model=r.physical_model
        AND a.completed_at IS NOT NULL AND a.completed_at<=?
        AND a.outcome<>'in_progress') matching_attempt
    FROM request_logs r
    WHERE r.traffic_class='model' AND r.attributed_account_id=?
      AND r.physical_model IN (${placeholders})
      AND r.timestamp>=? AND r.timestamp<? AND r.timestamp<=?
  ), classified AS (
    SELECT *, CASE
      WHEN attempt_count<>1 THEN 'ambiguous'
      WHEN matching_attempt=0 THEN 'ambiguous'
      WHEN completed_at IS NULL OR completed_at>? OR outcome='in_progress'
        OR typeof(input_tokens)<>'integer' OR input_tokens<0 OR input_tokens>9007199254740991
        OR typeof(output_tokens)<>'integer' OR output_tokens<0 OR output_tokens>9007199254740991
        THEN 'missing'
      ELSE 'counted' END usage_state
    FROM candidates
  ) SELECT COUNT(*) recordedRequests,
    COALESCE(SUM(usage_state='counted'),0) countedRequests,
    COALESCE(SUM(usage_state='ambiguous'),0) ambiguousRequests,
    COALESCE(SUM(usage_state='missing'),0) missingUsageRequests,
    COALESCE(SUM(CASE WHEN usage_state='counted' AND
      (cached_tokens IS NULL OR typeof(cached_tokens)<>'integer' OR cached_tokens<0
        OR cached_tokens>9007199254740991) THEN 1 ELSE 0 END),0) missingCachedRequests,
    COALESCE(SUM(CASE WHEN usage_state='counted' THEN input_tokens ELSE 0 END),0) inputTokens,
    COALESCE(SUM(CASE WHEN usage_state='counted' THEN output_tokens ELSE 0 END),0) outputTokens,
    COALESCE(SUM(CASE WHEN usage_state='counted' AND typeof(cached_tokens)='integer'
      AND cached_tokens BETWEEN 0 AND 9007199254740991 THEN cached_tokens ELSE 0 END),0) cachedTokens
    FROM classified`;
  const row = raw
    .prepare(query)
    .get(asOf, range.accountId, ...range.modelIds, range.from, range.to, asOf, asOf);
  const totals = UsageRangeTotalsSchema.parse(row);
  return UsageRangeResultSchema.parse({
    ...range,
    asOf,
    ...totals,
    totalTokens: totals.inputTokens + totals.outputTokens,
    coverage: 'retained-local-records',
    accountIdentity: 'stored-account-id',
    timeBasis: 'request-start',
  });
}
