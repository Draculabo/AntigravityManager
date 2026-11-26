import {
  and,
  between,
  count,
  eq,
  exists,
  gte,
  isNotNull,
  isNull,
  lte,
  max,
  min,
  ne,
  notExists,
  or,
  sql,
  sum,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { alias } from 'drizzle-orm/sqlite-core';
import { auditUsageCost } from './audit-usage-cost-sql';
import { observedAuditClient } from './audit-client-identity';
import { auditRequestListPredicate } from './audit-request-list-predicate';
import { resolveUsagePrices } from './audit-usage-default-prices';
import { requestLogs, upstreamAttempts } from './traffic-audit.schema';
import type { UsageOverviewWorkerInput } from './usage-overview.schema';

export type UsageOverviewDatabase = Pick<
  BetterSQLite3Database,
  '$with' | 'with' | 'select' | 'selectDistinct'
>;

const failedOutcomes = ['upstream_error', 'internal_error', 'timeout', 'auth_failed'];

function measuredTokens(terminal: SQLWrapper, column: SQLWrapper) {
  return sql<number | null>`CASE WHEN ${terminal} = 1 AND typeof(${column}) = 'integer'
    AND ${column} BETWEEN 0 AND 9007199254740991 THEN ${column} END`;
}

export function groupUsageText(column: SQLWrapper, limit: number, bytes = true) {
  const length = bytes ? sql`length(cast(${column} as blob))` : sql`length(${column})`;
  return sql<string | null>`case when ${between(length, 1, limit)} then ${column} end`;
}

export function usageBucket(timestamp: SQLWrapper, starts: number[]) {
  const boundaries = starts.slice(1);
  if (!boundaries.length) {
    return sql<number>`${0}`;
  }
  return sql<number>`case ${sql.join(
    boundaries.map((start, index) => sql`when ${timestamp} < ${start} then ${index}`),
    sql` `,
  )} else ${boundaries.length} end`;
}

export function usageOverviewQueries(
  db: UsageOverviewDatabase,
  input: UsageOverviewWorkerInput,
  from: number,
  to: number,
  observedThrough: number,
) {
  const attempt = upstreamAttempts;
  const request = requestLogs;
  const previous = alias(attempt, 'previous_attempt');
  const attemptScope = or(eq(attempt.usageScope, 'generation'), isNull(attempt.usageScope));
  const pastAttempts = () => db.select({ id: previous.id }).from(previous);
  const observedAttempt = and(
    eq(previous.parentId, request.id),
    lte(previous.timestamp, observedThrough),
  );
  const failed = and(
    lte(request.completedAt, observedThrough),
    or(gte(request.status, 400), ...failedOutcomes.map((outcome) => eq(request.outcome, outcome))),
  );
  const retried = exists(
    pastAttempts()
      .where(
        and(
          observedAttempt,
          or(eq(previous.usageScope, 'generation'), isNull(previous.usageScope)),
        ),
      )
      .limit(1)
      .offset(1),
  );
  const filters = input.requestFilters;
  const selected = db.$with('selected_usage').as(
    db
      .select({
        id: request.id,
        timestamp: request.timestamp,
        sessionId: request.sessionId,
        protocol: request.protocol,
        accountId: attempt.accountId,
        model: sql<string | null>`${attempt.model}`.as('model'),
        attemptId: sql<string | null>`${attempt.id}`.as('attempt_id'),
        timing: attempt.timingJson,
        duration: attempt.durationMs,
        client: observedAuditClient(request.requestHeaders).as('client'),
        completedAt: request.completedAt,
        outcome: request.outcome,
        failed: sql<number>`case when ${failed} then 1 else 0 end`.as('failed'),
        retried: sql<number>`${retried}`.as('retried'),
        inputTokens: attempt.inputTokens,
        outputTokens: attempt.outputTokens,
        cachedTokens: attempt.cachedTokens,
        reasoningTokens: attempt.reasoningTokens,
        terminal: sql<number>`case when ${and(
          lte(attempt.completedAt, observedThrough),
          ne(attempt.outcome, 'in_progress'),
          eq(attempt.responsePartial, false),
        )} then 1 else 0 end`.as('terminal'),
      })
      .from(request)
      .leftJoin(
        attempt,
        and(
          eq(attempt.parentId, request.id),
          lte(attempt.timestamp, observedThrough),
          attemptScope,
        ),
      )
      .where(
        and(
          eq(request.trafficClass, 'model'),
          between(request.timestamp, from, to),
          input.accountId === undefined ? undefined : eq(attempt.accountId, input.accountId),
          input.model === undefined ? undefined : eq(attempt.model, input.model),
          auditRequestListPredicate({
            ...filters,
            sessionId: input.sessionId,
            protocol: input.protocol,
            client: input.client,
            usageState: undefined,
          }),
          or(isNotNull(attempt.id), notExists(pastAttempts().where(observedAttempt))),
          filters?.usageState === 'failed' ? failed : undefined,
          filters?.usageState === 'retried' ? retried : undefined,
        ),
      ),
  );
  const measured = db.$with('measured_usage').as(
    db
      .select({
        id: selected.id,
        timestamp: selected.timestamp,
        sessionId: selected.sessionId,
        protocol: selected.protocol,
        accountId: selected.accountId,
        model: selected.model,
        attemptId: selected.attemptId,
        timing: selected.timing,
        duration: selected.duration,
        client: selected.client,
        failed: selected.failed,
        retried: selected.retried,
        terminal: selected.terminal,
        input: measuredTokens(selected.terminal, selected.inputTokens).as('input'),
        output: measuredTokens(selected.terminal, selected.outputTokens).as('output'),
        cache: measuredTokens(selected.terminal, selected.cachedTokens).as('cache'),
        reasoning: measuredTokens(selected.terminal, selected.reasoningTokens).as('reasoning'),
        cachedTokens: selected.cachedTokens,
      })
      .from(selected),
  );
  const priceValue = sql.identifier('value');
  const prices = db.$with('usage_prices').as(
    db
      .select({
        model: sql<string>`json_extract(${priceValue}, '$.model')`.as('price_model'),
        input: sql<number>`json_extract(${priceValue}, '$.inputPerMillion')`.as('input_rate'),
        output: sql<number>`json_extract(${priceValue}, '$.outputPerMillion')`.as('output_rate'),
        cache: sql<number | null>`json_extract(${priceValue}, '$.cachedPerMillion')`.as(
          'cached_rate',
        ),
      })
      .from(
        sql`json_each(${JSON.stringify(input.prices ? resolveUsagePrices(input.prices, input.asOf) : [])})`,
      ),
  );
  const perRequest = (key: SQL<string | number | null>) => {
    const cost = auditUsageCost({
      input: measured.input,
      output: measured.output,
      cache: measured.cache,
      cachedTokens: measured.cachedTokens,
      model: prices.model,
      inputRate: prices.input,
      outputRate: prices.output,
      cachedRate: prices.cache,
    });
    const cacheKnown = lte(measured.cache, measured.input);
    return db.$with('per_request_usage').as(
      db
        .select({
          key: key.as('key'),
          attempts: count(measured.attemptId).as('attempts'),
          retried: max(measured.retried).as('retried'),
          failed: max(measured.failed).as('failed'),
          incomplete: max(sql<number>`${or(isNull(measured.input), isNull(measured.output))}`).as(
            'incomplete',
          ),
          input: sum(sql`coalesce(${measured.input}, 0)`).as('total_input'),
          output: sum(sql`coalesce(${measured.output}, 0)`).as('total_output'),
          peakInput: max(measured.input).as('peak_input'),
          cacheRead: sum(sql`case when ${cacheKnown} then ${measured.cache} else 0 end`).as(
            'cache_read',
          ),
          cacheInput: sum(sql`case when ${cacheKnown} then ${measured.input} else 0 end`).as(
            'cache_input',
          ),
          cacheMeasured: sum(sql`case when ${cacheKnown} then 1 else 0 end`).as('cache_measured'),
          reasoning: sum(sql`coalesce(${measured.reasoning}, 0)`).as('total_reasoning'),
          reasoningMeasured: count(measured.reasoning).as('reasoning_measured'),
          cost: sum(sql`coalesce(${cost}, 0)`).as('total_cost'),
          priced: count(cost).as('priced'),
          client: max(measured.client).as('client'),
        })
        .from(measured)
        .leftJoin(prices, eq(prices.model, measured.model))
        .groupBy(measured.id, key),
    );
  };
  const aggregate = (
    key: SQL<string | number | null>,
    withPricing: boolean,
    withSessionClient = false,
  ) => {
    const per = perRequest(key);
    return db
      .with(selected, measured, prices, per)
      .select({
        key: per.key,
        requests: count().as('requests'),
        attempts: sum(per.attempts).mapWith(Number).as('attempts'),
        retriedRequests: sum(per.retried).mapWith(Number).as('retried_requests'),
        failedRequests: sum(per.failed).mapWith(Number).as('failed_requests'),
        incompleteRequests: sum(per.incomplete).mapWith(Number).as('incomplete_requests'),
        inputTokens: sum(per.input).mapWith(Number).as('input_tokens'),
        outputTokens: sum(per.output).mapWith(Number).as('output_tokens'),
        peakInputTokens: max(per.peakInput).mapWith(Number).as('peak_input_tokens'),
        cacheReadTokens: sum(per.cacheRead).mapWith(Number).as('cache_read_tokens'),
        cacheInputTokens: sum(per.cacheInput).mapWith(Number).as('cache_input_tokens'),
        cacheMeasuredAttempts: sum(per.cacheMeasured).mapWith(Number).as('cache_measured_attempts'),
        reasoningTokens: sum(per.reasoning).mapWith(Number).as('reasoning_tokens'),
        reasoningMeasuredAttempts: sum(per.reasoningMeasured)
          .mapWith(Number)
          .as('reasoning_measured_attempts'),
        estimatedCostUsd: (withPricing ? sum(per.cost).mapWith(Number) : sql<null>`null`).as(
          'estimated_cost',
        ),
        pricedAttempts: (withPricing ? sum(per.priced).mapWith(Number) : sql<null>`null`).as(
          'priced_attempts',
        ),
        client: (withSessionClient
          ? sql`case when ${min(per.client)} = ${max(per.client)} then ${min(per.client)} end`
          : sql`null`
        ).as('client'),
      })
      .from(per)
      .groupBy(sql`${per.key}`);
  };
  const grouping = {
    all: sql<null>`null`,
    accounts: groupUsageText(measured.accountId, 256),
    models: groupUsageText(measured.model, 256),
    sessions: groupUsageText(measured.sessionId, 512),
    protocols: groupUsageText(measured.protocol, 64, false),
    clients: sql<string | null>`${measured.client}`,
  };
  return { selected, measured, grouping, aggregate };
}

export type UsageOverviewQueries = ReturnType<typeof usageOverviewQueries>;
