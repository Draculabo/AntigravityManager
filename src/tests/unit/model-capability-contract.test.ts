import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import { RateLimitTrackerService } from '@/server/gateway/shared/services/rate-limit-tracker.service';
import { ProxyRetryService } from '@/server/gateway/shared/services/proxy-retry.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { createAccount } from './proxy-real-path.harness';
import { classifyModelCapabilityFailure } from '@/server/gateway/shared/services/model-capability-evidence';
import { createGateway, createUpstream, geminiTextResponse } from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'controlled-capability-test/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const services: AccountLeaseService[] = [];
const model = 'claude-sonnet-4-6-thinking';
async function fixture() {
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, quota_aware_scheduling_enabled: false });
  const accounts = ['cap-a', 'cap-b'].map((id) => createAccount(id));
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => structuredClone(accounts)),
    getAccount: vi.fn(async (id) => structuredClone(accounts.find((a) => a.id === id))),
    async compareAndUpdateToken(id, _expected, token, guard) {
      await this.updateToken(id, token, guard);
      return true;
    },
    updateToken: vi.fn(),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    fetchProjectId: vi.fn(),
    fetchQuota: vi.fn(),
    refreshAccessToken: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const availability = new ModelAvailabilityService();
  const lease = new AccountLeaseService(
    store,
    upstream,
    new RateLimitTrackerService(),
    availability,
  );
  services.push(lease);
  await lease.loadAccounts();
  const retry = new ProxyRetryService(lease, { log: vi.fn(), warn: vi.fn() }, availability);
  const fail = (status: number, message: string) =>
    retry.applyUpstreamPenalty('cap-a', model, new UpstreamRequestError({ status, message }));
  const select = () => lease.getNextToken({ model });
  return { lease, retry, availability, fail, select };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
});
afterEach(async () => {
  for (const lease of services.splice(0)) {
    await lease.onModuleDestroy();
  }
  setServerConfig(previous);
  vi.useRealTimers();
});

