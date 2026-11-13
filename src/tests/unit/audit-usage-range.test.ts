import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrafficAuditRepository } from '@/modules/proxy-gateway/audit/traffic-audit.repository';
import { UsageTrendsResultSchema } from '@/modules/proxy-gateway/audit/usage-trends.schema';
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
  const firstDay = new Date(2026, 1, 8).getTime();
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
      payload: { ...payload, includeActivity: true },
    }),
  );
  expect(collapsed).not.toHaveProperty('activity');
  expect(expanded).toEqual(collapsed);
  expect(expanded.totals.requests).toBe(1);
  expect(activity).toHaveLength(30);
  expect(activity?.[0]).toEqual({ date: '2026-02-08', requests: 1 });
  expect(activity?.[1]).toEqual({ date: '2026-02-09', requests: 0 });
  expect(activity?.slice(-2)).toEqual([
    { date: '2026-03-08', requests: 1 },
    { date: '2026-03-09', requests: 2 },
  ]);
  expect(activity?.reduce((total, day) => total + day.requests, 0)).toBe(4);

  const requested = UsageTrendsResultSchema.parse(
    repository.execute({
      operation: 'usageTrends',
      payload: { ...payload, modelView: 'requested', model: 'client-alias', includeActivity: true },
    }),
  );
  expect(requested.activity?.filter(({ requests }) => requests > 0)).toEqual([
    { date: '2026-03-09', requests: 1 },
  ]);
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
