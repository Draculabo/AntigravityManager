import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrafficAuditRepository } from '@/modules/proxy-gateway/audit/traffic-audit.repository';
import { UsageActivityDaysSchema, UsageTrendsResultSchema } from '@/modules/proxy-gateway/audit/usage-trends.schema';
import { AuditSessionOptionsResultSchema, type AuditSessionOptionsResult } from '@/modules/proxy-gateway/audit/audit-session-options.schema';
import {
  UsageOverviewInputSchema,
  UsageOverviewResultSchema,
  type UsageOverviewInput,
} from '@/modules/proxy-gateway/audit/usage-overview.schema';
import {
  UsageRangeInputSchema,
  UsageRangeResultSchema,
} from '@/modules/proxy-gateway/audit/usage-range.schema';

vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});

let directory: string;
let repository: TrafficAuditRepository;
let raw: Database.Database;
let sequence = 0;
const from = 1000,
  to = 2000,
  asOf = 1800;
const range = { accountId: 'account-a', modelIds: ['claude-sonnet', 'gpt-model'], from, to };
const identity = {
  accountGenerationHash: 'a'.repeat(64),
  accountSubjectHash: null,
  accountGrantHash: 'b'.repeat(64),
};
const empty = {
  ...range,
  asOf,
  coverage: 'retained-local-records',
  accountIdentity: 'current-account-incarnation',
  timeBasis: 'attempt-start',
  ambiguousTimeBasis: 'attempt-start-or-unattributed-request-start',
  recordedRequests: 0,
  countedRequests: 0,
  ambiguousRequests: 0,
  missingUsageRequests: 0,
  missingCachedRequests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
};
interface Row {
  timestamp?: number;
  accountId?: string;
  model?: string;
  trafficClass?: string;
  input?: number | null;
  output?: number | null;
  cached?: number | null;
  outcome?: string;
  completedAt?: number | null;
  attempts?: Array<{ accountId: string | null; model: string | null; completedAt?: number | null }>;
}
function insert(row: Row = {}) {
  const id = `parent-${++sequence}`;
  const accountId = row.accountId ?? range.accountId,
    model = row.model ?? range.modelIds[0];
  raw
    .prepare(
      `INSERT INTO request_logs(id,timestamp,completed_at,method,url,protocol,traffic_class,
    request_headers,outcome,attributed_account_id,physical_model,input_tokens,output_tokens,cached_tokens)
    VALUES(?,?,?,'POST','/v1/messages','anthropic',?,'{}',?,?,?,?,?,?)`,
    )
    .run(
      id,
      row.timestamp ?? 1500,
      row.completedAt === undefined ? 1600 : row.completedAt,
      row.trafficClass ?? 'model',
      row.outcome ?? 'completed',
      accountId,
      model,
      row.input === undefined ? 100 : row.input,
      row.output === undefined ? 20 : row.output,
      row.cached === undefined ? 60 : row.cached,
    );
  const attempts = row.attempts ?? [{ accountId, model }];
  for (const [index, attempt] of attempts.entries()) {
    raw
      .prepare(
        `INSERT INTO upstream_attempts(id,parent_id,attempt_index,timestamp,completed_at,
      endpoint,operation,account_id,model,request_headers,outcome,account_generation_hash,
      account_grant_hash,usage_scope,input_tokens,output_tokens,cached_tokens)
      VALUES(?,?,?,?,?,'https://example.test','generate',?,?,'{}',?,?,?,?,?,?,?)`,
      )
      .run(
        `${id}-${index}`,
        id,
        index + 1,
        row.timestamp ?? 1500,
        attempt.completedAt === undefined
          ? row.completedAt === undefined
            ? Math.max(1600, row.timestamp ?? 1500)
            : row.completedAt
          : attempt.completedAt,
        attempt.accountId,
        attempt.model,
        row.outcome ?? 'completed',
        attempt.accountId === null ? null : identity.accountGenerationHash,
        attempt.accountId === null ? null : identity.accountGrantHash,
        row.trafficClass === 'auxiliary' ? null : 'generation',
        row.input === undefined ? 100 : row.input,
        row.output === undefined ? 20 : row.output,
        row.cached === undefined ? 60 : row.cached,
      );
  }
  return id;
}
function read(input = range) {
  return repository.execute({
    operation: 'usageRange',
    payload: { range: input, asOf, ...identity },
  });
}

