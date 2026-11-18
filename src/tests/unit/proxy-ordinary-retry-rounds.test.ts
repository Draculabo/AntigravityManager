import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { Observable } from 'rxjs';
import {
  collect,
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiStreamFrame,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'controlled-round-test/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));

const previousConfig = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const model = 'gemini-3-flash';
type Surface = 'chat' | 'responses' | 'anthropic' | 'gemini';
const surfaces: Surface[] = ['chat', 'responses', 'anthropic', 'gemini'];
function limited(seconds?: string) {
  return new UpstreamRequestError({
    message: 'Resource has been exhausted.',
    status: 429,
    body: 'RESOURCE_EXHAUSTED',
    headers: seconds ? { retryAfter: seconds } : undefined,
  });
}
function request(
  gateway: ReturnType<typeof createGateway>,
  surface: Surface,
  signal?: AbortSignal,
  stream = false,
) {
  if (surface === 'anthropic') {
    return gateway.anthropicService.handleAnthropicMessages(
      { model, messages: [{ role: 'user', content: 'controlled' }], max_tokens: 100, stream },
      undefined,
      signal,
    );
  }
  if (surface === 'gemini') {
    const body = { contents: [{ role: 'user', parts: [{ text: 'controlled' }] }] };
    return stream
      ? gateway.geminiService.handleGeminiStreamGenerateContent(model, body, signal)
      : gateway.geminiService.handleGeminiGenerateContent(model, body, 'generate-content', signal);
  }
  return gateway.openAIService.handleChatCompletions(
    { model, messages: [{ role: 'user', content: 'controlled' }], stream },
    surface === 'responses' ? 'responses' : 'chat-completions',
    signal,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  setServerConfig(previousConfig);
  for (const id of ['round-a', 'round-b']) {
    proxyModelAvailabilityStore.clearAccount(id);
  }
});

describe('ordinary request rounds through protocol services', () => {
  it.each(surfaces)(
    'retries stream establishment in round two with no unary fallback: %s',
    async (surface) => {
      const upstream = createUpstream({
        streamFrames: [geminiStreamFrame(geminiTextResponse('stream succeeded'))],
      });
      upstream.streamGenerateInternal
        .mockRejectedValueOnce(limited('1'))
        .mockRejectedValueOnce(limited('1'))
        .mockRejectedValueOnce(limited('1'));
      const pending = request(
        createGateway(upstream, createLease(['round-a', 'round-b'].map((id) => createAccount(id)))),
        surface,
        undefined,
        true,
      );
      // Advance retry admission, then consume the stream before its business deadline.
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      if (!(result instanceof Observable)) {
        throw new Error('Expected a protocol stream');
      }
      expect(await collect(result)).toContain('stream succeeded');
      expect(upstream.streamGenerateInternal.mock.calls.map((call) => call[1])).toEqual([
        'access-round-a',
        'access-round-b',
        'access-round-a',
        'access-round-a',
      ]);
      expect(upstream.generateInternal).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(surfaces)(
    'allows four normal sends and one grace for each of two accounts: %s',
    async (surface) => {
      const upstream = createUpstream({
        generate: () => {
          if (upstream.calls.length < 6) {
            throw limited('1');
          }
          return geminiTextResponse('last grace succeeded');
        },
      });
      const pending = request(
        createGateway(upstream, createLease(['round-a', 'round-b'].map((id) => createAccount(id)))),
        surface,
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.runAllTimersAsync();
      expect(await pending).toHaveProperty('value');
      expect(upstream.calls.map((call) => call.accessToken)).toEqual([
        'access-round-a',
        'access-round-b',
        'access-round-a',
        'access-round-a',
        'access-round-b',
        'access-round-b',
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(surfaces)(
    're-enters the pool without spending a normal slot on grace: %s',
    async (surface) => {
      const upstream = createUpstream({
        generate: () => {
          if (upstream.calls.length <= 3) {
            throw limited('1');
          }
          return geminiTextResponse('second round succeeded');
        },
      });
      const lease = createLease(['round-a', 'round-b'].map((id) => createAccount(id)));
      const result = request(createGateway(upstream, lease), surface).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.runAllTimersAsync();
      expect(await result).toHaveProperty('value');
      expect(upstream.calls.map((call) => call.accessToken)).toEqual([
        'access-round-a',
        'access-round-b',
        'access-round-a',
        'access-round-a',
      ]);
      expect(lease.getRetryAccountPoolSize).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(surfaces)(
    'allows one 12-second grace and three normal sends for one account: %s',
    async (surface) => {
      const upstream = createUpstream({
        generate: () => {
          if (upstream.calls.length <= 3) {
            throw limited('12');
          }
          return geminiTextResponse('fourth send succeeded');
        },
      });
      const lease = createLease([createAccount('round-a')]);
      const result = request(createGateway(upstream, lease), surface).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.runAllTimersAsync();
      expect(await result).toHaveProperty('value');
      expect(upstream.calls.map((call) => call.accessToken)).toEqual(
        Array(4).fill('access-round-a'),
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['gemini'] as const)(
    'does not spend token-count slots on grace: %s',
    async (_surface) => {
      const upstream = createUpstream({
        countTokens: () => {
          if (upstream.countTokensCalls.length <= 3) {
            throw limited('12');
          }
          return { totalTokens: 19 };
        },
      });
      const gateway = createGateway(upstream, createLease([createAccount('round-a')]));
      const pending = gateway.geminiService.handleGeminiCountTokens(model, {
        contents: [{ role: 'user', parts: [{ text: 'controlled' }] }],
      });
      const result = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.runAllTimersAsync();
      expect(await result).toEqual({ value: 19 });
      expect(upstream.countTokensCalls.map((call) => call.accessToken)).toEqual(
        Array(4).fill('access-round-a'),
      );
    },
  );

  it('does not renew the request deadline when a wait would cross it', async () => {
    setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, generation_timeout: 1 });
    const upstream = createUpstream({
      generate: () => {
        throw limited('12');
      },
    });
    const pending = request(
      createGateway(upstream, createLease([createAccount('round-a')])),
      'chat',
    ).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    await pending;
    expect(upstream.calls).toHaveLength(1);
    expect(Date.now()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps countTokens retries on the maintenance budget when generation has a short cap', async () => {
    setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, request_timeout: 120, generation_timeout: 1 });
    const upstream = createUpstream({
      countTokens: () => {
        if (upstream.countTokensCalls.length <= 3) {
          throw limited('12');
        }
        return { totalTokens: 19 };
      },
    });
    const gateway = createGateway(upstream, createLease([createAccount('round-a')]));
    const pending = gateway.geminiService.handleGeminiCountTokens(model, {
      contents: [{ role: 'user', parts: [{ text: 'controlled' }] }],
    });
    const completed = expect(pending).resolves.toBe(19);
    await vi.runAllTimersAsync();
    await completed;
    expect(upstream.countTokensCalls).toHaveLength(4);
    expect(Date.now()).toBeGreaterThan(1000);
  });

  it('cancels a single-account wait without another send or an abandoned timer', async () => {
    const controller = new AbortController();
    const upstream = createUpstream({
      generate: () => {
        throw limited('12');
      },
    });
    const pending = request(
      createGateway(upstream, createLease([createAccount('round-a')])),
      'chat',
      controller.signal,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(upstream.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
