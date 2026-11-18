import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const capture = vi.hoisted(() => ({ start: vi.fn(), complete: vi.fn() }));
vi.mock('@/modules/proxy-gateway/audit/traffic-audit.service', () => ({
  trafficAuditService: {
    startParent: capture.start,
    completeParent: capture.complete,
    captureGeneration: () => 0,
  },
}));
import {
  registerTrafficAuditHttpHooks,
  captureCurrentAuditSession,
  bindCurrentThoughtRecoveryScope,
  runWithTrafficAuditRequestContext,
  getProxyResponseTimingContext,
  type TrafficAuditRequestContext,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import {
  resolveLineageAccountAffinity,
  resolveOpenAISessionScope,
  resolveResponsesSessionScope,
} from '@/server/gateway/common/signature-session-scope';
import { thoughtCaptureLeases } from '@/modules/proxy-gateway/thought-store/thought-capture-leases';
import { createThoughtSessionKey } from '@/modules/proxy-gateway/audit/traffic-audit-http-metadata';
let app: FastifyInstance;
beforeEach(() => {
  capture.start.mockReset().mockReturnValue({ id: 'parent', trafficClass: 'model', startedAt: 0 });
  capture.complete.mockReset();
  app = Fastify();
  registerTrafficAuditHttpHooks(app);
  app.post('/v1/chat/completions', (_request, reply) =>
    reply.header('x-session-id', 'forged-response-session').send({ ok: true }),
  );
});
afterEach(async () => {
  await app.close();
});
async function key(headers: Record<string, string>, payload: object = {}) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions?session_id=query-loser',
    headers,
    payload,
  });
  expect(response.json()).toEqual({ ok: true });
  return capture.start.mock.lastCall?.[0].sessionId;
}
it('uses the canonical D03 hint and credential scope, never the response header', async () => {
  const headers = {
    authorization: 'Bearer synthetic-tenant-one',
    'x-claude-code-session-id': 'winner',
    'x-session-id': 'header-loser',
  };
  const first = await key(headers, { session_id: 'body-loser' });
  expect(first).toBe(resolveLineageAccountAffinity('winner', headers));
  expect(first).toMatch(/^session:affinity:v1:[a-f0-9]{64}$/u);
  expect(first).not.toContain('synthetic-tenant-one');
  expect(first).not.toContain('forged-response-session');
  expect(
    await key({ 'x-api-key': 'synthetic-tenant-one', 'x-claude-code-session-id': 'winner' }),
  ).toBe(first);
  expect(
    await key({
      authorization: 'Bearer synthetic-tenant-two',
      'x-claude-code-session-id': 'winner',
    }),
  ).not.toBe(first);
});
it('keeps the full child identity in HTTP audit and signature recovery', async () => {
  const authorization = 'Bearer synthetic-tenant';
  const request = {
    model: 'fixture',
    messages: [{ role: 'user' as const, content: 'Shared task' }],
  };
  const ids = ['batch:step:1', 'batch:step:2'];
  const headers = ids.map((id) => ({ authorization, 'x-session-id': id }));
  const [first, second] = headers.map((header) => resolveOpenAISessionScope(request, header));

  expect(first.affinityKey).toBe(second.affinityKey);
  expect(first.storeKey).not.toBe(second.storeKey);
  expect(first.cacheKey).not.toBe(second.cacheKey);
  expect(first.auditKey).not.toBe(second.auditKey);
  expect(await key(headers[0])).toBe(first.auditKey);
  expect(await key(headers[1])).toBe(second.auditKey);

  const controls = [
    { authorization, 'x-session-id': 'batch:step:one' },
    { authorization, 'x-session-id': 'other:step:1' },
    { authorization, 'x-client-session-id': ids[0] },
    { authorization: 'Bearer another-tenant', 'x-session-id': ids[0] },
    { 'x-session-id': ids[0] },
  ];
  for (const header of controls) {
    expect(resolveOpenAISessionScope(request, header).affinityKey).not.toBe(first.affinityKey);
  }

  const restored = resolveResponsesSessionScope(request, ids[0], { authorization }, undefined, {
    origin: 'client',
    initialTaskFingerprint: 'original-task',
  });
  expect(restored.affinityKey).toBe(first.auditKey);
  expect(restored.hint.source).toBe('restored-lineage');
});

