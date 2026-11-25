import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getDeclaredContextWindow } from '../antigravity/ModelSpecs';
import { observedAuditClient } from './audit-client-identity';
import {
  AUDIT_CONVERSATION_BODY_LIMIT,
  AUDIT_CONVERSATION_CHUNK_LIMIT,
  matchAuditSessionContent,
  normalizeAuditConversationText,
} from './audit-conversation-text';
import { readAuditSessionTitles } from './audit-session-titles';
import { auditUsageCostSql } from './audit-usage-cost-sql';
import { resolveUsagePrices } from './audit-usage-default-prices';
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

const candidateSql = `WITH prices AS MATERIALIZED (
  SELECT json_extract(value,'$.model') model, json_extract(value,'$.inputPerMillion') input_rate,
    json_extract(value,'$.outputPerMillion') output_rate,
    json_extract(value,'$.cachedPerMillion') cached_rate
  FROM json_each(@prices)
), candidates AS (
  SELECT r.id, r.timestamp, r.session_id, r.protocol, a.account_id, a.model, a.id attempt_id,
    a.timing_json, a.duration_ms, ${observedAuditClient('r.request_headers')} client,
    r.completed_at, r.outcome,
    CASE WHEN r.completed_at<=@observedThrough AND
      (r.status>=400 OR r.outcome IN ('upstream_error','internal_error','timeout','auth_failed'))
      THEN 1 ELSE 0 END failed,
    EXISTS (SELECT 1 FROM upstream_attempts x WHERE x.parent_id=r.id AND x.timestamp<=@observedThrough
      AND (x.usage_scope='generation' OR x.usage_scope IS NULL) LIMIT 1 OFFSET 1) retried,
    a.input_tokens, a.output_tokens, a.cached_tokens, a.reasoning_tokens,
    CASE WHEN a.completed_at<=@observedThrough AND a.outcome<>'in_progress' AND a.response_partial=0
      THEN 1 ELSE 0 END terminal
  FROM request_logs r
  LEFT JOIN upstream_attempts a ON a.parent_id=r.id AND a.timestamp<=@observedThrough
    AND (a.usage_scope='generation' OR a.usage_scope IS NULL)
  WHERE r.traffic_class='model' AND r.timestamp BETWEEN @from AND @to
    AND (@accountId IS NULL OR a.account_id=@accountId)
    AND (@model IS NULL OR a.model=@model)
    AND (@sessionId IS NULL OR r.session_id=@sessionId)
    AND (@protocol IS NULL OR r.protocol=@protocol)
    AND (@client IS NULL OR ${observedAuditClient('r.request_headers')}=@client)
    AND (@finalAccount IS NULL OR r.attributed_account_id=@finalAccount)
    AND (@modelFamily IS NULL OR r.physical_model_family=@modelFamily)
    AND (@modality IS NULL
      OR (@modality='text' AND r.has_text_output=1)
      OR (@modality='image' AND r.has_image_output=1)
      OR (@modality='none' AND r.has_text_output=0 AND r.has_image_output=0)
      OR (@modality='unknown' AND r.has_text_output IS NULL AND r.has_image_output IS NULL))
    AND (@search IS NULL OR r.id LIKE @search OR r.url LIKE @search OR r.method LIKE @search
      OR r.protocol LIKE @search OR r.operation LIKE @search OR r.model LIKE @search
      OR r.mapped_model LIKE @search OR r.session_id LIKE @search OR r.username LIKE @search
      OR CAST(r.status AS TEXT) LIKE @search)
    AND CASE
      WHEN @statusMode='unfinished' THEN r.outcome='in_progress' AND r.completed_at IS NULL
      WHEN @statusMode='no-status' THEN r.status IS NULL
      WHEN @statusMode='exact' OR (@statusMode IS NULL AND @status IS NOT NULL) THEN r.status=@status
      WHEN @statusGroup IS NOT NULL THEN r.status>=@statusGroup AND r.status<@statusGroup+100
      ELSE 1 END
    AND (a.id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM upstream_attempts x WHERE x.parent_id=r.id AND x.timestamp<=@observedThrough
    ))
), selected AS (
  SELECT * FROM candidates WHERE CASE
    WHEN @usageState='failed' THEN failed
    WHEN @usageState='retried' THEN retried
    ELSE 1 END
), measured AS (
  SELECT *,
    CASE WHEN terminal=1 AND typeof(input_tokens)='integer'
      AND input_tokens BETWEEN 0 AND 9007199254740991 THEN input_tokens END input,
    CASE WHEN terminal=1 AND typeof(output_tokens)='integer'
      AND output_tokens BETWEEN 0 AND 9007199254740991 THEN output_tokens END output,
    CASE WHEN terminal=1 AND typeof(cached_tokens)='integer'
      AND cached_tokens BETWEEN 0 AND 9007199254740991 THEN cached_tokens END cache,
    CASE WHEN terminal=1 AND typeof(reasoning_tokens)='integer'
      AND reasoning_tokens BETWEEN 0 AND 9007199254740991 THEN reasoning_tokens END reasoning
  FROM selected
), priced AS (
  SELECT measured.*,
    ${auditUsageCostSql} cost
  FROM measured LEFT JOIN prices ON prices.model=measured.model
)`;