it('labels saved session groups only when the retained requests identify one client', () => {
  const known = `session:store:v2:0123456789ab${'c'.repeat(52)}`;
  const mixed = `session:affinity:v1:abcdef012345${'6'.repeat(52)}`;
  const unknown = 'older-session';
  const update = raw.prepare('UPDATE request_logs SET session_id=?, request_headers=? WHERE id=?');
  for (const [key, agent] of [
    [known, 'codex_cli_rs/1.0'],
    [known, 'unrecognized-agent'],
    [mixed, 'claude-code/1.0'],
    [mixed, 'codex_cli_rs/1.0'],
    [unknown, 'unrecognized-agent'],
  ]) {
    update.run(key, JSON.stringify({ 'user-agent': agent }), insert());
  }
  const overview = () => UsageOverviewResultSchema.parse(repository.execute({
    operation: 'usageOverview', payload: { from, to, asOf },
  }));
  expect(overview().sessions.rows.map(({ key, client, requests }) => ({ key, client, requests }))).toEqual([
    { key: mixed, client: null, requests: 2 },
    { key: known, client: 'codex', requests: 2 },
    { key: unknown, client: null, requests: 1 },
  ]);
});

it('uses a bounded first user prompt from the exact saved session only in its paged listing', () => {
  const sessionId = `session:store:v2:${'a'.repeat(64)}`;
  const otherSession = `session:store:v2:${'b'.repeat(64)}`;
  const sessionRow = raw.prepare('UPDATE request_logs SET session_id=? WHERE id=?');
  const saveBody = (
    key: string, timestamp: number, body: string, state = 'complete',
    direction: 'request' | 'response' = 'request', accountId?: string,
  ) => {
    const requestId = insert({ timestamp, accountId });
    sessionRow.run(key, requestId);
    const payloadId = `payload-${requestId}`;
    const bytes = Buffer.from(body);
    raw.prepare(`INSERT INTO audit_payloads
      (id, request_id, kind, representation, state, stored_bytes, chunk_count, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?)`)
      .run(payloadId, requestId, direction === 'response' ? 'sse' : 'json',
        direction === 'response' ? 'reconstructed_sse' : 'sanitized_json', state, bytes.length, timestamp, timestamp);
    raw.prepare('INSERT INTO request_body_refs VALUES (?, ?, ?)').run(requestId, direction, payloadId);
    const chunk = raw.prepare('INSERT INTO audit_payload_chunks (payload_id,seq,payload,byte_length) VALUES (?,?,?,?)');
    const split = bytes.indexOf(Buffer.from('分析')) + 1;
    chunk.run(payloadId, 0, bytes.subarray(0, split), split);
    chunk.run(payloadId, 1, bytes.subarray(split), bytes.length - split);
  };
  saveBody(sessionId, 1100, JSON.stringify({ input: 'Expired title' }), 'expired');
  saveBody(otherSession, 1150, JSON.stringify({ request: { contents: [
    { role: 'model', parts: [{ text: 'Model text must not appear' }] },
    { role: 'user', parts: [{ text: 'Check token=synthetic-secret' }] },
  ] } }));
  saveBody(sessionId, 1200, JSON.stringify({ input: [
    { role: 'developer', content: 'System setup must not appear' },
    { role: 'user', content: [{ type: 'input_text', text: '  分析桌面端\n布线与预览链路  ' }] },
    { role: 'user', content: 'Later turn must not appear' },
  ] }));
  saveBody(sessionId, 1500, JSON.stringify({ input: 'Latest request is not the title' }));
  saveBody(sessionId, 1510, JSON.stringify({ input: `${'x'.repeat(140 * 1024)} Long body marker` }));
  saveBody(sessionId, 1520, JSON.stringify({ response: { output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Check the preview\nconnection 修复' }] },
    { type: 'reasoning', content: [{ type: 'output_text', text: 'Hidden reasoning' }] },
  ] } }), 'complete', 'response', 'account-b');
  const readSession = (sessionOffset?: number) => repository.execute({
    operation: 'usageOverview', payload: { from: 1400, to, asOf, sessionOffset },
  });
  expect(readSession(0)).toMatchObject({ sessions: { rows: [
    { key: sessionId, title: '分析桌面端 布线与预览链路' },
  ] } });
  expect(UsageOverviewResultSchema.parse(readSession()).sessions.rows[0]).not.toHaveProperty('title');
  const other = repository.execute({
    operation: 'usageOverview', payload: { from, to, asOf, sessionId: otherSession, sessionOffset: 0 },
  });
  expect(other).toMatchObject({ sessions: { rows: [
    { key: otherSession, title: 'Check token=[REDACTED]' },
  ] } });

  for (let index = 0; index < 30; index++) {
    sessionRow.run(`more-recent-${index}`, insert({ timestamp: 1700 }));
  }
  const searchContent = (sessionSearch: string, filters: Partial<UsageOverviewInput> = {}) =>
    UsageOverviewResultSchema.parse(repository.execute({
      operation: 'usageOverview',
      payload: { from: 1000, to, asOf, sessionOffset: 0, sessionSearch, sort: 'name', ...filters },
    })).sessions.rows.map(({ key }) => key);
  expect(searchContent('LATEST request')).toEqual([sessionId]);
  expect(searchContent('long body marker')).toEqual([sessionId]);
  expect(searchContent('Later turn')).toEqual([sessionId]);
  expect(searchContent('分析桌面端 布线')).toEqual([sessionId]);
  expect(searchContent('preview connection 修复')).toEqual([sessionId]);
  expect(searchContent('preview connection 修复', { accountId: 'account-b' })).toEqual([sessionId]);
  expect(searchContent('preview connection 修复', { accountId: range.accountId })).toEqual([]);
  expect(searchContent('Later turn', { from: 1400 })).toEqual([]);
  for (const excluded of [sessionId, 'Expired title', 'System setup', 'Hidden reasoning', 'synthetic-secret']) {
    expect(searchContent(excluded)).toEqual([]);
  }
  const search = (cursor?: AuditSessionOptionsResult['next']) =>
    AuditSessionOptionsResultSchema.parse(repository.execute({
      operation: 'sessionOptions', payload: { kind: 'search', asOf, text: '预览', cursor },
    }));
  const first = search();
  expect(first.rows).toEqual([]);
  expect(first.next).toMatchObject({ lastSeen: 1700, through: asOf });
  const second = search(first.next);
  expect(second.rows).toEqual([{
    sessionId, lastSeen: 1520, title: '分析桌面端 布线与预览链路',
  }]);
  expect(second.next).toBeUndefined();
  expect(repository.execute({
    operation: 'sessionOptions', payload: { kind: 'selected', asOf, sessionId },
  })).toEqual(second);
});

