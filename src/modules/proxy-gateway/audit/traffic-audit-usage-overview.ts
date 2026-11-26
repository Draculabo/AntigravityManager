import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getDeclaredContextWindow } from '../antigravity/ModelSpecs';
import {
  and,
  between,
  countDistinct,
  desc,
  eq,
  inArray,
  isNotNull,
  lte,
  min,
  or,
  sql,
  sum,
  type SQL,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { iterateSqliteQuery } from '@/shared/persistence/database/iterate-sqlite-query';
import { auditPayloads, requestBodyRefs, requestLogs } from './traffic-audit.schema';
import {
  groupUsageText,
  usageBucket,
  usageOverviewQueries,
  type UsageOverviewDatabase,
  type UsageOverviewQueries,
} from './traffic-audit-usage-overview-queries';
import { readUsageOverviewAnalytics } from './traffic-audit-usage-overview-analytics';
import {
  AUDIT_CONVERSATION_BODY_LIMIT,
  AUDIT_CONVERSATION_CHUNK_LIMIT,
  matchAuditSessionContent,
  normalizeAuditConversationText,
} from './audit-conversation-text';
import { readAuditSessionTitles } from './audit-session-titles';
import {
  USAGE_OVERVIEW_LIMIT,
  UsageAnalyticsSchema,
  UsageOverviewResultSchema,
  type UsageOverviewMetrics,
  type UsageOverviewWorkerInput,
} from './usage-overview.schema';

const empty: UsageOverviewMetrics = {
  requests: 0,
  attempts: 0,
  retriedRequests: 0,
  failedRequests: 0,
  incompleteRequests: 0,
  inputTokens: 0,
  peakInputTokens: null,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheInputTokens: 0,
  cacheMeasuredAttempts: 0,
  reasoningTokens: 0,
  reasoningMeasuredAttempts: 0,
};

type Group = 'accounts' | 'models' | 'sessions' | 'protocols' | 'clients';

type MetricsRow = ReturnType<ReturnType<UsageOverviewQueries['aggregate']>['all']>[number];

function overviewMetrics(row: MetricsRow, withPricing: boolean, withClient = false) {
  const { estimatedCostUsd, pricedAttempts, client, ...metrics } = row;
  return {
    ...metrics,
    ...(withPricing && { estimatedCostUsd, pricedAttempts }),
    ...(withClient && { client }),
  };
}

export function readUsageOverview(raw: Database.Database, input: UsageOverviewWorkerInput) {
  return drizzle(raw).transaction((db) => {
    const to = Math.min(input.to, input.asOf);
    const first =
      input.allRetained && input.from === 0
        ? db
            .select({ first: min(requestLogs.timestamp) })
            .from(requestLogs)
            .where(and(eq(requestLogs.trafficClass, 'model'), lte(requestLogs.timestamp, to)))
            .get()
        : undefined;
    const earliest = z
      .object({ first: z.number().int().nonnegative().safe().nullable() })
      .safeParse(first);
    const from = earliest.success ? (earliest.data.first ?? to) : input.from;
    const bucketDays = Math.max(1, Math.ceil((to - from) / (40 * 86_400_000)));
    const bucketMs = input.to - from <= 2 * 86_400_000 ? 3_600_000 : bucketDays * 86_400_000;
    const withPricing = input.prices !== undefined;
    const observedThrough = Math.min(input.observedThrough ?? to, input.asOf);
    const queries = usageOverviewQueries(db, input, from, to, observedThrough);
    const { selected, measured, grouping, aggregate } = queries;
    const total = aggregate(grouping.all, withPricing).get();
    const { key: _key, ...totals } = total
      ? UsageOverviewResultSchema.shape.totals
          .extend({ key: z.null() })
          .parse(overviewMetrics(total, withPricing))
      : { key: null, ...empty };
    const needle =
      input.sessionSearch && normalizeAuditConversationText(input.sessionSearch).toLowerCase();
    const matchedSessions = needle
      ? findMatchingSessions(raw, db, selected, observedThrough, needle)
      : undefined;
    const ranked = (group: Group) => {
      const sessions = group === 'sessions';
      const metrics = aggregate(grouping[group], withPricing, sessions).as('usage_ranked');
      const totalTokens = sql`${metrics.inputTokens} + ${metrics.outputTokens}`;
      const rank = {
        tokens: [desc(totalTokens), desc(metrics.requests), sql`${metrics.key}`],
        requests: [desc(metrics.requests), desc(totalTokens), sql`${metrics.key}`],
        cost: withPricing
          ? [desc(metrics.estimatedCostUsd), desc(metrics.pricedAttempts), sql`${metrics.key}`]
          : [sql`${metrics.key}`],
        name: [
          sql`${metrics.key} is null`,
          sql`${metrics.key} collate nocase`,
          sql`${metrics.key}`,
        ],
      }[input.sort ?? 'tokens'];
      const matched =
        matchedSessions === undefined
          ? undefined
          : db
              .select({ value: sql<string>`${sql.identifier('value')}` })
              .from(sql`json_each(${JSON.stringify(matchedSessions)})`);
      const schema =
        group === 'clients' || group === 'protocols'
          ? UsageAnalyticsSchema.shape[group]
          : UsageOverviewResultSchema.shape[group];
      const rows = schema.shape.rows.element.array().parse(
        db
          .select()
          .from(metrics)
          .where(
            sessions
              ? and(isNotNull(metrics.key), matched && inArray(metrics.key, matched))
              : undefined,
          )
          .orderBy(...rank)
          .limit(USAGE_OVERVIEW_LIMIT + 1)
          .offset(sessions ? (input.sessionOffset ?? 0) : 0)
          .all()
          .map((row) => overviewMetrics(row, withPricing, sessions)),
      );
      const visible = rows.slice(0, USAGE_OVERVIEW_LIMIT).map((row) => {
        if (group !== 'models' || row.key === null) {
          return row;
        }
        return { ...row, contextWindow: getDeclaredContextWindow(row.key) };
      });
      return { rows: visible, truncated: rows.length > USAGE_OVERVIEW_LIMIT };
    };
    const starts: number[] = [];
    for (let timestamp = from; timestamp <= to; ) {
      starts.push(timestamp);
      if (bucketMs === 3_600_000) {
        timestamp += bucketMs;
      } else {
        const day = new Date(timestamp);
        day.setHours(24 * bucketDays, 0, 0, 0);
        timestamp = day.getTime();
      }
    }
    const bucket = usageBucket(measured.timestamp, starts);
    const summary = aggregate(bucket, withPricing).as('usage_buckets');
    const rows = UsageOverviewResultSchema.shape.totals
      .extend({ key: z.number().int().nonnegative() })
      .array()
      .parse(
        db
          .select()
          .from(summary)
          .orderBy(sql`${summary.key}`)
          .all()
          .map((row) => overviewMetrics(row, withPricing)),
      );
    let next = 0;
    const buckets = starts.map((timestamp, bucket) => {
      const row = rows[next];
      if (row?.key === bucket) {
        const { key: _bucket, ...metrics } = row;
        next += 1;
        return { timestamp, ...metrics };
      }
      return { timestamp, ...empty };
    });
    const sessions = ranked('sessions');
    // Only reports with a session table request prompt-derived labels.
    if (input.sessionOffset !== undefined) {
      const keys = sessions.rows.flatMap(({ key }) => (key === null ? [] : [key]));
      const titles = readAuditSessionTitles(raw, keys, observedThrough);
      sessions.rows = sessions.rows.map((row) => {
        const title = row.key === null ? undefined : titles.get(row.key);
        return title ? { ...row, title } : row;
      });
    }
    return UsageOverviewResultSchema.parse({
      from,
      to,
      bucketMs,
      buckets,
      totals,
      accounts: ranked('accounts'),
      models: ranked('models'),
      sessions,
      ...(input.seriesGroup && {
        series: readSeries(db, queries, grouping[input.seriesGroup], starts),
      }),
      ...(input.includeAnalytics && {
        analytics: {
          protocols: ranked('protocols'),
          clients: ranked('clients'),
          ...readUsageOverviewAnalytics(db, queries, starts, from, to, input.asOf),
        },
      }),
    });
  });
}

function findMatchingSessions(
  raw: Database.Database,
  db: UsageOverviewDatabase,
  selected: UsageOverviewQueries['selected'],
  observedThrough: number,
  needle: string,
) {
  const scoped = db.$with('search_sessions').as(
    db
      .selectDistinct({
        id: selected.id,
        sessionId: selected.sessionId,
      })
      .from(selected)
      .where(isNotNull(groupUsageText(selected.sessionId, 512))),
  );
  const query = db
    .with(selected, scoped)
    .select({
      sessionId: sql`${scoped.sessionId}`.as('sessionId'),
      direction: requestBodyRefs.direction,
      id: auditPayloads.id,
      storedBytes: sql`${auditPayloads.storedBytes}`.as('storedBytes'),
      chunkCount: sql`${auditPayloads.chunkCount}`.as('chunkCount'),
    })
    .from(scoped)
    .innerJoin(requestBodyRefs, eq(requestBodyRefs.requestId, scoped.id))
    .innerJoin(
      auditPayloads,
      and(eq(auditPayloads.id, requestBodyRefs.payloadId), eq(auditPayloads.requestId, scoped.id)),
    )
    .where(
      and(
        lte(auditPayloads.completedAt, observedThrough),
        eq(auditPayloads.state, 'complete'),
        eq(auditPayloads.partial, false),
        eq(auditPayloads.oversized, false),
        inArray(requestBodyRefs.direction, ['request', 'response']),
        between(auditPayloads.storedBytes, 1, AUDIT_CONVERSATION_BODY_LIMIT),
        between(auditPayloads.chunkCount, 1, AUDIT_CONVERSATION_CHUNK_LIMIT),
        or(
          and(eq(auditPayloads.kind, 'json'), eq(auditPayloads.representation, 'sanitized_json')),
          and(
            eq(requestBodyRefs.direction, 'response'),
            eq(auditPayloads.representation, 'reconstructed_sse'),
          ),
        ),
      ),
    );
  return matchAuditSessionContent(raw, iterateSqliteQuery(raw, query), needle);
}

function readSeries(
  db: UsageOverviewDatabase,
  { selected, measured }: UsageOverviewQueries,
  key: SQL<string | null>,
  starts: number[],
) {
  const bucket = usageBucket(measured.timestamp, starts);
  const amounts = db.$with('usage_amounts').as(
    db
      .select({
        id: measured.id,
        key: key.as('key'),
        bucket: bucket.as('bucket'),
        input: sql<number>`coalesce(${measured.input}, 0)`.as('series_input'),
        output: sql<number>`coalesce(${measured.output}, 0)`.as('series_output'),
      })
      .from(measured),
  );
  const leaderCounts = db.$with('usage_leader_counts').as(
    db
      .select({
        key: sql<string | null>`${amounts.key}`.as('leader_key'),
        tokens: sum(sql`${amounts.input} + ${amounts.output}`).as('leader_tokens'),
        requests: countDistinct(amounts.id).as('leader_requests'),
      })
      .from(amounts)
      .groupBy(sql`${amounts.key}`),
  );
  const leaders = db.$with('usage_leaders').as(
    db
      .select()
      .from(leaderCounts)
      .orderBy(desc(leaderCounts.tokens), desc(leaderCounts.requests), sql`${leaderCounts.key}`)
      .limit(6),
  );
  const shape = UsageOverviewResultSchema.shape.series.unwrap().element.shape.points.element;
  const rows = shape
    .omit({ timestamp: true })
    .extend({
      key: z.string().max(256).nullable(),
      bucket: z.number().int().min(0).max(48),
    })
    .array()
    .parse(
      db
        .with(selected, measured, amounts, leaderCounts, leaders)
        .select({
          key: amounts.key,
          bucket: amounts.bucket,
          requests: countDistinct(amounts.id),
          inputTokens: sum(amounts.input).mapWith(Number),
          outputTokens: sum(amounts.output).mapWith(Number),
        })
        .from(amounts)
        .innerJoin(leaders, sql`${amounts.key} is ${leaders.key}`)
        .groupBy(sql`${amounts.key}`, sql`${amounts.bucket}`)
        .orderBy(
          desc(leaders.tokens),
          desc(leaders.requests),
          sql`${amounts.key}`,
          sql`${amounts.bucket}`,
        )
        .all(),
    );
  const groups = new Map<string | null, z.infer<typeof shape>[]>();
  for (const { key, bucket: index, ...metrics } of rows) {
    const timestamp = starts[index];
    if (timestamp === undefined) {
      continue;
    }
    const points = groups.get(key) ?? [];
    points.push({ timestamp, ...metrics });
    groups.set(key, points);
  }
  return [...groups].map(([key, points]) => ({ key, points }));
}