it('keeps distinct Unicode client IDs separate rather than sanitizing them into one session', async () => {
  const first = await key({ authorization: 'Bearer synthetic-key' }, { session_id: '会话甲' });
  const second = await key({ authorization: 'Bearer synthetic-key' }, { session_id: '会话乙' });
  // Query wins over body under D03, so both belong to the explicit query session here.
  expect(first).toBe(second);
  const values: string[] = [];
  for (const session_id of ['会话甲', '会话乙']) {
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer synthetic-key' },
      payload: { session_id },
    });
    values.push(capture.start.mock.lastCall?.[0].sessionId);
  }
  expect(values[0]).not.toBe(values[1]);
});
it('does not promote a previous-response cursor or absent hint into a stable saved session', async () => {
  await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: { previous_response_id: 'response-cursor' },
  });
  expect(capture.start.mock.lastCall?.[0].sessionId).toBeUndefined();
});
it('accepts a protocol-owned generated scope without substituting it into client request content', () => {
  const request = { model: 'gemini', messages: [{ role: 'user' as const, content: 'hello' }] };
  const scope = resolveOpenAISessionScope(request, { authorization: 'Bearer synthetic-key' });
  const context: TrafficAuditRequestContext = {
    attemptSequence: 0,
    parent: null,
    thoughtSessionKey: 'unchanged',
    thoughtSessionStable: false,
  };
  runWithTrafficAuditRequestContext(context, () => captureCurrentAuditSession(scope));
  expect(context.auditSessionId).toBe(scope.affinityKey);
  expect(context.auditSessionId).toMatch(/^session:store:v2:[a-f0-9]{64}$/u);
  expect(context.thoughtSessionKey).toBe(scope.storeKey);
  expect(request.messages).toEqual([{ role: 'user', content: 'hello' }]);
  context.thoughtCaptureLease?.release();
});

it('preserves explicit client ownership and never rearms a revoked entry during protocol binding', () => {
  const scope = resolveOpenAISessionScope({ model: 'gemini', messages: [] }, {});
  for (const stable of [true, false]) {
    const context: TrafficAuditRequestContext = {
      attemptSequence: 0,
      parent: null,
      thoughtSessionKey: 'entry',
      thoughtSessionStable: stable,
    };
    runWithTrafficAuditRequestContext(context, () => {
      const release = thoughtCaptureLeases.block('entry');
      try {
        captureCurrentAuditSession(scope);
        expect(context.thoughtSessionKey).toBe('entry');
        expect(context.thoughtCaptureLease?.valid).toBe(false);
      } finally {
        release();
      }
    });
    context.thoughtCaptureLease?.release();
  }
  const stableContext: TrafficAuditRequestContext = {
    attemptSequence: 0,
    parent: null,
    thoughtSessionKey: 'explicit-client',
    thoughtSessionStable: true,
  };
  runWithTrafficAuditRequestContext(stableContext, () => captureCurrentAuditSession(scope));
  expect(stableContext.thoughtSessionKey).toBe('explicit-client');
  stableContext.thoughtCaptureLease?.release();
});

it('releases the HTTP request lease after completion, including body-resolved identity', async () => {
  const observed: { keys: string[] | null } = { keys: null };
  app.post('/lease', (request, reply) => {
    expect(getProxyResponseTimingContext(request)).toBeDefined();
    observed.keys = thoughtCaptureLeases.protectedKeys();
    return reply.send({ ok: true });
  });
  const before = thoughtCaptureLeases.protectedKeys();
  await app.inject({ method: 'POST', url: '/lease', payload: { session_id: 'body-session' } });
  expect(observed.keys?.length).toBe((before?.length ?? 0) + 1);
  expect(thoughtCaptureLeases.protectedKeys()).toEqual(before);
});

it('keeps proven restored ownership when downstream protocol conversion publishes another anchored key', () => {
  const context: TrafficAuditRequestContext = {
    attemptSequence: 0,
    parent: null,
    thoughtSessionKey: 'temporary',
    thoughtSessionStable: false,
  };
  runWithTrafficAuditRequestContext(context, () => {
    bindCurrentThoughtRecoveryScope('verified-parent');
    const scope = resolveOpenAISessionScope({ model: 'fixture', messages: [] }, {});
    captureCurrentAuditSession(scope);
    expect(context.thoughtSessionKey).toBe('verified-parent');
    expect(context.auditSessionId).toBe(scope.affinityKey);
  });
  context.thoughtCaptureLease?.release();
});

it('uses the canonical Thought scope in actual HTTP entry/body refresh and keeps Unicode sessions separate', async () => {
  const baseline = thoughtCaptureLeases.protectedKeys() ?? [];
  app.post('/thought-scope', (_request, reply) =>
    reply.send({
      active: thoughtCaptureLeases.protectedKeys()?.filter((key) => !baseline.includes(key)),
    }),
  );
  const headers = { authorization: 'Bearer synthetic-caller' };
  const send = async (session_id: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/thought-scope',
        headers,
        payload: { session_id },
      })
    ).json();
  expect(await send('会话甲')).toEqual({ active: [createThoughtSessionKey(headers, '会话甲')] });
  expect(await send('会话乙')).toEqual({ active: [createThoughtSessionKey(headers, '会话乙')] });
  const preferred = await app.inject({
    method: 'POST',
    url: '/thought-scope?session_id=query-loser',
    headers: { ...headers, 'x-claude-code-session-id': 'header-winner' },
    payload: { session_id: 'body-loser' },
  });
  expect(preferred.json()).toEqual({ active: [createThoughtSessionKey(headers, 'header-winner')] });
  expect(thoughtCaptureLeases.protectedKeys()).toEqual(baseline);
});