it('ties overview totals and exact drill-down to the same retained generation attempts', () => {
  const retried = insert({
    accountId: 'account-b',
    attempts: [
      { accountId: 'account-a', model: 'original' },
      { accountId: 'account-b', model: 'fallback' },
    ],
  });
  raw.prepare('UPDATE request_logs SET session_id=? WHERE id=?').run('scope:session', retried);
  raw.prepare('UPDATE upstream_attempts SET output_tokens=?, cached_tokens=?, reasoning_tokens=?, timestamp=? WHERE id=?')
    .run(30, null, 7, 1550, `${retried}-1`);
  const partial = insert({
    accountId: 'account-a',
    model: 'original',
    completedAt: null,
  });
  const failed = insert({ accountId: 'account-a', model: 'original', outcome: 'timeout' });
  const helper = insert();
  raw.prepare("UPDATE upstream_attempts SET usage_scope='non-generation' WHERE parent_id=?").run(helper);
  insert({ trafficClass: 'auxiliary' });
  insert({ timestamp: asOf + 1 });

  const input = { from, to };
  const overview = (filters: Partial<UsageOverviewInput> = {}) => UsageOverviewResultSchema.parse(repository.execute({
    operation: 'usageOverview',
    payload: { ...input, asOf, ...filters },
  }));
  const result = overview();
  expect(result.to).toBe(asOf);
  expect(result.totals).toEqual({
    requests: 3, attempts: 4, retriedRequests: 1, failedRequests: 1, incompleteRequests: 1,
    inputTokens: 300, peakInputTokens: 100, outputTokens: 70, cacheReadTokens: 120, cacheInputTokens: 200,
    cacheMeasuredAttempts: 2, reasoningTokens: 7, reasoningMeasuredAttempts: 1,
  });
  expect(result.buckets).toEqual([{ timestamp: from, ...result.totals }]);
  expect(result.accounts.rows.map(({ key, attempts }) => ({ key, attempts }))).toEqual([
    { key: 'account-a', attempts: 3 }, { key: 'account-b', attempts: 1 },
  ]);
  expect(result.sessions.rows.find(({ key }) => key === 'scope:session')?.attempts).toBe(2);
  expect(result.sessions.rows.map(({ key }) => key)).toEqual(['scope:session']);
  expect(overview({ sessionOffset: 1 }).sessions.rows).toEqual([]);
  expect(overview({ accountId: 'account-a', model: 'fallback' }).totals.requests).toBe(0);
  const priced = overview({ prices: [
    { model: 'original', inputPerMillion: 2, outputPerMillion: 10, cachedPerMillion: 0.5 },
    { model: 'fallback', inputPerMillion: 1, outputPerMillion: 2, cachedPerMillion: 0.1 },
  ] });
  expect(priced.totals.pricedAttempts).toBe(3);
  expect(priced.totals.estimatedCostUsd).toBeCloseTo(0.00078, 10);

  const list = (attemptModel: string, sessionId?: string) => repository.execute({
    operation: 'list',
    payload: { from, to: result.to, limit: 20, offset: 0, trafficClass: 'model', attemptAccountId: 'account-a', attemptModel, sessionId },
  });
  expect(list('fallback')).toMatchObject({ total: 0, items: [] });
  expect(list('original', 'scope:session')).toMatchObject({ total: 1, items: [{ id: retried }] });
  expect(list('original')).toMatchObject({
    total: 3, items: expect.arrayContaining([{ id: retried }, { id: partial }, { id: failed }].map((row) => expect.objectContaining(row))),
  });
  expect(repository.execute({
    operation: 'list',
    payload: {
      from, to: 1500, usageAsOf: result.to, usageState: 'retried',
      limit: 20, offset: 0, trafficClass: 'model', attemptModel: 'fallback',
    },
  })).toMatchObject({ total: 1, items: [{ id: retried }] });
  expect(repository.execute({
    operation: 'list',
    payload: { from, to, usageAsOf: result.to, usageState: 'failed', limit: 20, offset: 0, trafficClass: 'model' },
  })).toMatchObject({ total: 1, items: [{ id: failed }] });
});