type Group = 'all' | 'accounts' | 'models' | 'sessions' | 'protocols' | 'clients';
const grouping = {
  all: 'NULL',
  accounts: 'CASE WHEN length(CAST(account_id AS BLOB)) BETWEEN 1 AND 256 THEN account_id END',
  models: 'CASE WHEN length(CAST(model AS BLOB)) BETWEEN 1 AND 256 THEN model END',
  sessions: 'CASE WHEN length(CAST(session_id AS BLOB)) BETWEEN 1 AND 512 THEN session_id END',
  protocols: 'CASE WHEN length(protocol) BETWEEN 1 AND 64 THEN protocol END',
  clients: 'client',
} satisfies Record<Group, string>;

function aggregate(key: string, withPricing: boolean, withSessionClient = false) {
  return `${candidateSql}, per_request AS (
    SELECT id, ${key} AS key, COUNT(attempt_id) attempts,
      MAX(retried) retried, MAX(failed) failed, MAX(input IS NULL OR output IS NULL) incomplete,
      SUM(COALESCE(input,0)) input, SUM(COALESCE(output,0)) output, MAX(input) peak_input,
      SUM(CASE WHEN cache<=input THEN cache ELSE 0 END) cache_read,
      SUM(CASE WHEN cache<=input THEN input ELSE 0 END) cache_input,
      SUM(CASE WHEN cache<=input THEN 1 ELSE 0 END) cache_measured,
      SUM(COALESCE(reasoning,0)) reasoning, COUNT(reasoning) reasoning_measured,
      SUM(COALESCE(cost,0)) cost, COUNT(cost) priced
      ${withSessionClient ? ', MAX(client) client' : ''}
    FROM priced GROUP BY id, key
  ) SELECT key, COUNT(*) requests, SUM(attempts) attempts,
    SUM(retried) retriedRequests, SUM(failed) failedRequests, SUM(incomplete) incompleteRequests,
    SUM(input) inputTokens, SUM(output) outputTokens, MAX(peak_input) peakInputTokens, SUM(cache_read) cacheReadTokens,
    SUM(cache_input) cacheInputTokens, SUM(cache_measured) cacheMeasuredAttempts,
    SUM(reasoning) reasoningTokens, SUM(reasoning_measured) reasoningMeasuredAttempts
    ${withPricing ? ', SUM(cost) estimatedCostUsd, SUM(priced) pricedAttempts' : ''}
    ${withSessionClient ? ', CASE WHEN MIN(client)=MAX(client) THEN MIN(client) END client' : ''}
  FROM per_request GROUP BY key`;
}

