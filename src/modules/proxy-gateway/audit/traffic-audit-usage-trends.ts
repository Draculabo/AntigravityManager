import type Database from 'better-sqlite3';
import { UsageTrendsResultSchema, type UsageTrendsWorkerInput } from './usage-trends.schema';

export function readUsageTrends(raw: Database.Database, input: UsageTrendsWorkerInput) {
  return raw.transaction(() => readSnapshot(raw, input))();
}

function readSnapshot(raw: Database.Database, input: UsageTrendsWorkerInput) {
  const to = input.asOf;
  const from = Math.max(0, to - (input.window === '1h' ? 3600000 : 86400000));
  const modelColumn = input.modelView === 'requested' ? 'r.model' : 'a.model';
  const attemptJoin = `LEFT JOIN upstream_attempts a ON a.parent_id=r.id AND a.timestamp<=@to
    AND (a.usage_scope='generation' OR (a.usage_scope IS NULL AND r.traffic_class='model'))`;
  const matchingTraffic = `r.traffic_class='model' AND r.timestamp<=@to
    AND (@accountId IS NULL OR a.account_id=@accountId)
    AND (@model IS NULL OR ${modelColumn}=@model)
    AND (a.id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM upstream_attempts x WHERE x.parent_id=r.id AND x.timestamp<=@to
    ))`;
  const candidates = `WITH candidates AS (
    SELECT r.id, r.timestamp, ${modelColumn} model, a.id attempt_id,
      a.input_tokens, a.output_tokens,
      CASE WHEN a.id IS NOT NULL AND a.completed_at IS NOT NULL AND a.completed_at<=@to
        AND a.outcome<>'in_progress' AND a.response_partial=0 THEN 1 ELSE 0 END terminal
    FROM request_logs r ${attemptJoin}
    WHERE r.timestamp>=@from AND ${matchingTraffic}
  ), measured AS (
    SELECT *, CASE WHEN terminal=1 AND typeof(input_tokens)='integer'
      AND input_tokens BETWEEN 0 AND 9007199254740991 THEN 1 ELSE 0 END has_input,
      CASE WHEN terminal=1 AND typeof(output_tokens)='integer'
      AND output_tokens BETWEEN 0 AND 9007199254740991 THEN 1 ELSE 0 END has_output
    FROM candidates
  )`;
  const metricSql = `COUNT(*) requests, SUM(attempts) attempts,
    CASE WHEN SUM(missing_input)>0 THEN NULL ELSE SUM(input_tokens) END inputTokens,
    CASE WHEN SUM(missing_output)>0 THEN NULL ELSE SUM(output_tokens) END outputTokens,
    CASE WHEN SUM(missing_input)>0 OR SUM(missing_output)>0 THEN NULL
      ELSE SUM(input_tokens)+SUM(output_tokens) END totalTokens,
    SUM(incomplete) incompleteRequests`;
  const perRequest = (group: string) => `SELECT id, ${group}, COUNT(attempt_id) attempts,
    MAX(has_input=0) missing_input, MAX(has_output=0) missing_output,
    MAX(has_input=0 OR has_output=0) incomplete,
    SUM(CASE WHEN has_input=1 THEN input_tokens ELSE 0 END) input_tokens,
    SUM(CASE WHEN has_output=1 THEN output_tokens ELSE 0 END) output_tokens
    FROM measured GROUP BY id, ${group}`;
  const params = { from, to, accountId: input.accountId ?? null, model: input.model ?? null };
  const totalsRows = raw.prepare(`${candidates}, grouped AS (${perRequest('1')})
    SELECT ${metricSql} FROM grouped HAVING COUNT(*)>0`).all(params);
  const bucketRows = raw.prepare(`${candidates}, grouped AS (${perRequest('timestamp')})
    SELECT (timestamp / 60000)*60000 timestamp, ${metricSql} FROM grouped
    GROUP BY (timestamp / 60000) ORDER BY timestamp`).all(params);
  const modelRows = raw.prepare(`${candidates}, grouped AS (${perRequest('model')})
    SELECT model, ${metricSql} FROM grouped
    GROUP BY model ORDER BY requests DESC, model LIMIT 51`).all(params);
  const empty = { requests: 0, attempts: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, incompleteRequests: 0 };
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
    window: input.window, modelView: input.modelView, from, to, bucketMs: 60000,
    coverage: 'retained-local-records', totals: totalsRows[0] ?? empty, buckets,
    models: modelRows.slice(0, 50), modelsTruncated: modelRows.length > 50,
    ...(input.includeActivity && {
      activity: readActivity(raw, { to, accountId: params.accountId, model: params.model }, attemptJoin, matchingTraffic),
    }),
  });
}

const zBucketRows = UsageTrendsResultSchema.shape.buckets;

function readActivity(
  raw: Database.Database,
  params: { to: number; accountId: string | null; model: string | null },
  attemptJoin: string,
  matchingTraffic: string,
) {
  const now = new Date(params.to);
  // Build each boundary independently so days spanning a clock change retain their full interval.
  const days = Array.from({ length: 30 }, (_, index) => {
    const calendar = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - 29 + index));
    const year = calendar.getUTCFullYear();
    const month = calendar.getUTCMonth();
    const day = calendar.getUTCDate();
    return {
      date: calendar.toISOString().slice(0, 10),
      start: new Date(year, month, day).getTime(),
      end: new Date(year, month, day + 1).getTime(),
    };
  });
  const dayParams = Object.fromEntries(days.flatMap(({ date, start, end }, index) => [
    [`date${index}`, date],
    [`start${index}`, start],
    [`end${index}`, end],
  ]));
  const values = days.map((_, index) => `(@date${index}, @start${index}, @end${index})`).join(', ');
  return raw.prepare(`
    WITH days(date, starts_at, ends_at) AS (VALUES ${values})
    SELECT days.date, (
      SELECT COUNT(DISTINCT r.id)
      FROM request_logs r ${attemptJoin}
      WHERE r.timestamp>=days.starts_at AND r.timestamp<days.ends_at AND ${matchingTraffic}
    ) requests
    FROM days ORDER BY days.date
  `).all({ ...params, ...dayParams });
}
