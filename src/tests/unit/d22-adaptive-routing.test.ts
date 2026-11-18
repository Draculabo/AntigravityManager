// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { ModelRoutingService } from '@/server/gateway/shared/services/model-routing.service';
import {
  NoAvailableAdaptiveModelError,
  resolveAdaptiveModel,
} from '@/server/gateway/shared/services/adaptive-model-routing';
import { tryResolveModelDiscoveryMetadata } from '@/server/gateway/shared/services/model-discovery-metadata';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import {
  collect,
  createAccount,
  createGateway,
  createUpstream,
  geminiStreamFrame,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'd22-test/1.0',
}));

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
  setServerConfig(previous);
  vi.restoreAllMocks();
});

function adaptive(target: string, models: string[], requested = 'client', effort?: string) {
  return resolveAdaptiveModel(target, requested, {
    getAvailableModels: () => new Set(models),
    effort,
  });
}

async function fixture(accounts: CloudAccount[]) {
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => structuredClone(accounts)),
    getAccount: vi.fn(async (id) => structuredClone(accounts.find((account) => account.id === id))),
    async compareAndUpdateToken(id, _expected, token, guard) {
      await this.updateToken(id, token, guard);
      return true;
    },
    updateToken: vi.fn(),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    fetchQuota: vi.fn(),
    refreshAccessToken: vi.fn(),
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const availability = new ModelAvailabilityService();
  const lease = new AccountLeaseService(store, upstream, undefined, availability);
  cleanup.push(() => lease.onModuleDestroy());
  await lease.loadAccounts();
  return { lease, store, upstream, availability };
}

function account(id: string, models: string[], percentage = 100): CloudAccount {
  return {
    ...createAccount(id),
    quota: {
      models: Object.fromEntries(models.map((model) => [model, { percentage, resetTime: '' }])),
    },
  };
}

