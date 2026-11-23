import type Database from 'better-sqlite3';
import {
  and,
  countDistinct,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { alias } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { getQuotaModelFamilyId } from '@/modules/cloud-account/utils/quota-model-families';
import { requestLogs, upstreamAttempts, type trafficAuditSchema } from './traffic-audit.schema';
import {
  USAGE_TRENDS_MODEL_LIMIT,
  UsageTrendsResultSchema,
  type UsageTrendsResult,
  type UsageTrendsWorkerInput,
} from './usage-trends.schema';

// Keep the worst-case names and minute buckets below the standalone RPC's 1 MiB limit.
const MAX_TOTAL_VARIANTS = 256;

type AuditDatabase = BetterSQLite3Database<typeof trafficAuditSchema>;
type TrendsQueryDatabase = Pick<AuditDatabase, 'all' | 'select'>;

export function readUsageTrends(
  raw: Database.Database,
  orm: AuditDatabase,
  input: UsageTrendsWorkerInput,
): UsageTrendsResult {
  raw.function('audit_model_family', { deterministic: true }, (model: unknown) =>
    typeof model === 'string' ? getQuotaModelFamilyId(model) : null,
  );
  return orm.transaction((tx) => readSnapshot(tx, input));
}

function readSnapshot(db: TrendsQueryDatabase, input: UsageTrendsWorkerInput): UsageTrendsResult {
  const to = input.asOf;
  const from = Math.max(0, to - (input.window === '1h' ? 3600000 : 86400000));
  const modelColumn = input.modelView === 'requested' ? requestLogs.model : upstreamAttempts.model;
  const modelTraffic = eq(requestLogs.trafficClass, 'model');
  const existingAttempt = alias(upstreamAttempts, 'existing_attempt');
  const attemptsByCutoff = db
    .select({ id: existingAttempt.id })
    .from(existingAttempt)
    .where(and(eq(existingAttempt.parentId, requestLogs.id), lte(existingAttempt.timestamp, to)));
  const attemptJoin = and(
    eq(upstreamAttempts.parentId, requestLogs.id),
    lte(upstreamAttempts.timestamp, to),
    or(
      eq(upstreamAttempts.usageScope, 'generation'),
      and(isNull(upstreamAttempts.usageScope), modelTraffic),
    ),
  );
  const matchingTraffic = and(
    modelTraffic,
    lte(requestLogs.timestamp, to),
    input.accountId === undefined ? undefined : eq(upstreamAttempts.accountId, input.accountId),
    input.model === undefined ? undefined : eq(modelColumn, input.model),
    or(isNotNull(upstreamAttempts.id), notExists(attemptsByCutoff)),
  );
  const terminalAttempt = and(
    isNotNull(upstreamAttempts.id),
    isNotNull(upstreamAttempts.completedAt),
    lte(upstreamAttempts.completedAt, to),
    ne(upstreamAttempts.outcome, 'in_progress'),
    eq(upstreamAttempts.responsePartial, false),
  );
  const candidates = db
    .select({
      id: sql`${requestLogs.id}`.as('id'),
      timestamp: sql`${requestLogs.timestamp}`.as('timestamp'),
      model: sql`${modelColumn}`.as('model'),
      attemptId: sql`${upstreamAttempts.id}`.as('attempt_id'),
      inputTokens: sql`${upstreamAttempts.inputTokens}`.as('input_tokens'),
      outputTokens: sql`${upstreamAttempts.outputTokens}`.as('output_tokens'),
      terminal: sql`CASE WHEN ${terminalAttempt} THEN 1 ELSE 0 END`.as('terminal'),
    })
    .from(requestLogs)
    .leftJoin(upstreamAttempts, attemptJoin)
    .where(and(gte(requestLogs.timestamp, from), matchingTraffic));
  const measured = sql`WITH candidates AS (${candidates.getSQL()}), measured AS (
    SELECT *, CASE WHEN terminal=1 AND typeof(input_tokens)='integer'
      AND input_tokens BETWEEN 0 AND 9007199254740991 THEN 1 ELSE 0 END has_input,
      CASE WHEN terminal=1 AND typeof(output_tokens)='integer'
      AND output_tokens BETWEEN 0 AND 9007199254740991 THEN 1 ELSE 0 END has_output
    FROM candidates
  )`;
  const metricSql = sql`COUNT(*) requests, SUM(attempts) attempts,
    CASE WHEN SUM(missing_input)>0 THEN NULL ELSE SUM(input_tokens) END inputTokens,
    CASE WHEN SUM(missing_output)>0 THEN NULL ELSE SUM(output_tokens) END outputTokens,
    CASE WHEN SUM(missing_input)>0 OR SUM(missing_output)>0 THEN NULL
      ELSE SUM(input_tokens)+SUM(output_tokens) END totalTokens,
    SUM(incomplete) incompleteRequests`;
  const requestGroups = {
    total: { columns: sql`1`, source: sql`measured` },
    minute: { columns: sql`timestamp`, source: sql`measured` },
    family: { columns: sql`family`, source: sql`attributed` },
    variant: { columns: sql`family, model`, source: sql`visible` },
  };
  const perRequest = (group: keyof typeof requestGroups) => {
    const { columns, source } = requestGroups[group];
    return sql`SELECT id, ${columns}, COUNT(attempt_id) attempts,
    MAX(has_input=0) missing_input, MAX(has_output=0) missing_output,
    MAX(has_input=0 OR has_output=0) incomplete,
    SUM(CASE WHEN has_input=1 THEN input_tokens ELSE 0 END) input_tokens,
    SUM(CASE WHEN has_output=1 THEN output_tokens ELSE 0 END) output_tokens
    FROM ${source} GROUP BY id, ${columns}`;
  };
  const totalsRows = db.all(sql`${measured}, grouped AS (${perRequest('total')})
    SELECT ${metricSql} FROM grouped HAVING COUNT(*)>0`);
  const bucketRows = db.all(sql`${measured}, grouped AS (${perRequest('minute')})
    SELECT (timestamp / 60000)*60000 timestamp, ${metricSql} FROM grouped
    GROUP BY (timestamp / 60000) ORDER BY timestamp`);
  const modelRows = db.all(sql`${measured}, attributed AS MATERIALIZED (
      SELECT *, audit_model_family(model) family FROM measured
    ), families AS (
      SELECT family, ${metricSql} FROM (${perRequest('family')})
      GROUP BY family ORDER BY requests DESC, family LIMIT ${USAGE_TRENDS_MODEL_LIMIT + 1}
    ), visible AS (
      SELECT attributed.* FROM attributed JOIN families ON attributed.family IS families.family
    ), variant_totals AS (
      SELECT family, model, ${metricSql} FROM (${perRequest('variant')})
      GROUP BY family, model
    ), variants AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY family ORDER BY requests DESC, model) variantRank
      FROM variant_totals
    ), variant_counts AS (
      SELECT family, COUNT(*) variantCount FROM variant_totals GROUP BY family
    )
    SELECT families.family, NULL model, 0 variantRank, variantCount, requests, attempts,
      inputTokens, outputTokens, totalTokens, incompleteRequests
    FROM families JOIN variant_counts ON families.family IS variant_counts.family
    UNION ALL
    SELECT family, model, variantRank, 0 variantCount, requests, attempts, inputTokens,
    outputTokens, totalTokens, incompleteRequests FROM variants
    WHERE variantRank<=${USAGE_TRENDS_MODEL_LIMIT}
    ORDER BY variantRank, requests DESC, family, model
    LIMIT (SELECT COUNT(*) + ${MAX_TOTAL_VARIANTS} FROM families)`);
  const empty = {
    requests: 0,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    incompleteRequests: 0,
  };
  const rows = zBucketRows.parse(bucketRows);
  const buckets = [];
  let index = 0;
  for (let timestamp = Math.floor(from / 60000) * 60000; timestamp <= to; timestamp += 60000) {
    const row = rows[index];
    if (row?.timestamp === timestamp) {
      buckets.push(row);
      index += 1;
    } else {
      buckets.push({ timestamp, ...empty });
    }
  }
  return UsageTrendsResultSchema.parse({
    window: input.window,
    modelView: input.modelView,
    from,
    to,
    bucketMs: 60000,
    coverage: 'retained-local-records',
    totals: totalsRows[0] ?? empty,
    buckets,
    ...groupModelRows(modelRowsSchema.parse(modelRows)),
    ...(input.includeActivity && {
      activity: readActivity(db, to, attemptJoin, matchingTraffic),
    }),
  });
}

const zBucketRows = UsageTrendsResultSchema.shape.buckets;
const modelRowsSchema = z.array(
  UsageTrendsResultSchema.shape.totals.extend({
    family: z.string().max(256).nullable(),
    model: z.string().max(256).nullable(),
    variantRank: z.number().int().nonnegative(),
    variantCount: z.number().int().nonnegative(),
  }),
);

function groupModelRows(
  rows: z.infer<typeof modelRowsSchema>,
): Pick<UsageTrendsResult, 'modelFamilies' | 'modelFamiliesTruncated'> {
  type FamilyRow = Omit<UsageTrendsResult['modelFamilies'][number], 'variantsTruncated'> & {
    variantCount: number;
  };
  const families = new Map<string | null, FamilyRow>();
  for (const { family, model, variantRank, variantCount, ...usage } of rows) {
    if (variantRank === 0) {
      families.set(family, { family, ...usage, variants: [], variantCount });
      continue;
    }
    families.get(family)?.variants.push({ model, ...usage });
  }
  return {
    modelFamilies: [...families.values()]
      .slice(0, USAGE_TRENDS_MODEL_LIMIT)
      .map(({ variantCount, ...family }) => ({
        ...family,
        variantsTruncated: family.variants.length < variantCount,
      })),
    modelFamiliesTruncated: families.size > USAGE_TRENDS_MODEL_LIMIT,
  };
}

function readActivity(
  db: TrendsQueryDatabase,
  to: number,
  attemptJoin: SQL | undefined,
  matchingTraffic: SQL | undefined,
) {
  const now = new Date(to);
  // Build each boundary independently so days spanning a clock change retain their full interval.
  const days = Array.from({ length: 30 }, (_, index) => {
    const calendar = new Date(
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - 29 + index),
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
  const activity = db
    .select({ requests: countDistinct(requestLogs.id) })
    .from(requestLogs)
    .leftJoin(upstreamAttempts, attemptJoin)
    .where(
      and(
        gte(requestLogs.timestamp, sql`days.starts_at`),
        lt(requestLogs.timestamp, sql`days.ends_at`),
        matchingTraffic,
      ),
    );
  return db.all(sql`
    WITH days(date, starts_at, ends_at) AS (VALUES ${values})
    SELECT days.date, (${activity.getSQL()}) requests
    FROM days ORDER BY days.date
  `);
}
