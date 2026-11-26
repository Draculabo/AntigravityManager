import {
  and,
  avg,
  count,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  sql,
  sum,
  type SQLWrapper,
} from 'drizzle-orm';
import { auditPayloads, requestBodyRefs } from './traffic-audit.schema';
import {
  groupUsageText,
  usageBucket,
  type UsageOverviewDatabase,
  type UsageOverviewQueries,
} from './traffic-audit-usage-overview-queries';
import { USAGE_OVERVIEW_LIMIT } from './usage-overview.schema';

function knownTimingValue(
  timing: SQLWrapper,
  field: 'firstUsableOutputMs' | 'uploadedBodyBytes' | 'downloadedBodyBytes',
) {
  const path = `$.${field}`;
  return sql<number | null>`case when json_valid(${timing}) then
    case when json_extract(${timing}, '$.version') = 1
      and json_type(${timing}, ${path}) = 'integer'
      and json_extract(${timing}, ${path}) between 0 and 9007199254740991
      then json_extract(${timing}, ${path}) end end`;
}

export function readUsageOverviewAnalytics(
  db: UsageOverviewDatabase,
  { selected, measured }: UsageOverviewQueries,
  starts: number[],
  from: number,
  to: number,
  asOf: number,
) {
  const timings = db.$with('usage_timings').as(
    db
      .select({
        timestamp: measured.timestamp,
        model: measured.model,
        output: measured.output,
        duration: measured.duration,
        upload: knownTimingValue(measured.timing, 'uploadedBodyBytes').as('upload'),
        download: knownTimingValue(measured.timing, 'downloadedBodyBytes').as('download'),
        firstObserved: sql<number | null>`case when ${measured.terminal} = 1
      then ${knownTimingValue(measured.timing, 'firstUsableOutputMs')} end`.as('first_observed'),
      })
      .from(measured),
  );
  const decoding = sql`${timings.output} > 0 and ${timings.duration} > ${timings.firstObserved}`;
  const rates = db.$with('usage_rates').as(
    db
      .select({
        timestamp: timings.timestamp,
        model: timings.model,
        upload: timings.upload,
        download: timings.download,
        firstOutput: sql<number | null>`case when ${timings.firstObserved} <= ${timings.duration}
      then ${timings.firstObserved} end`.as('first_output'),
        decoded: sql<number | null>`case when ${decoding} then ${timings.output} end`.as('decoded'),
        elapsed: sql<number | null>`case when ${decoding}
      then ${timings.duration} - ${timings.firstObserved} end`.as('elapsed'),
      })
      .from(timings),
  );
  const sampled = db.with(selected, measured, timings, rates);
  const tokenRate = sql<number | null>`(1000.0 * ${sum(rates.decoded)}) / ${sum(rates.elapsed)}`;
  const model = groupUsageText(rates.model, 256);
  const firstOutputAttempts = count(rates.firstOutput);
  const speed = sampled
    .select({
      key: model,
      firstOutputAttempts,
      meanFirstOutputMs: avg(rates.firstOutput).mapWith(Number),
      decodeAttempts: count(rates.decoded),
      outputTokensPerSecond: tokenRate,
    })
    .from(rates)
    .groupBy(model)
    .having(gte(firstOutputAttempts, 1))
    .orderBy(desc(firstOutputAttempts), model)
    .limit(USAGE_OVERVIEW_LIMIT)
    .all();

  const parents = db.$with('usage_parents').as(
    db
      .selectDistinct({
        id: selected.id,
        timestamp: selected.timestamp,
        completedAt: selected.completedAt,
        outcome: selected.outcome,
      })
      .from(selected),
  );
  const hour = sql<
    number | null
  >`cast(strftime('%H', ${parents.timestamp} / 1000, 'unixepoch', 'localtime') as integer)`;
  const day = sql<number>`unixepoch(date(${parents.timestamp} / 1000, 'unixepoch', 'localtime'), 'utc') * 1000`;
  const activity = db
    .with(selected, parents)
    .select({ day, hour, requests: count() })
    .from(parents)
    .where(
      and(
        gte(parents.timestamp, Math.max(from, to - 31 * 86_400_000)),
        gte(day, 0),
        isNotNull(hour),
      ),
    )
    .groupBy(day, hour)
    .orderBy(day, hour)
    .limit(1176)
    .all();

  const bodySize = (direction: string) =>
    sql<number>`coalesce(${sum(sql`case when ${eq(requestBodyRefs.direction, direction)}
      then ${auditPayloads.storedBytes} end`)}, 0)`;
  const isDirection = (direction: string) =>
    sql<number | null>`case when ${eq(requestBodyRefs.direction, direction)} then 1 end`;
  const capture = db
    .with(selected, parents)
    .select({
      requests: sql<number>`${db.select({ value: count() }).from(parents)}`,
      requestBytes: bodySize('request'),
      responseBytes: bodySize('response'),
      requestBodies: count(isDirection('request')),
      responseBodies: count(isDirection('response')),
    })
    .from(parents)
    .innerJoin(requestBodyRefs, eq(requestBodyRefs.requestId, parents.id))
    .innerJoin(auditPayloads, eq(auditPayloads.id, requestBodyRefs.payloadId))
    .where(and(eq(auditPayloads.state, 'complete'), eq(auditPayloads.partial, false)))
    .get();

  const transport = sampled
    .select({
      uploadBytes: sql<number>`coalesce(${sum(rates.upload)}, 0)`,
      downloadBytes: sql<number>`coalesce(${sum(rates.download)}, 0)`,
      uploadSamples: count(rates.upload),
      downloadSamples: count(rates.download),
    })
    .from(rates)
    .get();

  const live =
    to === asOf
      ? db
          .with(selected, parents)
          .select({
            asOf: sql<number>`${to}`,
            inFlight: count(
              sql`case when ${and(
                eq(parents.outcome, 'in_progress'),
                isNull(parents.completedAt),
              )} then 1 end`,
            ),
            startedLastMinute: count(
              sql`case when ${gte(parents.timestamp, to - 60_000)} then 1 end`,
            ),
          })
          .from(parents)
          .get()
      : undefined;

  const bucket = usageBucket(rates.timestamp, starts);
  const samples = sampled
    .select({
      bucket,
      uploadBytes: sum(rates.upload).mapWith(Number),
      downloadBytes: sum(rates.download).mapWith(Number),
      outputTokensPerSecond: tokenRate,
    })
    .from(rates)
    .groupBy(bucket)
    .orderBy(bucket)
    .all();
  const trend = samples.flatMap(({ bucket: index, ...value }) => {
    const timestamp = starts[index];
    return timestamp === undefined ? [] : [{ timestamp, ...value }];
  });
  return { speed, activity, capture, transport, live, trend };
}