export function readUsageOverview(raw: Database.Database, input: UsageOverviewWorkerInput) {
  return raw.transaction(() => {
    const to = Math.min(input.to, input.asOf);
    const first =
      input.allRetained && input.from === 0
        ? raw
            .prepare(
              "SELECT MIN(timestamp) AS first FROM request_logs WHERE traffic_class='model' AND timestamp<=?",
            )
            .get(to)
        : undefined;
    const earliest = z
      .object({ first: z.number().int().nonnegative().safe().nullable() })
      .safeParse(first);
    const from = earliest.success ? (earliest.data.first ?? to) : input.from;
    const bucketDays = Math.max(1, Math.ceil((to - from) / (40 * 86_400_000)));
    const bucketMs = input.to - from <= 2 * 86_400_000 ? 3_600_000 : bucketDays * 86_400_000;
    const withPricing = input.prices !== undefined;
    const filters = input.requestFilters;
    const params = {
      from,
      to,
      observedThrough: Math.min(input.observedThrough ?? to, input.asOf),
      accountId: input.accountId ?? null,
      model: input.model ?? null,
      sessionId: input.sessionId ?? null,
      protocol: input.protocol ?? null,
      client: input.client ?? null,
      finalAccount: filters?.accountId ?? null,
      modelFamily: filters?.modelFamily ?? null,
      modality: filters?.modality ?? null,
      search: filters?.search ? `%${filters.search}%` : null,
      statusMode: filters?.statusMode ?? null,
      status: filters?.status ?? null,
      statusGroup:
        filters?.statusMode && /^[1-5]xx$/u.test(filters.statusMode)
          ? Number(filters.statusMode[0]) * 100
          : null,
      usageState: filters?.usageState ?? null,
      limit: USAGE_OVERVIEW_LIMIT + 1,
      prices: JSON.stringify(input.prices ? resolveUsagePrices(input.prices, input.asOf) : []),
      sessionOffset: input.sessionOffset ?? 0,
      activityFrom: Math.max(from, to - 31 * 86_400_000),
      currentTime: input.asOf,
    };
    const [total] = z
      .array(UsageOverviewResultSchema.shape.totals.extend({ key: z.null() }))
      .parse(raw.prepare(aggregate(grouping.all, withPricing)).all(params));
    const { key: _key, ...totals } = total ?? { key: null, ...empty };
    const needle =
      input.sessionSearch && normalizeAuditConversationText(input.sessionSearch).toLowerCase();
    const matchedSessions = needle
      ? matchAuditSessionContent(
          raw,
          raw
            .prepare(
              `${candidateSql}, scoped_requests AS (
            SELECT DISTINCT id, session_id FROM selected
            WHERE length(CAST(session_id AS BLOB)) BETWEEN 1 AND 512
          )
          SELECT r.session_id sessionId, ref.direction, p.id,
            p.stored_bytes storedBytes, p.chunk_count chunkCount
          FROM scoped_requests r JOIN request_body_refs ref ON ref.request_id=r.id
          JOIN audit_payloads p ON p.id=ref.payload_id AND p.request_id=r.id
          WHERE p.completed_at<=@observedThrough AND p.state='complete' AND p.partial=0 AND p.oversized=0
            AND ref.direction IN ('request','response')
            AND p.stored_bytes BETWEEN 1 AND @bodyLimit AND p.chunk_count BETWEEN 1 AND @chunkLimit
            AND ((p.kind='json' AND p.representation='sanitized_json')
              OR (ref.direction='response' AND p.representation='reconstructed_sse'))
          `,
            )
            .iterate({
              ...params,
              bodyLimit: AUDIT_CONVERSATION_BODY_LIMIT,
              chunkLimit: AUDIT_CONVERSATION_CHUNK_LIMIT,
            }),
          needle,
        )
      : undefined;
    const ranked = (group: Exclude<Group, 'all'>) => {
      const sessionFilter =
        group === 'sessions'
          ? `WHERE key IS NOT NULL${matchedSessions ? ' AND key IN (SELECT value FROM json_each(@matchedSessions))' : ''}`
          : '';
      const offset = group === 'sessions' ? 'OFFSET @sessionOffset' : '';
      const schema =
        group === 'clients' || group === 'protocols'
          ? UsageAnalyticsSchema.shape[group]
          : UsageOverviewResultSchema.shape[group];
      const rank = {
        tokens: 'inputTokens + outputTokens DESC, requests DESC, key',
        requests: 'requests DESC, inputTokens + outputTokens DESC, key',
        cost: withPricing ? 'estimatedCostUsd DESC, pricedAttempts DESC, key' : 'key',
        name: 'key IS NULL, key COLLATE NOCASE, key',
      }[input.sort ?? 'tokens'];
      const rows = schema.shape.rows.element.array().parse(
        raw
          .prepare(
            `SELECT * FROM (${aggregate(grouping[group], withPricing, group === 'sessions')}) ${sessionFilter}
          ORDER BY ${rank} LIMIT @limit ${offset}`,
          )
          .all(
            group === 'sessions' && matchedSessions
              ? { ...params, matchedSessions: JSON.stringify(matchedSessions) }
              : params,
          ),
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
    const boundaries = starts.slice(1).map((start, index) => ({ start, name: `bucket${index}` }));
    const bucketKey = boundaries.length
      ? `CASE ${boundaries.map(({ name }, index) => `WHEN timestamp<@${name} THEN ${index}`).join(' ')}
          ELSE ${boundaries.length} END`
      : '0';
    const bucketParams = {
      ...params,
      ...Object.fromEntries(boundaries.map(({ start, name }) => [name, start])),
    };
    const rows = z
      .array(UsageOverviewResultSchema.shape.totals.extend({ key: z.number().int().nonnegative() }))
      .parse(raw.prepare(`${aggregate(bucketKey, withPricing)} ORDER BY key`).all(bucketParams));
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
      const titles = readAuditSessionTitles(raw, keys, params.observedThrough);
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
        series: readSeries(raw, grouping[input.seriesGroup], bucketKey, starts, bucketParams),
      }),
      ...(input.includeAnalytics && {
        analytics: {
          protocols: ranked('protocols'),
          clients: ranked('clients'),
          ...readAnalytics(raw, bucketParams, bucketKey, starts),
        },
      }),
    });
  })();
}

