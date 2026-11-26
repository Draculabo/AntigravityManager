import type Database from 'better-sqlite3';
import {
  and,
  asc,
  between,
  count,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQLWrapper,
} from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { alias } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import { getQuotaModelFamilyId } from '@/modules/cloud-account/utils/quota-model-families';
import { requestLogs, upstreamAttempts, type trafficAuditSchema } from './traffic-audit.schema';
import { readActivityDays } from './traffic-audit-activity-days';
import {
  USAGE_TRENDS_MODEL_LIMIT,
  UsageTrendsResultSchema,
  type UsageTrendsResult,
  type UsageTrendsWorkerInput,
} from './usage-trends.schema';

// Keep the worst-case names and minute buckets below the standalone RPC's 1 MiB limit.
const MAX_TOTAL_VARIANTS = 256;

type AuditDatabase = BetterSQLite3Database<typeof trafficAuditSchema>;
type TrendsQueryDatabase = Pick<AuditDatabase, '$with' | 'select' | 'with'>;

function requestMetrics({
  attemptId,
  input,
  output,
}: {
  attemptId: SQLWrapper;
  input: SQLWrapper;
  output: SQLWrapper;
}) {
  return {
    attempts: count(attemptId).as('request_attempts'),
    missingInput: sql<number>`max(${isNull(input)})`.as('missing_input'),
    missingOutput: sql<number>`max(${isNull(output)})`.as('missing_output'),
    incomplete: sql<number>`max(${isNull(input)} or ${isNull(output)})`.as('incomplete'),
    input: sql<number>`sum(coalesce(${input}, 0))`.as('request_input'),
    output: sql<number>`sum(coalesce(${output}, 0))`.as('request_output'),
  };
}