it('estimates the same default prices in Overview and Requests and honors exact overrides', () => {
  const now = new Date(2026, 10, 25, 12).getTime();
  const model = 'gemini-3.8-flash-high';
  insert({ timestamp: now - 2000, completedAt: now - 1000, model });
  insert({ timestamp: now - 2000, completedAt: now - 1000, model, cached: null });
  insert({ timestamp: now - 2000, completedAt: now - 1000, model, cached: 101 });
  insert({ timestamp: now - 2000, completedAt: now - 1000, model, cached: -1 });
  insert({ timestamp: now - 2000, completedAt: now - 1000, model, output: null });
  insert({ timestamp: now - 2000, completedAt: now - 1000, model: `${model}-unknown` });
  insert({ timestamp: now - 2000, completedAt: now - 1000, model: 'gemini-3.1-flash-image' });
  const from = now - 3600000;
  const overview = (asOf: number, prices: UsageOverviewInput['prices']) =>
    UsageOverviewResultSchema.parse(repository.execute({
      operation: 'usageOverview', payload: { from, to: now, asOf, prices },
    })).totals;
  const heatmap = (prices?: UsageOverviewInput['prices']) =>
    UsageActivityDaysSchema.parse(repository.execute({
      operation: 'usageActivity', payload: { filters: { from, to: now }, asOf: now, prices },
    })).at(-1);
  expect(overview(now, []).pricedAttempts).toBe(2);
  expect(overview(now, []).estimatedCostUsd).toBeCloseTo(0.0002595, 10);
  expect(heatmap()).toMatchObject({ requests: 7, pricedAttempts: 2 });
  expect(heatmap()?.estimatedCostUsd).toBeCloseTo(0.0002595, 10);
  const overrides = [{ model, inputPerMillion: 0, outputPerMillion: 1, cachedPerMillion: 0 }];
  expect(overview(now, overrides).pricedAttempts).toBe(4);
  expect(overview(now, overrides).estimatedCostUsd).toBeCloseTo(0.00008, 10);
  expect(heatmap(overrides)?.estimatedCostUsd).toBeCloseTo(0.00008, 10);
  expect(overview(Date.UTC(2027, 0, 1), []).estimatedCostUsd).toBeCloseTo(0.000519, 10);
});