describe('opt-in adaptive routing', () => {
  it('selects deterministic low Flash from advertised physical IDs, independent of pool order', () => {
    const pool = ['gemini-3.6-flash-low', 'gemini-3.7-flash-high', 'gemini-3.7-flash-low'];
    expect(adaptive('auto:gemini-flash-low', pool)).toBe('gemini-3.7-flash-low');
    expect(adaptive('auto:gemini-flash-low', pool.reverse())).toBe('gemini-3.7-flash-low');
    expect(adaptive('auto:gemini-flash-low', ['gemini-3.5-flash-extra-low'])).toBe(
      'gemini-3.5-flash-extra-low',
    );
    expect(() => adaptive('auto:gemini-flash-low', ['gemini-3.7-flash-high'])).toThrow(
      NoAvailableAdaptiveModelError,
    );
  });

  it('preserves explicit tiers, client effort and registered recipe tiers', () => {
    const pool = ['gemini-3.7-flash-low', 'gemini-3.7-flash-high'];
    expect(adaptive('auto:gemini-flash-low', pool, 'client-high', 'low')).toBe(
      'gemini-3.7-flash-high',
    );
    expect(adaptive('auto:gemini-flash-low', pool, 'client', 'high')).toBe('gemini-3.7-flash-high');
    expect(adaptive('auto:gemini-flash-low', pool, 'gemini-3-flash')).toBe('gemini-3.7-flash-high');
    expect(() =>
      adaptive('auto:gemini-flash-low', ['gemini-3.7-flash-low'], 'client', 'high'),
    ).toThrow(NoAvailableAdaptiveModelError);
  });

  it('prefers known available Opus versions and never falls into Sonnet', () => {
    const models = [
      'claude-opus-4-6-thinking',
      'claude-opus-5-5',
      'claude-opus-4-7',
      'claude-sonnet-5-5',
    ];
    expect(adaptive('auto:claude-opus', models)).toBe('claude-opus-5-5');
    expect(adaptive('auto:claude-opus', models.reverse())).toBe('claude-opus-5-5');
    expect(adaptive('auto:claude-opus-4-7', models)).toBe('claude-opus-4-7');
    expect(adaptive('auto:claude-opus-4-7', ['claude-opus-5-5', 'claude-opus-4-6-thinking'])).toBe(
      'claude-opus-4-6-thinking',
    );
    expect(adaptive('auto:claude-opus-4-7', ['claude-opus-5-5'])).toBe('claude-opus-5-5');
    expect(() => adaptive('auto:claude-opus', ['claude-sonnet-5-5'])).toThrow(
      NoAvailableAdaptiveModelError,
    );
    expect(() => adaptive('auto:claude-opus', [])).toThrow('No available accounts');
  });

  it('retains configured provenance and leaves static routing untouched without inspecting the pool', () => {
    const config = {
      ...DEFAULT_APP_CONFIG.proxy,
      model_aliases: [{ alias: 'client', target: 'auto:claude-opus', enabled: true }],
    };
    const policy = new ModelRoutingService();
    const context = { getAvailableModels: vi.fn(() => new Set(['claude-opus-5-5'])) };
    expect(policy.resolveModelRoute('client', config, context)).toEqual({
      requestedModel: 'client',
      normalizedModel: 'client',
      resolvedModel: 'claude-opus-5-5',
      source: 'configured',
      match: 'exact',
      matchedRule: { alias: 'client', target: 'auto:claude-opus' },
      adaptiveTarget: 'auto:claude-opus',
    });
    context.getAvailableModels.mockClear();
    expect(policy.resolveModelRoute('gemini-2.5-flash', config, context)).toEqual(
      policy.resolveModelRoute('gemini-2.5-flash', config),
    );
    expect(context.getAvailableModels).not.toHaveBeenCalled();
    expect(policy.resolveModelRoute('auto:claude-opus', config, context).source).toBe('miss');
  });

  it('uses real current lease evidence and excludes disabled, exhausted, blocked and ineligible accounts without effects', async () => {
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
    const disabled = { ...account('disabled', ['claude-opus-5-5']), proxy_enabled: false };
    const exhausted = account('exhausted', ['claude-opus-4-7'], 0);
    const oauth = {
      ...account('oauth', ['claude-opus-5-5']),
      health: { oauth: { refresh_blocked: true } },
    };
    const { lease, store, upstream, availability } = await fixture([
      account('ready', ['claude-opus-4-6-thinking', 'gemini-3.7-flash-low']),
      disabled,
      exhausted,
      oauth,
    ]);
    expect(lease.getAvailableAdaptiveModels()).toEqual(
      new Set(['claude-opus-4-6-thinking', 'gemini-3.7-flash-low']),
    );
    expect(lease.getAvailableAdaptiveModels('disabled')).toEqual(new Set());
    expect(lease.getAvailableAdaptiveModels('ready')).toEqual(
      new Set(['claude-opus-4-6-thinking', 'gemini-3.7-flash-low']),
    );
    lease.markAsForbidden('ready');
    expect(lease.getAvailableAdaptiveModels()).toEqual(new Set());
    expect(store.getAccount).not.toHaveBeenCalled();
    expect(store.updateToken).not.toHaveBeenCalled();
    expect(store.updateQuota).not.toHaveBeenCalled();
    expect(upstream.fetchQuota).not.toHaveBeenCalled();
    expect(upstream.refreshAccessToken).not.toHaveBeenCalled();
    expect(upstream.fetchProjectId).not.toHaveBeenCalled();
    expect(availability).toBeDefined();
  });

  it('publishes the selected physical limits and omits unavailable automatic aliases without recording misses', async () => {
    const config = {
      ...DEFAULT_APP_CONFIG.proxy,
      model_aliases: [{ alias: 'client', target: 'auto:claude-opus', enabled: true }],
    };
    const { lease } = await fixture([account('ready', ['claude-opus-4-6-thinking'])]);
    expect(tryResolveModelDiscoveryMetadata('client', lease, config)).toEqual(
      tryResolveModelDiscoveryMetadata('claude-opus-4-6-thinking', lease, {
        ...config,
        model_aliases: [],
      }),
    );
    lease.markAsForbidden('ready');
    expect(tryResolveModelDiscoveryMetadata('client', lease, config)).toBeUndefined();
  });

  it('excludes account-local capability and rate denials without suppressing the same model on healthy accounts', async () => {
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
    const { lease, availability } = await fixture([
      account('blocked', ['claude-opus-5-5']),
      account('healthy', ['claude-opus-5-5', 'claude-opus-4-6-thinking']),
    ]);
    availability.mark('blocked', 'claude-opus-5-5', 'model_not_supported');
    expect(lease.getAvailableAdaptiveModels('blocked')).toEqual(new Set());
    expect(lease.getAvailableAdaptiveModels()).toEqual(
      new Set(['claude-opus-5-5', 'claude-opus-4-6-thinking']),
    );
    lease.markAsRateLimited('healthy');
    expect(lease.getAvailableAdaptiveModels()).toEqual(new Set());
  });

  it('fails empty-pool generation and count requests before selection or upstream dispatch', async () => {
    setServerConfig({
      ...DEFAULT_APP_CONFIG.proxy,
      model_aliases: [{ alias: 'd22-client', target: 'auto:gemini-flash-low', enabled: true }],
    });
    const { lease } = await fixture([]);
    const select = vi.spyOn(lease, 'getNextToken');
    const upstream = createUpstream({});
    const gateway = createGateway(upstream, lease);
    const request = { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] };
    const claude = {
      model: 'd22-client',
      max_tokens: 100,
      messages: [{ role: 'user' as const, content: 'hello' }],
    };
    for (const operation of [
      () =>
        gateway.openAIService.handleChatCompletions({
          model: 'd22-client',
          messages: claude.messages,
        }),
      () => gateway.anthropicService.handleAnthropicMessages(claude),
      () => gateway.anthropicService.handleAnthropicCountTokens(claude),
      () => gateway.geminiService.handleGeminiGenerateContent('d22-client', request),
      () => gateway.geminiService.handleGeminiStreamGenerateContent('d22-client', request),
      () => gateway.geminiService.handleGeminiCountTokens('d22-client', request),
    ]) {
      await expect(operation()).rejects.toThrow(NoAvailableAdaptiveModelError);
    }
    expect(select).not.toHaveBeenCalled();
    expect(upstream.calls).toEqual([]);
    expect(upstream.countTokensCalls).toEqual([]);
  });

  it('keeps its physical selection through an account retry when the advertised pool changes', async () => {
    setServerConfig({
      ...DEFAULT_APP_CONFIG.proxy,
      model_aliases: [{ alias: 'd22-client', target: 'auto:gemini-flash-low', enabled: true }],
    });
    const models = ['gemini-3.6-flash-low', 'gemini-3.7-flash-low'];
    const { lease } = await fixture([account('first', models), account('second', models)]);
    const evidence = vi
      .spyOn(lease, 'getAvailableAdaptiveModels')
      .mockReturnValue(new Set([models[0]]));
    let attempt = 0;
    const upstream = createUpstream({
      generate: () => {
        attempt++;
        if (attempt === 1) {
          evidence.mockReturnValue(new Set([models[1]]));
          throw new UpstreamRequestError({ message: 'temporary upstream failure', status: 500 });
        }
        return geminiTextResponse('retried');
      },
    });
    const gateway = createGateway(upstream, lease);
    await gateway.openAIService.handleChatCompletions({
      model: 'd22-client',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(
      upstream.calls.map((call) => ({ model: call.body.model, token: call.accessToken })),
    ).toEqual([
      { model: models[0], token: 'access-first' },
      { model: models[0], token: 'access-second' },
    ]);
    expect(evidence).toHaveBeenCalledOnce();
  }, 15000);

  it.each([
    'openai',
    'anthropic',
    'gemini',
    'gemini-stream',
    'gemini-count',
    'anthropic-count',
  ] as const)(
    'resolves and freezes an adaptive physical target at the normal %s entry point',
    async (path) => {
      setServerConfig({
        ...DEFAULT_APP_CONFIG.proxy,
        model_aliases: [{ alias: 'd22-client', target: 'auto:gemini-flash-low', enabled: true }],
      });
      const { lease } = await fixture([account('ready', ['gemini-3.7-flash-low'])]);
      const evidence = vi.spyOn(lease, 'getAvailableAdaptiveModels');
      const upstream = createUpstream({
        generate: geminiTextResponse('D22 accepted'),
        streamFrames: [geminiStreamFrame(geminiTextResponse('D22 accepted'))],
        countTokens: { totalTokens: 11 },
      });
      const gateway = createGateway(upstream, lease);
      const request = { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] };
      if (path === 'openai') {
        await gateway.openAIService.handleChatCompletions({
          model: 'd22-client',
          messages: [{ role: 'user', content: 'hello' }],
        });
      } else if (path === 'anthropic') {
        await gateway.anthropicService.handleAnthropicMessages({
          model: 'd22-client',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hello' }],
        });
      } else if (path === 'gemini') {
        await gateway.geminiService.handleGeminiGenerateContent('d22-client', request);
      } else if (path === 'gemini-stream') {
        const result = await gateway.geminiService.handleGeminiStreamGenerateContent(
          'd22-client',
          request,
        );
        expect(result).toBeInstanceOf(Observable);
        await collect(result);
      } else if (path === 'gemini-count') {
        expect(await gateway.geminiService.handleGeminiCountTokens('d22-client', request)).toBe(11);
      } else {
        expect(
          await gateway.anthropicService.handleAnthropicCountTokens({
            model: 'd22-client',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'hello' }],
          }),
        ).toBeGreaterThan(0);
      }
      expect(evidence).toHaveBeenCalledOnce();
      for (const call of upstream.calls) {
        expect(call.body.model).toBe('gemini-3.7-flash-low');
      }
      if (path === 'gemini-count') {
        expect(upstream.countTokensCalls).toHaveLength(1);
        expect(upstream.countTokensCalls[0].body).toEqual({
          request: { model: 'models/gemini-3.7-flash-low', contents: request.contents },
        });
      } else if (path !== 'anthropic-count') {
        expect(upstream.calls).toHaveLength(1);
      }
    },
  );

  it.each(['openai', 'anthropic', 'gemini'] as const)(
    'adds Claude-required headers for an arbitrary automatic Opus alias through %s',
    async (protocol) => {
      setServerConfig({
        ...DEFAULT_APP_CONFIG.proxy,
        model_aliases: [{ alias: 'private-agent', target: 'auto:claude-opus', enabled: true }],
      });
      const { lease } = await fixture([account('ready', ['claude-opus-4-6-thinking'])]);
      const upstream = createUpstream({ generate: geminiTextResponse('Opus accepted') });
      const gateway = createGateway(upstream, lease);
      if (protocol === 'openai') {
        await gateway.openAIService.handleChatCompletions({
          model: 'private-agent',
          messages: [{ role: 'user', content: 'hello' }],
        });
      } else if (protocol === 'anthropic') {
        await gateway.anthropicService.handleAnthropicMessages({
          model: 'private-agent',
          max_tokens: 100,
          messages: [{ role: 'user', content: 'hello' }],
        });
      } else {
        await gateway.geminiService.handleGeminiGenerateContent('private-agent', {
          contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        });
      }
      expect(upstream.calls.map((call) => call.body.model)).toEqual(['claude-opus-4-6-thinking']);
      expect(upstream.generateInternal.mock.calls[0][3]).toEqual({
        'anthropic-beta':
          'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
      });
    },
  );
});