function usageMetrics({
  attempts,
  missingInput,
  missingOutput,
  incomplete,
  input,
  output,
}: ReturnType<typeof requestMetrics>) {
  const absentInput = sql`sum(${missingInput}) > 0`;
  const absentOutput = sql`sum(${missingOutput}) > 0`;
  return {
    requests: count().as('requests'),
    attempts: sql<number>`sum(${attempts})`.as('attempts'),
    inputTokens: sql<number | null>`case when ${absentInput} then null else sum(${input}) end`.as(
      'input_tokens',
    ),
    outputTokens: sql<
      number | null
    >`case when ${absentOutput} then null else sum(${output}) end`.as('output_tokens'),
    totalTokens: sql<number | null>`case when ${absentInput} or ${absentOutput} then null
      else sum(${input}) + sum(${output}) end`.as('total_tokens'),
    incompleteRequests: sql<number>`sum(${incomplete})`.as('incomplete_requests'),
  };
}

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
  const validTokens = (
    column: typeof upstreamAttempts.inputTokens | typeof upstreamAttempts.outputTokens,
  ) =>
    sql<number | null>`case when ${terminalAttempt} and typeof(${column}) = 'integer'
      and ${between(column, 0, Number.MAX_SAFE_INTEGER)} then ${column} end`;
  const measured = db.$with('measured').as(
    db
      .select({
        id: requestLogs.id,
        timestamp: requestLogs.timestamp,
        model: sql<string | null>`${modelColumn}`.as('candidate_model'),
        attemptId: sql<string | null>`${upstreamAttempts.id}`.as('attempt_id'),
        input: validTokens(upstreamAttempts.inputTokens).as('measured_input'),
        output: validTokens(upstreamAttempts.outputTokens).as('measured_output'),
      })
      .from(requestLogs)
      .leftJoin(upstreamAttempts, attemptJoin)
      .where(and(gte(requestLogs.timestamp, from), matchingTraffic)),
  );
  const attributed = db.$with('attributed').as(
    db
      .select({
        id: measured.id,
        model: measured.model,
        attemptId: measured.attemptId,
        input: measured.input,
        output: measured.output,
        family: sql<string | null>`audit_model_family(${measured.model})`.as('candidate_family'),
      })
      .from(measured),
  );
  const shortGroups = db.$with('short_groups').as(
    db
      .select({
        timestamp: measured.timestamp,
        ...requestMetrics(measured),
      })
      .from(measured)
      .groupBy(measured.id, measured.timestamp),
  );
  const totals = db
    .with(measured, shortGroups)
    .select(usageMetrics(shortGroups))
    .from(shortGroups)
    .having(gt(count(), 0))
    .get();
  const bucket = sql<number>`(${shortGroups.timestamp} / 60000) * 60000`;
  const bucketRows = db
    .with(measured, shortGroups)
    .select({ timestamp: bucket, ...usageMetrics(shortGroups) })
    .from(shortGroups)
    .groupBy(bucket)
    .orderBy(asc(bucket))
    .all();
  const familyRequests = db.$with('family_requests').as(
    db
      .select({ family: attributed.family, ...requestMetrics(attributed) })
      .from(attributed)
      .groupBy(attributed.id, sql`${attributed.family}`),
  );
  const families = db.$with('families').as(
    db
      .select({
        family: sql<string | null>`${familyRequests.family}`.as('summary_family'),
        ...usageMetrics(familyRequests),
      })
      .from(familyRequests)
      .groupBy(sql`${familyRequests.family}`)
      .orderBy(({ requests, family }) => [desc(requests), asc(family)])
      .limit(USAGE_TRENDS_MODEL_LIMIT + 1),
  );
  const variantRequests = db.$with('variant_requests').as(
    db
      .select({ family: attributed.family, model: attributed.model, ...requestMetrics(attributed) })
      .from(attributed)
      .innerJoin(families, sql`${attributed.family} is ${families.family}`)
      .groupBy(attributed.id, sql`${attributed.family}`, sql`${attributed.model}`),
  );
  const variantTotals = db.$with('variant_totals').as(
    db
      .select({
        family: variantRequests.family,
        model: variantRequests.model,
        ...usageMetrics(variantRequests),
      })
      .from(variantRequests)
      .groupBy(sql`${variantRequests.family}`, sql`${variantRequests.model}`),
  );
  const variants = db.$with('variants').as(
    db
      .select({
        family: variantTotals.family,
        model: variantTotals.model,
        requests: variantTotals.requests,
        attempts: variantTotals.attempts,
        inputTokens: variantTotals.inputTokens,
        outputTokens: variantTotals.outputTokens,
        totalTokens: variantTotals.totalTokens,
        incompleteRequests: variantTotals.incompleteRequests,
        variantRank: sql<number>`row_number() over (
          partition by ${variantTotals.family} order by ${desc(variantTotals.requests)}, ${variantTotals.model}
        )`.as('variant_rank'),
      })
      .from(variantTotals),
  );
  const variantCounts = db.$with('variant_counts').as(
    db
      .select({
        family: sql<string | null>`${variantTotals.family}`.as('count_family'),
        count: count().as('variant_count'),
      })
      .from(variantTotals)
      .groupBy(sql`${variantTotals.family}`),
  );
  const modelRows = db
    .with(
      measured,
      attributed,
      familyRequests,
      families,
      variantRequests,
      variantTotals,
      variantCounts,
      variants,
    )
    .select({
      family: families.family,
      model: sql<string | null>`null`.as('model'),
      variantRank: sql<number>`0`.as('rank'),
      variantCount: variantCounts.count,
      requests: families.requests,
      attempts: families.attempts,
      inputTokens: families.inputTokens,
      outputTokens: families.outputTokens,
      totalTokens: families.totalTokens,
      incompleteRequests: families.incompleteRequests,
    })
    .from(families)
    .innerJoin(variantCounts, sql`${families.family} is ${variantCounts.family}`)
    .unionAll(
      db
        .select({
          family: variants.family,
          model: variants.model,
          variantRank: variants.variantRank,
          variantCount: sql<number>`0`,
          requests: variants.requests,
          attempts: variants.attempts,
          inputTokens: variants.inputTokens,
          outputTokens: variants.outputTokens,
          totalTokens: variants.totalTokens,
          incompleteRequests: variants.incompleteRequests,
        })
        .from(variants)
        .where(lte(variants.variantRank, USAGE_TRENDS_MODEL_LIMIT)),
    )
    .orderBy(({ variantRank, requests, family, model }) => [
      asc(variantRank),
      desc(requests),
      asc(family),
      asc(model),
    ])
    .limit(USAGE_TRENDS_MODEL_LIMIT + 1 + MAX_TOTAL_VARIANTS)
    .all();
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
    totals: totals ?? empty,
    buckets,
    ...groupModelRows(modelRowsSchema.parse(modelRows)),
    ...(input.includeActivity && {
      activity: readActivityDays(
        db,
        to,
        input.prices,
        attemptJoin,
        matchingTraffic,
        terminalAttempt,
      ),
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
  let variantTotal = 0;
  for (const { family, model, variantRank, variantCount, ...usage } of rows) {
    if (variantRank === 0) {
      families.set(family, { family, ...usage, variants: [], variantCount });
      continue;
    }
    if (variantTotal === MAX_TOTAL_VARIANTS) {
      break;
    }
    families.get(family)?.variants.push({ model, ...usage });
    variantTotal += 1;
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