function readSeries(
  raw: Database.Database,
  group: string,
  bucket: string,
  starts: number[],
  params: object,
) {
  const shape = UsageOverviewResultSchema.shape.series.unwrap().element.shape.points.element;
  const schema = shape
    .omit({ timestamp: true })
    .extend({
      key: z.string().max(256).nullable(),
      bucket: z.number().int().min(0).max(48),
    })
    .array();
  const rows = schema.parse(
    raw
      .prepare(
        `${candidateSql}, amounts AS (
    SELECT id,${group} key,${bucket} bucket,
      COALESCE(input,0) input,COALESCE(output,0) output FROM measured
  ), leaders AS (
    SELECT key,SUM(input+output) tokens, COUNT(DISTINCT id) requests FROM amounts
    GROUP BY key ORDER BY tokens DESC,requests DESC,key LIMIT 6
  )
  SELECT amounts.key,bucket,COUNT(DISTINCT id) requests,SUM(input) inputTokens,SUM(output) outputTokens
  FROM amounts JOIN leaders ON amounts.key IS leaders.key
  GROUP BY amounts.key,bucket
  ORDER BY leaders.tokens DESC,leaders.requests DESC,amounts.key,bucket`,
      )
      .all(params),
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

const rateSql = `(1000.0*SUM(decoded))/SUM(elapsed)`;

function knownTimingValue(
  field: 'firstUsableOutputMs' | 'uploadedBodyBytes' | 'downloadedBodyBytes',
) {
  return `CASE WHEN json_valid(timing_json) THEN
    CASE WHEN json_extract(timing_json,'$.version')=1
      AND json_type(timing_json,'$.${field}')='integer'
      AND json_extract(timing_json,'$.${field}') BETWEEN 0 AND 9007199254740991
      THEN json_extract(timing_json,'$.${field}') END END`;
}

// Timing v1 stores elapsed milliseconds from the physical send, never wall-clock timestamps.
const ratesSql = `, timings AS (
    SELECT timestamp, model, output, duration_ms,
      ${knownTimingValue('uploadedBodyBytes')} upload,
      ${knownTimingValue('downloadedBodyBytes')} download,
      CASE WHEN terminal=1 THEN ${knownTimingValue('firstUsableOutputMs')} END first_observed
    FROM measured
  ), rates AS (
    SELECT *, CASE WHEN first_observed<=duration_ms THEN first_observed END first_output,
      CASE WHEN output>0 AND duration_ms>first_observed THEN output END decoded,
      CASE WHEN output>0 AND duration_ms>first_observed THEN duration_ms-first_observed END elapsed
    FROM timings
  )`;

function readAnalytics(
  raw: Database.Database,
  params: { limit: number; from: number; to: number; currentTime: number },
  bucket: string,
  starts: number[],
) {
  const speed = raw
    .prepare(
      `${candidateSql}${ratesSql}
  SELECT CASE WHEN length(CAST(model AS BLOB)) BETWEEN 1 AND 256 THEN model END key,
    COUNT(first_output) firstOutputAttempts, AVG(first_output) meanFirstOutputMs,
    COUNT(decoded) decodeAttempts, ${rateSql} outputTokensPerSecond
  FROM rates GROUP BY key HAVING COUNT(first_output)>0
  ORDER BY firstOutputAttempts DESC,key LIMIT @limit`,
    )
    .all({ ...params, limit: USAGE_OVERVIEW_LIMIT });

  const activity = raw
    .prepare(
      `${candidateSql}, parents AS (
    SELECT DISTINCT id,timestamp FROM selected WHERE timestamp>=@activityFrom
  ), hours AS (
    SELECT timestamp,
      CAST(strftime('%H',timestamp/1000,'unixepoch','localtime') AS INTEGER) hour,
      unixepoch(date(timestamp/1000,'unixepoch','localtime'),'utc')*1000 day
    FROM parents
  )
  SELECT day,hour,COUNT(*) requests FROM hours WHERE day>=0 AND hour IS NOT NULL
  GROUP BY day,hour ORDER BY day,hour LIMIT 1176`,
    )
    .all(params);

  // These are the sizes of complete retained representations. Uncaptured bodies are absent.
  const capture = raw
    .prepare(
      `${candidateSql}, parents AS (
    SELECT DISTINCT id FROM selected
  ), bodies AS (
    SELECT refs.direction, payload.stored_bytes
    FROM parents JOIN request_body_refs refs ON refs.request_id=parents.id
    JOIN audit_payloads payload ON payload.id=refs.payload_id
    WHERE payload.state='complete' AND payload.partial=0
  )
  SELECT (SELECT COUNT(*) FROM parents) requests,
    COALESCE(SUM(CASE WHEN direction='request' THEN stored_bytes END),0) requestBytes,
    COALESCE(SUM(CASE WHEN direction='response' THEN stored_bytes END),0) responseBytes,
    COUNT(CASE WHEN direction='request' THEN 1 END) requestBodies,
    COUNT(CASE WHEN direction='response' THEN 1 END) responseBodies
  FROM bodies`,
    )
    .get(params);
  const transport = raw
    .prepare(
      `${candidateSql}${ratesSql}
  SELECT COALESCE(SUM(upload),0) uploadBytes, COALESCE(SUM(download),0) downloadBytes,
    COUNT(upload) uploadSamples, COUNT(download) downloadSamples FROM rates`,
    )
    .get(params);
  const live =
    params.to === params.currentTime
      ? raw
          .prepare(
            `${candidateSql}, parents AS (
    SELECT DISTINCT id,timestamp,completed_at,outcome FROM selected
  )
  SELECT @to asOf,
    COUNT(CASE WHEN outcome='in_progress' AND completed_at IS NULL THEN 1 END) inFlight,
    COUNT(CASE WHEN timestamp>=@to-60000 THEN 1 END) startedLastMinute
  FROM parents`,
          )
          .get(params)
      : undefined;
  const samples = UsageAnalyticsSchema.shape.trend
    .unwrap()
    .element.omit({ timestamp: true })
    .extend({ bucket: z.number().int().min(0).max(48) })
    .array()
    .parse(
      raw
        .prepare(
          `${candidateSql}${ratesSql}
        SELECT ${bucket} bucket, SUM(upload) uploadBytes, SUM(download) downloadBytes,
          ${rateSql} outputTokensPerSecond FROM rates GROUP BY bucket ORDER BY bucket`,
        )
        .all(params),
    );
  const trend = samples.flatMap(({ bucket: index, ...value }) => {
    const timestamp = starts[index];
    return timestamp === undefined ? [] : [{ timestamp, ...value }];
  });
  return { speed, activity, capture, transport, live, trend };
}