it('rejects reversed and unbounded overview ranges at the owner boundary', () => {
  expect(UsageOverviewInputSchema.safeParse({ from: 2000, to: 1000 }).success).toBe(false);
  expect(UsageOverviewInputSchema.safeParse({ from: 0, to: 90 * 86_400_000 }).success).toBe(false);
});

it('reports duration and activity once per correct scope and handles all retained dates', () => {
  const started = new Date(2026, 10, 24, 10, 15).getTime();
  const close = started + 300;
  const id = insert({
    timestamp: started,
    completedAt: close,
    accountId: 'account-a',
    model: 'model-one',
    input: 100,
    output: 20,
  });
  raw.prepare('UPDATE request_logs SET request_headers=? WHERE id=?')
    .run(JSON.stringify({ 'user-agent': 'codex_cli_rs/1.0' }), id);
  raw.prepare('UPDATE upstream_attempts SET timing_json=?,duration_ms=? WHERE parent_id=?')
    .run(JSON.stringify({
      version: 1, firstUsableOutputMs: 100, firstByteMs: 90, uploadFinishedMs: 40, responseHeadersMs: 80,
      uploadedBodyBytes: 20, downloadedBodyBytes: 40,
    }), 300, id);
  insert({ timestamp: new Date(2025, 2, 1, 10).getTime(), model: 'archived-model' });

  const overview = (filters: Partial<UsageOverviewInput>) => UsageOverviewResultSchema.parse(repository.execute({
    operation: 'usageOverview',
    payload: { from: started - 1000, to: started + 2000, asOf: started + 1000, includeAnalytics: true, ...filters },
  }));
  const current = overview({ client: 'codex', protocol: 'anthropic', seriesGroup: 'clients' });
  expect(current.series).toEqual([{
    key: 'codex', points: [{ timestamp: started - 1000, requests: 1, inputTokens: 100, outputTokens: 20 }],
  }]);
  expect(current.analytics).toMatchObject({
    speed: [{ key: 'model-one', firstOutputAttempts: 1, meanFirstOutputMs: 100, decodeAttempts: 1, outputTokensPerSecond: 100 }],
    activity: [{ day: new Date(2026, 10, 24).getTime(), hour: 10, requests: 1 }],
    live: { asOf: started + 1000, inFlight: 0, startedLastMinute: 1 },
    capture: { requests: 1, requestBytes: 0, responseBytes: 0, requestBodies: 0, responseBodies: 0 },
    transport: { uploadBytes: 20, downloadBytes: 40, uploadSamples: 1, downloadSamples: 1 },
    trend: [{ timestamp: started - 1000, uploadBytes: 20, downloadBytes: 40, outputTokensPerSecond: 100 }],
    clients: { rows: [{ key: 'codex', requests: 1 }] },
  });
  expect(repository.execute({
    operation: 'list', payload: { client: 'codex', protocol: 'anthropic', limit: 20, offset: 0 },
  })).toMatchObject({ total: 1, items: [{ id }] });
  expect(overview({ client: 'claude-code' }).totals.requests).toBe(0);
  const all = overview({ from: 0, allRetained: true });
  expect(all.totals.requests).toBe(2);
  expect(all.buckets.length).toBeLessThanOrEqual(49);
  expect(all.analytics?.activity).toHaveLength(1);
});

it('groups usage by model family before limiting variants and counts sibling retries once', () => {
  const model = (suffix: string) => `gemini-4-argon-${suffix}`;
  const retried = insert({
    attempts: [
      { model: model('low'), accountId: 'account-a' },
      { model: model('high'), accountId: 'account-a' },
    ],
  });
  raw.prepare('UPDATE request_logs SET model=? WHERE id=?').run('preferred-model', retried);
  for (let variant = 0; variant < 50; variant += 1) {
    insert({ model: model(String(variant)) });
  }

  const trends = (modelView: 'requested' | 'actual') =>
    UsageTrendsResultSchema.parse(
      repository.execute({
        operation: 'usageTrends',
        payload: { window: '1h', modelView, asOf },
      }),
    );

  expect(trends('actual')).toMatchObject({
    modelFamilies: [
      {
        family: 'gemini-4-argon',
        requests: 51,
        attempts: 52,
        totalTokens: 6240,
        variants: expect.arrayContaining([
          expect.objectContaining({ model: model('0'), requests: 1, attempts: 1, totalTokens: 120 }),
        ]),
        variantsTruncated: true,
      },
    ],
  });
  expect(trends('requested')).toMatchObject({
    modelFamilies: expect.arrayContaining([
      expect.objectContaining({ family: 'preferred-model', requests: 1, attempts: 2 }),
    ]),
  });
});

