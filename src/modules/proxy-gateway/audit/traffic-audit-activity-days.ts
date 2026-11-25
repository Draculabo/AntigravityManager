import { and, eq, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { requestLogs, upstreamAttempts, type trafficAuditSchema } from './traffic-audit.schema';
import { auditUsageCostSql } from './audit-usage-cost-sql';
import { resolveUsagePrices } from './audit-usage-default-prices';
import type { UsagePrice } from './usage-overview.schema';
import {
  USAGE_ACTIVITY_WEEKS,
  UsageActivityDaysSchema,
  type UsageActivityWorkerInput,
} from './usage-trends.schema';
import { auditRequestListPredicate } from './audit-request-list-predicate';

export type AuditDatabase = BetterSQLite3Database<typeof trafficAuditSchema>;

export function readRequestActivity(
  db: AuditDatabase,
  { filters, prices, asOf }: UsageActivityWorkerInput,
) {
  const to = Math.min(filters.to ?? asOf, asOf);
  const observedThrough = Math.min(filters.usageAsOf ?? to, asOf);
  const where = auditRequestListPredicate({
    ...filters,
    to,
    usageAsOf: observedThrough,
    trafficClass: 'model',
  });
  const attemptJoin = and(
    eq(upstreamAttempts.parentId, requestLogs.id),
    lte(upstreamAttempts.timestamp, observedThrough),
    or(eq(upstreamAttempts.usageScope, 'generation'), isNull(upstreamAttempts.usageScope)),
    filters.attemptAccountId ? eq(upstreamAttempts.accountId, filters.attemptAccountId) : undefined,
    filters.attemptModel ? eq(upstreamAttempts.model, filters.attemptModel) : undefined,
  );
  const terminalAttempt = and(
    lte(upstreamAttempts.completedAt, observedThrough),
    ne(upstreamAttempts.outcome, 'in_progress'),
    eq(upstreamAttempts.responsePartial, false),
  );
  return readActivityDays(
    db, to, resolveUsagePrices(prices ?? [], asOf), attemptJoin, where, terminalAttempt,
  );
}

export function readActivityDays(
  db: Pick<AuditDatabase, 'all'>,
  through: number,
  prices: UsagePrice[] | undefined,
  attemptJoin: SQL | undefined,
  matchingTraffic: SQL | undefined,
  terminalAttempt: SQL | undefined,
) {
  const now = new Date(through);
  const weekday = (now.getDay() + 6) % 7;
  const daysBack = (USAGE_ACTIVITY_WEEKS - 1) * 7 + weekday;
  // Build each boundary independently so days spanning a clock change retain their full interval.
  const days = Array.from({ length: daysBack + 1 }, (_, index) => {
    const calendar = new Date(
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - daysBack + index),
    );
    const year = calendar.getUTCFullYear();
    const month = calendar.getUTCMonth();
    const day = calendar.getUTCDate();
    return {
      date: calendar.toISOString().slice(0, 10),
      start: new Date(year, month, day).getTime(),
      end: new Date(year, month, day + 1).getTime(),
    };
  });
  const values = sql.join(
    days.map(({ date, start, end }) => sql`(${date}, ${start}, ${end})`),
    sql`, `,
  );
  const measured = (
    column:
      | typeof upstreamAttempts.inputTokens
      | typeof upstreamAttempts.cachedTokens
      | typeof upstreamAttempts.outputTokens,
  ) =>
    sql`CASE WHEN ${terminalAttempt} AND typeof(${column})='integer'
      AND ${column} BETWEEN 0 AND 9007199254740991 THEN ${column} END`;
  return UsageActivityDaysSchema.parse(
    db.all(sql`
    WITH days(date, starts_at, ends_at) AS (VALUES ${values}),
    prices AS MATERIALIZED (
      SELECT json_extract(value,'$.model') model,
        json_extract(value,'$.inputPerMillion') input_rate,
        json_extract(value,'$.outputPerMillion') output_rate,
        json_extract(value,'$.cachedPerMillion') cached_rate
      FROM json_each(${JSON.stringify(prices ?? [])})
    ), measured AS (
      SELECT days.date, ${requestLogs.id} id, ${upstreamAttempts.id} attempt_id,
        ${upstreamAttempts.model} model, ${measured(upstreamAttempts.inputTokens)} input,
        ${measured(upstreamAttempts.outputTokens)} output, ${measured(upstreamAttempts.cachedTokens)} cache,
        ${upstreamAttempts.cachedTokens} cached_tokens
      FROM days JOIN ${requestLogs}
        ON ${requestLogs.timestamp}>=days.starts_at AND ${requestLogs.timestamp}<days.ends_at
      LEFT JOIN ${upstreamAttempts} ON ${attemptJoin}
      WHERE ${matchingTraffic}
    ), per_day AS (
      SELECT date, COUNT(DISTINCT id) requests, COUNT(attempt_id) attempts,
        COUNT(DISTINCT CASE WHEN input IS NULL OR output IS NULL THEN id END) incompleteRequests,
        CASE WHEN COUNT(input)+COUNT(output)>0 THEN
          SUM(COALESCE(input,0))+SUM(COALESCE(output,0)) END observedTokens,
        SUM(${sql.raw(auditUsageCostSql)}) estimatedCostUsd,
        COUNT(${sql.raw(auditUsageCostSql)}) pricedAttempts
      FROM measured LEFT JOIN prices ON prices.model=measured.model GROUP BY date
    )
    SELECT days.date, COALESCE(requests,0) requests, COALESCE(attempts,0) attempts,
      COALESCE(incompleteRequests,0) incompleteRequests, observedTokens, estimatedCostUsd,
      COALESCE(pricedAttempts,0) pricedAttempts
    FROM days LEFT JOIN per_day USING(date) ORDER BY days.date
  `),
  );
}
