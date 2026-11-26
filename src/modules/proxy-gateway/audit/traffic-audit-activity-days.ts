import {
  and,
  asc,
  between,
  count,
  countDistinct,
  eq,
  gte,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { requestLogs, upstreamAttempts, type trafficAuditSchema } from './traffic-audit.schema';
import { auditUsageCost } from './audit-usage-cost-sql';
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
    db,
    to,
    resolveUsagePrices(prices ?? [], asOf),
    attemptJoin,
    where,
    terminalAttempt,
  );
}

export function readActivityDays(
  db: Pick<AuditDatabase, '$with' | 'select' | 'with'>,
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
  const calendarDays = db.$with('days').as(
    db
      .select({
        date: sql<string>`json_extract(value, '$.date')`.as('calendar_date'),
        start: sql<number>`json_extract(value, '$.start')`.as('starts_at'),
        end: sql<number>`json_extract(value, '$.end')`.as('ends_at'),
      })
      .from(sql`json_each(${JSON.stringify(days)})`),
  );
  const rates = db.$with('prices').as(
    db
      .select({
        model: sql<string>`json_extract(value, '$.model')`.as('price_model'),
        input: sql<number>`json_extract(value, '$.inputPerMillion')`.as('input_rate'),
        output: sql<number>`json_extract(value, '$.outputPerMillion')`.as('output_rate'),
        cache: sql<number | null>`json_extract(value, '$.cachedPerMillion')`.as('cached_rate'),
      })
      .from(sql`json_each(${JSON.stringify(prices ?? [])})`)
      .limit(prices?.length ?? 0),
  );
  const measured = (
    column:
      | typeof upstreamAttempts.inputTokens
      | typeof upstreamAttempts.cachedTokens
      | typeof upstreamAttempts.outputTokens,
  ) =>
    sql<number | null>`case when ${terminalAttempt} and typeof(${column}) = 'integer'
      and ${between(column, 0, Number.MAX_SAFE_INTEGER)} then ${column} end`;
  const measurements = db.$with('measured').as(
    db
      .select({
        date: calendarDays.date,
        id: requestLogs.id,
        attemptId: sql<string | null>`${upstreamAttempts.id}`.as('attempt_id'),
        model: sql<string | null>`${upstreamAttempts.model}`.as('attempt_model'),
        input: measured(upstreamAttempts.inputTokens).as('input'),
        output: measured(upstreamAttempts.outputTokens).as('output'),
        cache: measured(upstreamAttempts.cachedTokens).as('cache'),
        cachedTokens: upstreamAttempts.cachedTokens,
      })
      .from(calendarDays)
      .innerJoin(
        requestLogs,
        and(
          gte(requestLogs.timestamp, calendarDays.start),
          lt(requestLogs.timestamp, calendarDays.end),
        ),
      )
      .leftJoin(upstreamAttempts, attemptJoin)
      .where(matchingTraffic),
  );
  const cost = auditUsageCost({
    input: measurements.input,
    output: measurements.output,
    cache: measurements.cache,
    cachedTokens: measurements.cachedTokens,
    model: rates.model,
    inputRate: rates.input,
    outputRate: rates.output,
    cachedRate: rates.cache,
  });
  const perDay = db.$with('per_day').as(
    db
      .select({
        date: sql<string>`${measurements.date}`.as('activity_date'),
        requests: countDistinct(measurements.id).as('requests'),
        attempts: count(measurements.attemptId).as('attempts'),
        incompleteRequests: countDistinct(
          sql`case when ${isNull(measurements.input)} or ${isNull(measurements.output)}
            then ${measurements.id} end`,
        ).as('incomplete_requests'),
        observedTokens: sql<number | null>`case
          when ${count(measurements.input)} + ${count(measurements.output)} > 0 then
          sum(coalesce(${measurements.input}, 0)) + sum(coalesce(${measurements.output}, 0)) end`.as(
          'observed_tokens',
        ),
        estimatedCostUsd: sql<number | null>`sum(${cost})`.as('estimated_cost'),
        pricedAttempts: count(cost).as('priced_attempts'),
      })
      .from(measurements)
      .leftJoin(rates, eq(rates.model, measurements.model))
      .groupBy(sql`${measurements.date}`),
  );
  return UsageActivityDaysSchema.parse(
    db
      .with(calendarDays, rates, measurements, perDay)
      .select({
        date: calendarDays.date,
        requests: sql<number>`coalesce(${perDay.requests}, 0)`,
        attempts: sql<number>`coalesce(${perDay.attempts}, 0)`,
        incompleteRequests: sql<number>`coalesce(${perDay.incompleteRequests}, 0)`,
        observedTokens: perDay.observedTokens,
        estimatedCostUsd: perDay.estimatedCostUsd,
        pricedAttempts: sql<number>`coalesce(${perDay.pricedAttempts}, 0)`,
      })
      .from(calendarDays)
      .leftJoin(perDay, eq(calendarDays.date, perDay.date))
      .orderBy(asc(calendarDays.date))
      .all(),
  );
}