it('bounds variant details across a 24-hour response while keeping every family total', () => {
  for (let family = 0; family < 50; family += 1) {
    for (let variant = 0; variant < 6; variant += 1) {
      const model = `claude-sonnet-${family}-0-${variant}`.padEnd(256, '\u0001');
      insert({ timestamp: 86400000, model });
    }
  }

  const trends = UsageTrendsResultSchema.parse(repository.execute({
    operation: 'usageTrends',
    payload: { window: '24h', modelView: 'actual', asOf: 86400000, includeActivity: true },
  }));

  expect(trends.modelFamilies).toHaveLength(50);
  expect(trends.modelFamilies.every((family) => family.attempts === 6)).toBe(true);
  expect(trends.modelFamilies.every((family) => family.variants.length > 0)).toBe(true);
  expect(trends.modelFamilies.some((family) => family.variantsTruncated)).toBe(true);
  expect(trends.modelFamilies.flatMap((family) => family.variants)).toHaveLength(256);
  expect(Buffer.byteLength(JSON.stringify(trends))).toBeLessThan(1024 * 1024);
});

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-cycle-usage-'));
  const file = path.join(directory, 'audit.db');
  repository = new TrafficAuditRepository(file);
  raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  sequence = 0;
});
afterEach(() => {
  raw?.close();
  repository?.execute({ operation: 'shutdown', payload: null });
  fs.rmSync(directory, { recursive: true, force: true });
});

it('counts distinct retained requests by local start day with the selected account and model', () => {
  const asOf = new Date(2026, 2, 9, 12).getTime();
  const firstDay = new Date(2025, 2, 10).getTime();
  const midnight = new Date(2026, 2, 9).getTime();
  const model = 'claude-sonnet';
  insert({ timestamp: firstDay - 1 });
  insert({ timestamp: firstDay });
  const retried = insert({
    timestamp: midnight - 1,
    attempts: [
      { accountId: 'account-a', model },
      { accountId: 'account-a', model },
      { accountId: 'account-b', model },
    ],
  });
  raw.prepare('UPDATE upstream_attempts SET timestamp=? WHERE id=?').run(midnight, `${retried}-1`);
  const nextDay = insert({ timestamp: midnight });
  raw.prepare('UPDATE request_logs SET model=? WHERE id=?').run('client-alias', nextDay);
  insert({ timestamp: midnight, model: 'claude-sonnet-other' });
  insert({ timestamp: midnight, accountId: 'account-b' });
  insert({ timestamp: midnight, trafficClass: 'auxiliary' });
  insert({ timestamp: midnight, attempts: [] });
  insert({ timestamp: asOf + 1 });
  insert({ timestamp: asOf });

  const payload = {
    window: '1h',
    modelView: 'actual',
    accountId: 'account-a',
    model,
    asOf,
  } as const;
  const collapsed = UsageTrendsResultSchema.parse(
    repository.execute({ operation: 'usageTrends', payload }),
  );
  const { activity, ...expanded } = UsageTrendsResultSchema.parse(
    repository.execute({
      operation: 'usageTrends',
      payload: { ...payload, includeActivity: true, prices: [{ model, inputPerMillion: 10, outputPerMillion: 20, cachedPerMillion: 5 }] },
    }),
  );
  expect(collapsed).not.toHaveProperty('activity');
  expect(expanded).toEqual(collapsed);
  expect(expanded.totals.requests).toBe(1);
  expect(activity).toHaveLength(365);
  expect(activity?.[0]).toMatchObject({ date: '2025-03-10', requests: 1, observedTokens: 120, pricedAttempts: 1, estimatedCostUsd: 0.0011 });
  expect(activity?.[1]).toMatchObject({ date: '2025-03-11', requests: 0, observedTokens: null, estimatedCostUsd: null });
  expect(activity?.slice(-2)).toMatchObject([
    { date: '2026-03-08', requests: 1, attempts: 2, observedTokens: 240, pricedAttempts: 2, estimatedCostUsd: 0.0022 },
    { date: '2026-03-09', requests: 2 },
  ]);
  expect(activity?.reduce((total, day) => total + day.requests, 0)).toBe(4);

  const requested = UsageTrendsResultSchema.parse(
    repository.execute({
      operation: 'usageTrends',
      payload: { ...payload, modelView: 'requested', model: 'client-alias', includeActivity: true },
    }),
  );
  expect(requested.activity?.filter(({ requests }) => requests > 0)).toMatchObject([
    { date: '2026-03-09', requests: 1 },
  ]);
});