describe('account-specific model incapability through the real lease', () => {
  it('does not clear a sibling image capability denial when the other physical model succeeds', async () => {
    const { availability, retry } = await fixture();
    availability.mark('cap-a', 'gemini-3-pro-image', 'model_not_supported');
    availability.mark('cap-a', 'gemini-3.1-pro-image', 'model_forbidden');
    retry.markUpstreamSuccess('cap-a', 'gemini-3.1-pro-image');
    expect(
      availability
        .getActiveSnapshot()
        .map((row) => ({ account: row.accountId, model: row.modelId, reason: row.reason })),
    ).toEqual([{ account: 'cap-a', model: 'gemini-pro-image', reason: 'model_forbidden' }]);
  });

  it('keeps a capability denial shared across physical tiers of the same model family', async () => {
    const { availability, retry } = await fixture();
    await retry.applyUpstreamPenalty(
      'cap-a',
      'gemini-3.7-flash-low',
      new UpstreamRequestError({
        status: 404,
        message: 'Model gemini-3.7-flash-low is not supported',
      }),
    );

    expect(availability.isCapabilityBlocked('cap-a', 'gemini-3.7-flash-high')).toBe(true);
    retry.markUpstreamSuccess('cap-a', 'gemini-3.7-flash-medium');
    expect(availability.isCapabilityBlocked('cap-a', 'gemini-3.7-flash-high')).toBe(false);
  });

  it('retains the exact failure deadline across in-memory persistence and restart', async () => {
    const { availability, fail } = await fixture();
    await fail(404, `Model ${model} is not supported`);
    const saved = structuredClone(availability.getSnapshot());
    vi.setSystemTime(899_999);
    const restored = new ModelAvailabilityService({ load: () => saved, save: vi.fn() });
    expect(restored.isCapabilityBlocked('cap-a', model)).toBe(true);
    vi.setSystemTime(900_000);
    expect(restored.isCapabilityBlocked('cap-a', model)).toBe(false);
  });
  it.each(['chat', 'responses', 'anthropic', 'gemini'] as const)(
    'rotates to B after explicit rejection through the production %s service',
    async (surface) => {
      const { lease, availability } = await fixture();
      const upstream = createUpstream({
        generate: () => {
          if (upstream.calls.length === 1) {
            throw new UpstreamRequestError({
              status: 404,
              message: 'Model unsupported',
              details: [{ reason: 'MODEL_NOT_SUPPORTED' }],
            });
          }
          return geminiTextResponse('supported on replacement');
        },
      });
      const gateway = createGateway(upstream, lease, undefined, availability);
      if (surface === 'anthropic') {
        await gateway.anthropicService.handleAnthropicMessages({
          model: 'gemini-3-flash',
          max_tokens: 100,
          stream: false,
          messages: [{ role: 'user', content: 'controlled capability' }],
        });
      } else if (surface === 'gemini') {
        await gateway.geminiService.handleGeminiGenerateContent(
          'gemini-3-flash',
          { contents: [{ role: 'user', parts: [{ text: 'controlled capability' }] }] },
          'generate-content',
        );
      } else {
        await gateway.openAIService.handleChatCompletions(
          {
            model: 'gemini-3-flash',
            stream: false,
            messages: [{ role: 'user', content: 'controlled capability' }],
          },
          surface === 'responses' ? 'responses' : 'chat-completions',
        );
      }
      expect(upstream.calls.map((call) => call.accessToken)).toEqual([
        'access-cap-a',
        'access-cap-b',
      ]);
      const physicalModel = upstream.calls[0].body.model.replace(/^models\//, '');
      expect(availability.isCapabilityBlocked('cap-a', physicalModel)).toBe(true);
      expect(availability.isCapabilityBlocked('cap-b', physicalModel)).toBe(false);
    },
  );

  it.each([
    [400, `Model ${model}: tools are not supported`, null],
    [400, `Model ${model}: schema is not supported`, null],
    [400, `Model ${model} is not supported`, 'model_not_supported'],
    [401, `Access to model ${model} is denied`, null],
    [429, `Model ${model} is not supported`, null],
    [503, `Model ${model} is not available`, null],
    [404, `Model ${model}-extended is not supported`, null],
    [403, `Invalid credentials for model ${model}`, null],
    [404, 'Requested entity was not found', null],
  ] as const)(
    'classifies only explicit model evidence for status %i: %s',
    (status, message, expected) => {
      expect(
        classifyModelCapabilityFailure(model, new UpstreamRequestError({ status, message })),
      ).toBe(expected);
    },
  );

  it.each([404, 403])(
    'blocks only account A for explicit model failure %i, recovers at 900 seconds',
    async (status) => {
      const { fail, select, lease } = await fixture();
      await fail(
        status,
        status === 404
          ? `Model ${model} is not supported`
          : `Access to model ${model} is denied for this account`,
      );
      expect((await select())?.id).toBe('cap-b');
      expect((await select())?.id).toBe('cap-b');
      expect(
        (await lease.getNextToken({ model: 'gemini-3-flash', excludeAccountIds: ['cap-b'] }))?.id,
      ).toBe('cap-a');
      vi.setSystemTime(899_999);
      expect((await select())?.id).toBe('cap-b');
      vi.setSystemTime(900_000);
      expect([(await select())?.id, (await select())?.id]).toContain('cap-a');
    },
  );

  it('does not let an unknown catalog fall back into a recorded denial', async () => {
    const { fail, lease } = await fixture();
    await fail(404, `Model ${model} is not supported`);
    expect(await lease.getNextToken({ model, excludeAccountIds: ['cap-b'] })).toBeNull();
  });

  it('keeps capability denials across a generic cache reload and unrelated catalog refresh', async () => {
    const { fail, lease, select } = await fixture();
    await fail(404, `Model ${model} is not supported`);
    await lease.reloadAllAccountsOrThrow();
    expect((await select())?.id).toBe('cap-b');
    expect((await select())?.id).toBe('cap-b');
  });

  it('clears the matching account/model on actual success while keeping another denial', async () => {
    const { fail, retry, availability } = await fixture();
    await fail(404, `Model ${model} is not supported`);
    await retry.applyUpstreamPenalty(
      'cap-b',
      model,
      new UpstreamRequestError({ status: 404, message: `Model ${model} is not supported` }),
    );
    retry.markUpstreamSuccess('cap-a', model);
    expect(
      availability
        .getActiveSnapshot()
        .map((row) => ({ account: row.accountId, model: row.modelId, reason: row.reason })),
    ).toEqual([{ account: 'cap-b', model: 'claude-sonnet-4-6', reason: 'model_not_supported' }]);
  });

  it.each([
    'Requested entity was not found',
    'Project synthetic-project not found',
    'Endpoint /v1internal is not found',
  ])('does not turn an ambiguous/project/route 404 into capability state: %s', async (message) => {
    const { fail, availability } = await fixture();
    await fail(404, message);
    expect(availability.getActiveSnapshot()).toEqual([]);
  });

  it('does not classify authentication/validation failure as image capability failure', async () => {
    const { retry, availability, lease } = await fixture();
    const forbidden = vi.spyOn(lease, 'markAsForbidden');
    await retry.applyUpstreamPenalty(
      'cap-a',
      'gemini-3-pro-image',
      new UpstreamRequestError({ status: 403, message: 'Invalid credentials' }),
    );
    expect(forbidden).toHaveBeenCalledExactlyOnceWith('cap-a');
    expect(availability.getActiveSnapshot()).toEqual([]);
  });

  it('uses structured model denial evidence even when the body was truncated', async () => {
    const { retry, availability } = await fixture();
    await retry.applyUpstreamPenalty(
      'cap-a',
      model,
      new UpstreamRequestError({
        status: 403,
        message: 'Permission denied',
        body: 'truncated',
        details: [{ reason: 'MODEL_ACCESS_DENIED', metadata: { model } }],
      }),
    );
    expect(availability.getActiveSnapshot()).toEqual([
      expect.objectContaining({
        accountId: 'cap-a',
        modelId: 'claude-sonnet-4-6',
        reason: 'model_forbidden',
        unavailableUntil: 900_000,
      }),
    ]);
  });

  it('does not attribute a structured denial naming a different physical model', async () => {
    const { retry, availability } = await fixture();
    await retry.applyUpstreamPenalty(
      'cap-a',
      model,
      new UpstreamRequestError({
        status: 404,
        message: 'Not found',
        details: [{ reason: 'MODEL_NOT_FOUND', metadata: { model: 'another-model' } }],
      }),
    );
    expect(availability.getActiveSnapshot()).toEqual([]);
  });
});
