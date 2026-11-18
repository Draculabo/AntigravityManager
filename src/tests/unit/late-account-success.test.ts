import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { isObservable } from 'rxjs';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { ProxyRetryService } from '@/server/gateway/shared/services/proxy-retry.service';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import {
  RateLimitTrackerService,
  RateLimitReason,
} from '@/server/gateway/shared/services/rate-limit-tracker.service';
import {
  createAccount,
  createGateway,
  createUpstream,
  geminiTextResponse,
  geminiStreamFrame,
  collect,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'synthetic-late-success/0.0.0',
}));

const services: AccountLeaseService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.onModuleDestroy();
  }
});

async function fixture() {
  const account = createAccount('late-success');
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => [structuredClone(account)]),
    getAccount: vi.fn(async () => structuredClone(account)),
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
    fetchProjectId: vi.fn(),
    refreshAccessToken: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const availability = new ModelAvailabilityService();
  const tracker = new RateLimitTrackerService();
  const lease = new AccountLeaseService(store, upstream, tracker, availability);
  services.push(lease);
  const token = await lease.getNextToken({ model: 'gemini-3-flash' });
  if (!token) {
    throw new Error('Missing issued lease');
  }
  const retry = new ProxyRetryService(lease, { log: vi.fn(), warn: vi.fn() }, availability);
  return { lease, retry, token, availability, tracker };
}

describe('late successful account completion', () => {
  it.each(['openai', 'responses', 'gemini', 'anthropic'] as const)(
    'keeps %s output while suppressing stale success effects',
    async (protocol) => {
      const { lease, token, tracker, availability } = await fixture();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const upstream = createUpstream({
        generate: async () => {
          entered.resolve();
          await resume.promise;
          return geminiTextResponse('synthetic-answer');
        },
      });
      const gateway = createGateway(upstream, lease, undefined, availability);
      const model = 'gemini-3-flash';
      const request = {
        model,
        messages: [{ role: 'user' as const, content: 'synthetic-question' }],
      };
      const pending =
        protocol === 'gemini'
          ? gateway.geminiService.handleGeminiGenerateContent(model, {
              contents: [{ role: 'user', parts: [{ text: 'synthetic-question' }] }],
            })
          : protocol === 'anthropic'
            ? gateway.anthropicService.handleAnthropicMessages({ ...request, max_tokens: 32 })
            : gateway.openAIService.handleChatCompletions(
                request,
                protocol === 'responses' ? 'responses' : 'chat-completions',
              );
      const outcome = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await entered.promise;
        lease.evictAccount(token.id);
        await lease.loadAccounts();
        tracker.setLockoutUntilIso(
          token.id,
          new Date(Date.now() + 60_000).toISOString(),
          RateLimitReason.QuotaExhausted,
          model,
        );
        availability.mark(token.id, model, 'model_not_supported');
        const snapshot = availability.getSnapshot();
        resume.resolve();
        const result = await outcome;
        expect(JSON.stringify(result)).toContain('synthetic-answer');
        expect(availability.getSnapshot()).toEqual(snapshot);
        expect(tracker.getRemainingWaitSeconds(token.id, model)).toBeGreaterThan(0);
      } finally {
        resume.resolve();
        await outcome;
      }
    },
  );

  it.each(['openai', 'responses', 'gemini'] as const)(
    'retains %s image stream output when account replacement precedes clean end',
    async (protocol) => {
      const { lease, token, tracker, availability } = await fixture();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const image = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ inlineData: { mimeType: 'image/png', data: 'c3ludGhldGlj' } }],
            },
            finishReason: 'STOP',
          },
        ],
      };
      const stream = Readable.from(
        (async function* () {
          yield Buffer.from(`data: ${JSON.stringify(geminiStreamFrame(image))}\n\n`);
          entered.resolve();
          await resume.promise;
        })(),
      );
      const upstream = createUpstream({});
      upstream.streamGenerateInternal.mockResolvedValue(stream);
      const gateway = createGateway(upstream, lease, undefined, availability);
      const model = 'gemini-3-pro-image';
      const response =
        protocol === 'gemini'
          ? await gateway.geminiService.handleGeminiStreamGenerateContent(model, {
              contents: [{ role: 'user', parts: [{ text: 'synthetic-image' }] }],
            })
          : await gateway.openAIService.handleChatCompletions(
              { model, messages: [{ role: 'user', content: 'synthetic-image' }], stream: true },
              protocol === 'responses' ? 'responses' : 'chat-completions',
            );
      if (!isObservable(response)) {
        stream.destroy();
        throw new Error('Expected a stream');
      }
      const output = collect(response);
      const outcome = output.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await entered.promise;
        lease.evictAccount(token.id);
        await lease.loadAccounts();
        tracker.setLockoutUntilIso(
          token.id,
          new Date(Date.now() + 60_000).toISOString(),
          RateLimitReason.QuotaExhausted,
          model,
        );
        availability.mark(token.id, model, 'model_not_supported');
        const snapshot = availability.getSnapshot();
        resume.resolve();
        const result = await outcome;
        expect(result).toHaveProperty('value');
        expect(JSON.stringify(result)).toContain('c3ludGhldGlj');
        expect(availability.getSnapshot()).toEqual(snapshot);
        expect(tracker.getRemainingWaitSeconds(token.id, model)).toBeGreaterThan(0);
      } finally {
        resume.resolve();
        await outcome;
        stream.destroy();
      }
    },
  );

  it.each(['gemini-3-flash', 'gemini-3-pro-image'])(
    'preserves replacement protection for %s',
    async (model) => {
      const { lease, retry, token, tracker, availability } = await fixture();
      lease.evictAccount(token.id);
      await lease.loadAccounts();
      tracker.setLockoutUntilIso(
        token.id,
        new Date(Date.now() + 60_000).toISOString(),
        RateLimitReason.QuotaExhausted,
        model,
      );
      availability.mark(token.id, model, 'model_not_supported');
      const snapshot = availability.getSnapshot();
      retry.markUpstreamSuccess(token.id, model, () => lease.isLeaseCurrent(token));
      expect(availability.getSnapshot()).toEqual(snapshot);
      expect(tracker.getRemainingWaitSeconds(token.id, model)).toBeGreaterThan(0);
    },
  );

  it('still clears matching protection for the current issued lease', async () => {
    const { lease, retry, token, tracker, availability } = await fixture();
    const model = 'gemini-3-flash';
    tracker.setLockoutUntilIso(
      token.id,
      new Date(Date.now() + 60_000).toISOString(),
      RateLimitReason.QuotaExhausted,
      model,
    );
    availability.mark(token.id, model, 'model_not_supported');
    retry.markUpstreamSuccess(token.id, model, () => lease.isLeaseCurrent(token));
    expect(availability.getSnapshot()).toEqual([]);
    expect(tracker.getRemainingWaitSeconds(token.id, model)).toBe(0);
  });
});