it('uses the request list predicate for daily activity and prices only scoped attempts', () => {
  const day = new Date(2026, 2, 9, 12).getTime();
  const first = insert({
    timestamp: day - 4000,
    completedAt: day - 1000,
    attempts: [
      { accountId: 'account-a', model: 'actual-price' },
      { accountId: 'account-b', model: 'actual-price' },
    ],
  });
  const other = insert({ timestamp: day - 2000, completedAt: day - 1000 });
  const mismatch = insert({ timestamp: day - 1000 });
  raw.prepare("UPDATE request_logs SET session_id='session-yes', url='/matching', status=429 WHERE id IN (?,?)").run(first, other);
  raw.prepare("UPDATE request_logs SET session_id='session-no', url='/matching', status=429 WHERE id=?").run(mismatch);
  const filters = {
    from: day - 5000, to: day, sessionId: 'session-yes', search: 'matching',
    statusMode: '4xx' as const, attemptAccountId: 'account-a', attemptModel: 'actual-price',
  };
  const list = repository.execute({ operation: 'list', payload: { ...filters, limit: 10, offset: 0, trafficClass: 'model' } });
  expect(list).toMatchObject({ total: 1 });
  const activity = UsageActivityDaysSchema.parse(repository.execute({
    operation: 'usageActivity',
    payload: { filters, asOf: day + 10000, prices: [{ model: 'actual-price', inputPerMillion: 5, outputPerMillion: 0 }] },
  }));
  expect(activity.at(-1)).toEqual({
    date: '2026-03-09', requests: 1, attempts: 1, observedTokens: 120,
    incompleteRequests: 0, estimatedCostUsd: 0.0005, pricedAttempts: 1,
  });
});

describe('retained usage range in the native audit repository', () => {
  it('keeps an empty retained range distinct from complete official zero', () => {
    expect(read()).toEqual(empty);
  });
  it('sums input plus output once, keeps cached separate and requires exact model/account attribution', () => {
    insert();
    insert({ accountId: 'account-b' });
    insert({ model: 'claude-sonnet-other' });
    insert({ model: 'gemini-pro' });
    insert({ trafficClass: 'auxiliary' });
    expect(read()).toEqual({
      ...empty,
      recordedRequests: 1,
      countedRequests: 1,
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 60,
      totalTokens: 120,
    });
  });
  it('includes start, excludes end and future starts/completions without extending the cycle', () => {
    insert({ timestamp: from - 1 });
    insert({ timestamp: from });
    insert({ timestamp: to });
    insert({ timestamp: asOf });
    insert({ timestamp: asOf + 1 });
    insert({ completedAt: asOf + 1 });
    expect(read()).toEqual({
      ...empty,
      recordedRequests: 3,
      countedRequests: 2,
      missingUsageRequests: 1,
      missingCachedRequests: 1,
      inputTokens: 200,
      outputTokens: 40,
      cachedTokens: 120,
      totalTokens: 240,
    });
  });
  it('counts known terminal usage on failure/cancellation and records missing/invalid values separately', () => {
    for (const outcome of [
      'upstream_error',
      'client_cancelled',
      'client_disconnected',
      'timeout',
    ]) {
      insert({ outcome });
    }
    insert({ input: null });
    insert({ output: null });
    insert({ input: -1 });
    insert({ output: 1.5 });
    insert({ outcome: 'in_progress', completedAt: null });
    insert({ cached: null });
    expect(read()).toEqual({
      ...empty,
      recordedRequests: 10,
      countedRequests: 5,
      missingUsageRequests: 5,
      missingCachedRequests: 2,
      inputTokens: 700,
      outputTokens: 140,
      cachedTokens: 480,
      totalTokens: 840,
    });
  });
  it('counts owned attempts across retries and keeps unattributed requests ambiguous', () => {
    insert({ attempts: [] });
    insert({
      attempts: [
        { accountId: 'account-a', model: 'claude-sonnet' },
        { accountId: 'account-b', model: 'claude-sonnet' },
      ],
    });
    insert({
      attempts: [
        { accountId: 'account-a', model: 'claude-sonnet' },
        { accountId: 'account-a', model: 'claude-sonnet' },
      ],
    });
    insert({ attempts: [{ accountId: null, model: 'claude-sonnet' }] });
    insert({ attempts: [{ accountId: 'account-a', model: 'gpt-model' }] });
    expect(read()).toEqual({
      ...empty,
      recordedRequests: 5,
      countedRequests: 3,
      ambiguousRequests: 2,
      inputTokens: 400,
      outputTokens: 80,
      cachedTokens: 240,
      totalTokens: 480,
    });
  });
  it('remains idempotent across reads and parent completion replacements', () => {
    const id = insert();
    const first = read();
    expect(read()).toEqual(first);
    raw.prepare('UPDATE request_logs SET input_tokens=110 WHERE id=?').run(id);
    expect(read()).toEqual(first);
    raw.prepare('UPDATE upstream_attempts SET input_tokens=110 WHERE parent_id=?').run(id);
    expect(read()).toEqual({
      ...empty,
      recordedRequests: 1,
      countedRequests: 1,
      inputTokens: 110,
      outputTokens: 20,
      cachedTokens: 60,
      totalTokens: 130,
    });
    raw.prepare('DELETE FROM request_logs WHERE id=?').run(id);
    expect(read()).toEqual(empty);
  });
  it('distinguishes a recorded zero from missing usage and does not double count duplicate model selectors', () => {
    insert({ input: 0, output: 0, cached: 0 });
    const duplicated = { ...range, modelIds: ['claude-sonnet', 'claude-sonnet'] };
    expect(read(duplicated)).toEqual({
      ...empty,
      ...duplicated,
      recordedRequests: 1,
      countedRequests: 1,
    });
  });
  it('keeps unavailable cache quantities and incomplete attempts out of known totals', () => {
    insert({ cached: -1 });
    insert({ cached: 0.5 });
    insert({
      attempts: [{ accountId: range.accountId, model: range.modelIds[0], completedAt: null }],
    });
    insert({
      attempts: [{ accountId: range.accountId, model: range.modelIds[0], completedAt: asOf + 1 }],
    });
    expect(read()).toEqual({
      ...empty,
      recordedRequests: 4,
      countedRequests: 2,
      missingUsageRequests: 2,
      missingCachedRequests: 4,
      inputTokens: 200,
      outputTokens: 40,
      totalTokens: 240,
    });
  });
  it('rejects unsafe accumulated totals instead of returning rounded token counts', () => {
    insert({ input: Number.MAX_SAFE_INTEGER, output: 0 });
    insert({ input: 1, output: 0 });
    expect(read).toThrow();
  });
  it('treats quoted and wildcard model names as exact parameter values', () => {
    insert();
    const injected = { ...range, accountId: "a' OR 1=1 --", modelIds: ['%', "x') OR 1=1 --"] };
    expect(read(injected)).toEqual({ ...empty, ...injected });
  });
});
describe('usage query transport constraints', () => {
  it.each([
    { ...range, modelIds: [] },
    { ...range, modelIds: Array(129).fill('m') },
    { ...range, from: to },
    { ...range, to: from + 7 * 24 * 60 * 60 * 1000 + 1 },
    { ...range, from: -1 },
    { ...range, accountId: 'a'.repeat(257) },
    { ...range, modelIds: ['m'.repeat(257)] },
    { ...range, asOf: Number.MAX_SAFE_INTEGER },
  ])('rejects a malformed or unbounded range', (input) => {
    expect(UsageRangeInputSchema.safeParse(input).success).toBe(false);
  });
  it('rejects invented completeness and inconsistent totals at the response boundary', () => {
    expect(
      UsageRangeResultSchema.safeParse({ ...empty, coverage: 'all-provider-usage' }).success,
    ).toBe(false);
    expect(UsageRangeResultSchema.safeParse({ ...empty, totalTokens: 1 }).success).toBe(false);
    expect(UsageRangeResultSchema.safeParse({ ...empty, recordedRequests: 1 }).success).toBe(false);
    expect(UsageRangeResultSchema.safeParse({ ...empty, to: from }).success).toBe(false);
  });
});
