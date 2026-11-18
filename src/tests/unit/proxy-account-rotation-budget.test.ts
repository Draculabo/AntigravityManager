import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { ProxyAccountUnavailableError } from '@/server/gateway/common/exceptions/proxy-account-unavailable.exception';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  collect,
  geminiStreamFrame,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock(
  '@/server/gateway/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/server/gateway/common/utils/request-user-agent')
    >()),
    resolveRequestUserAgent: async () => 'controlled-rotation-test/0.0.0',
    resolveLocalInstalledVersion: () => '0.0.0',
  }),
);

type Gateway = ReturnType<typeof createGateway>;
type Surface = 'chat' | 'responses' | 'anthropic' | 'gemini';
const surfaces: Surface[] = ['chat', 'responses', 'anthropic', 'gemini'];
const accounts = ['rotation-a', 'rotation-b', 'rotation-c', 'rotation-d'];
const generic429 = () =>
  new UpstreamRequestError({
    message: 'Resource has been exhausted.',
    status: 429,
    body: JSON.stringify({
      error: { status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted.' },
    }),
  });

function request(gateway: Gateway, surface: Surface, stream = false, signal?: AbortSignal) {
  if (surface === 'anthropic') {
    return gateway.anthropicService.handleAnthropicMessages(
      {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'controlled request' }],
        max_tokens: 100,
        stream,
      },
      undefined,
      signal,
    );
  }
  if (surface === 'gemini') {
    const body = { contents: [{ role: 'user', parts: [{ text: 'controlled request' }] }] };
    return stream
      ? gateway.geminiService.handleGeminiStreamGenerateContent('gemini-3-flash', body, signal)
      : gateway.geminiService.handleGeminiGenerateContent(
          'gemini-3-flash',
          body,
          'generate-content',
          signal,
        );
  }
  return gateway.openAIService.handleChatCompletions(
    {
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'controlled request' }],
      stream,
    },
    surface === 'responses' ? 'responses' : 'chat-completions',
    signal,
  );
}

describe('Ordinary account rotation through production protocol services', () => {
  it.each(surfaces)(
    'expands stream establishment to the fourth candidate on %s',
    async (surface) => {
      const upstream = createUpstream({
        streamFrames: [geminiStreamFrame(geminiTextResponse('D stream succeeded'))],
      });
      const hinted = new UpstreamRequestError({
        message: 'temporarily limited',
        status: 429,
        headers: { retryAfter: '20' },
      });
      upstream.streamGenerateInternal
        .mockRejectedValueOnce(hinted)
        .mockRejectedValueOnce(hinted)
        .mockRejectedValueOnce(hinted);
      const lease = createLease(accounts.map((id) => createAccount(id)));
      const pending = request(createGateway(upstream, lease), surface, true);
      await vi.advanceTimersByTimeAsync(150);
      const stream = await pending;
      if (!(stream instanceof Observable)) {
        throw new Error('Expected protocol stream');
      }
      expect(await collect(stream)).toContain('D stream succeeded');
      expect(upstream.streamGenerateInternal.mock.calls.map((call) => call[1])).toEqual(
        accounts.map((id) => 'access-' + id),
      );
      expect(upstream.generateInternal).not.toHaveBeenCalled();
      expect(lease.getRetryAccountPoolSize).toHaveBeenCalledOnce();
      expect(Date.now()).toBe(150);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not load a pool or send upstream after an already-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const lease = createLease(accounts.map((id) => createAccount(id)));
    const upstream = createUpstream({ generate: geminiTextResponse('unused') });
    await expect(
      request(createGateway(upstream, lease), 'chat', false, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(lease.getRetryAccountPoolSize).not.toHaveBeenCalled();
    expect(lease.getNextToken).not.toHaveBeenCalled();
    expect(upstream.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(surfaces)('reaches a fourth candidate after hinted limits on %s', async (surface) => {
    const upstream = createUpstream({
      generate: () => {
        if (upstream.calls.length < 4) {
          throw new UpstreamRequestError({
            message: 'temporarily limited',
            status: 429,
            headers: { retryAfter: '20' },
          });
        }
        return geminiTextResponse('D succeeded');
      },
    });
    const gateway = createGateway(upstream, createLease(accounts.map((id) => createAccount(id))));
    const result = request(gateway, surface).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();
    expect(await result).toHaveProperty('value');
    expect(upstream.calls.map((call) => call.accessToken)).toEqual(
      accounts.map((id) => 'access-' + id),
    );
    expect(Date.now()).toBe(150);
  });

  it.each(['gemini'] as const)('expands hinted token-count rotation on %s', async (_surface) => {
    const upstream = createUpstream({
      countTokens: () => {
        if (upstream.countTokensCalls.length < 4) {
          throw new UpstreamRequestError({
            message: 'temporarily limited',
            status: 429,
            headers: { retryAfter: '20' },
          });
        }
        return { totalTokens: 10 };
      },
    });
    const gateway = createGateway(upstream, createLease(accounts.map((id) => createAccount(id))));
    const pending = gateway.geminiService.handleGeminiCountTokens('gemini-3-flash', {
      contents: [{ role: 'user', parts: [{ text: 'count this' }] }],
    });
    const result = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ value: 10 });
    expect(upstream.countTokensCalls.map((call) => call.accessToken)).toEqual(
      accounts.map((id) => 'access-' + id),
    );
    expect(Date.now()).toBe(150);
  });

  it('caps ordinary attempts at twelve even when more eligible accounts remain', async () => {
    const pool = Array.from({ length: 15 }, (_, i) => createAccount('budget-' + i));
    const forbidden = new UpstreamRequestError({
      message: 'access denied',
      status: 403,
      body: 'PERMISSION_DENIED',
    });
    const upstream = createUpstream({
      generate: () => {
        throw forbidden;
      },
    });
    const result = request(createGateway(upstream, createLease(pool)), 'chat').catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    expect(await result).toBe(forbidden);
    expect(upstream.calls.map((call) => call.accessToken)).toEqual(
      pool.slice(0, 12).map((account) => account.token.access_token),
    );
    for (const account of pool) {
      proxyModelAvailabilityStore.clearAccount(account.id);
    }
  });

  it.each(['gemini'] as const)(
    'preserves image-model token-count backoff outside ordinary rotation on %s',
    async (_surface) => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const upstream = createUpstream({
          countTokens: () => {
            if (upstream.countTokensCalls.length <= 2) {
              throw generic429();
            }
            return { totalTokens: 10 };
          },
        });
        const gateway = createGateway(
          upstream,
          createLease(accounts.map((id) => createAccount(id))),
        );
        const pending = gateway.geminiService.handleGeminiCountTokens('gemini-3.1-flash-image', {
          contents: [{ role: 'user', parts: [{ text: 'count this' }] }],
        });
        await vi.runAllTimersAsync();
        expect(await pending).toBe(10);
        expect(upstream.countTokensCalls.map((call) => call.accessToken)).toEqual([
          'access-rotation-a',
          'access-rotation-b',
          'access-rotation-c',
        ]);
        expect(Date.now()).toBe(3000);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        random.mockRestore();
      }
    },
  );

  it.each(surfaces)(
    'keeps a successful stream after rotating from A to B on %s',
    async (surface) => {
      const upstream = createUpstream({
        streamFrames: [geminiStreamFrame(geminiTextResponse('B stream succeeded'))],
      });
      upstream.streamGenerateInternal.mockRejectedValueOnce(generic429());
      const lease = createLease(accounts.map((id) => createAccount(id)));
      const result = request(createGateway(upstream, lease), surface, true);
      await vi.advanceTimersByTimeAsync(50);
      const stream = await result;
      expect(stream).toBeInstanceOf(Observable);
      if (!(stream instanceof Observable)) {
        throw new Error('Expected protocol stream');
      }
      const output = await collect(stream);
      expect(output).toContain('B stream succeeded');
      expect(upstream.calls.map((call) => call.accessToken)).toEqual(['access-rotation-b']);
      // The rejected start has no fake call entry; its arguments still prove A was attempted.
      expect(upstream.streamGenerateInternal.mock.calls.map((call) => call[1])).toEqual([
        'access-rotation-a',
        'access-rotation-b',
      ]);
      expect(upstream.generateInternal).not.toHaveBeenCalled();
      expect(Date.now()).toBe(50);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['gemini'] as const)(
    'applies the same A/B budget to %s token counting',
    async (_surface) => {
      const upstream = createUpstream({
        countTokens: () => {
          throw generic429();
        },
      });
      const gateway = createGateway(upstream, createLease(accounts.map((id) => createAccount(id))));
      const pending = gateway.geminiService.handleGeminiCountTokens('gemini-3-flash', {
        contents: [{ role: 'user', parts: [{ text: 'count this' }] }],
      });
      const result = pending.catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await result).toBeInstanceOf(ProxyAccountUnavailableError);
      expect(upstream.countTokensCalls.map((call) => call.accessToken)).toEqual([
        'access-rotation-a',
        'access-rotation-b',
      ]);
      expect(Date.now()).toBe(50);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('preserves mixed failure diagnostics and isolates budgets across requests', async () => {
    const forbidden = new UpstreamRequestError({
      message: 'account access denied',
      status: 403,
      body: 'PERMISSION_DENIED',
    });
    const upstream = createUpstream({
      generate: () => {
        if (upstream.calls.at(-1)?.accessToken === 'access-rotation-b') {
          throw forbidden;
        }
        throw generic429();
      },
    });
    const gateway = createGateway(upstream, createLease(accounts.map((id) => createAccount(id))));
    for (let index = 0; index < 2; index++) {
      const result = request(gateway, 'chat').catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      if (index === 0) {
        expect(await result).toBe(forbidden);
      } else {
        expect(await result).toBeInstanceOf(ProxyAccountUnavailableError);
        expect(((await result) as ProxyAccountUnavailableError).getStatus()).toBe(429);
      }
    }
    expect(upstream.calls.map((call) => call.accessToken)).toEqual([
      'access-rotation-a',
      'access-rotation-b',
      'access-rotation-c',
      'access-rotation-a',
      'access-rotation-c',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const id of accounts) {
      proxyModelAvailabilityStore.clearAccount(id);
    }
  });

  it.each(surfaces.flatMap((surface) => [false, true].map((stream) => ({ surface, stream }))))(
    'stops after A/B unhinted 429 on $surface, stream=$stream even if C would succeed',
    async ({ surface, stream }) => {
      const upstream = createUpstream({
        generate: () => {
          if (upstream.calls.at(-1)?.accessToken !== 'access-rotation-c') {
            throw generic429();
          }
          return geminiTextResponse('C must remain unused');
        },
        streamError: generic429(),
      });
      const lease = createLease(accounts.map((id) => createAccount(id)));
      const gateway = createGateway(upstream, lease);
      const result = request(gateway, surface, stream).then(
        () => null,
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      const error = await result;

      expect(error).toBeInstanceOf(ProxyAccountUnavailableError);
      expect((error as ProxyAccountUnavailableError).getStatus()).toBe(429);
      expect(upstream.calls.map((call) => call.accessToken)).toEqual([
        'access-rotation-a',
        'access-rotation-b',
      ]);
      expect(lease.getNextToken).toHaveBeenCalledTimes(2);
      expect(lease.penalties).toEqual([
        { accountId: 'rotation-a', kind: 'upstream_error' },
        { accountId: 'rotation-b', kind: 'upstream_error' },
      ]);
      expect(Date.now()).toBe(50);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(surfaces)(
    'rotates from hinted A to B in 50ms on %s without resending A',
    async (surface) => {
      const sentAt: number[] = [];
      const upstream = createUpstream({
        generate: () => {
          sentAt.push(Date.now());
          if (upstream.calls.length === 1) {
            throw new UpstreamRequestError({
              message: 'rate limited',
              status: 429,
              headers: { retryAfter: '2' },
            });
          }
          return geminiTextResponse('B succeeded');
        },
      });
      const lease = createLease(accounts.map((id) => createAccount(id)));
      const result = request(createGateway(upstream, lease), surface).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.runAllTimersAsync();

      expect(await result).toHaveProperty('value');
      expect(upstream.calls.map((call) => call.accessToken)).toEqual([
        'access-rotation-a',
        'access-rotation-b',
      ]);
      expect(sentAt).toEqual([0, 50]);
      expect(lease.penalties).toEqual([{ accountId: 'rotation-a', kind: 'upstream_error' }]);
    },
  );

  it('does not wait when the only failed account is no longer retryable', async () => {
    const upstream = createUpstream({
      generate: () => {
        throw generic429();
      },
    });
    const lease = createLease([createAccount(accounts[0])]);
    lease.getOrdinaryRetryWaitMs.mockImplementation(() => (upstream.calls.length > 0 ? null : 0));
    const result = request(createGateway(upstream, lease), 'chat').catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(ProxyAccountUnavailableError);
    expect(upstream.calls.map((call) => call.accessToken)).toEqual(['access-rotation-a']);
    expect(Date.now()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the 50ms rotation delay before sending B', async () => {
    const controller = new AbortController();
    const upstream = createUpstream({
      generate: () => {
        throw generic429();
      },
    });
    const lease = createLease(accounts.map((id) => createAccount(id)));
    const result = request(createGateway(upstream, lease), 'chat', false, controller.signal).catch(
      (error: unknown) => error,
    );
    // Let the request reach the pending timer without advancing its deadline.
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.runAllTimersAsync();

    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(upstream.calls.map((call) => call.accessToken)).toEqual(['access-rotation-a']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not count hard quota failures toward the generic two-account stop', async () => {
    const upstream = createUpstream({
      generate: () => {
        if (upstream.calls.length <= 2) {
          throw new UpstreamRequestError({
            message: 'QUOTA_EXHAUSTED',
            status: 429,
            body: 'QUOTA_EXHAUSTED; retry after 3600s',
          });
        }
        return geminiTextResponse('C succeeds after hard quota rotation');
      },
    });
    const lease = createLease(accounts.map((id) => createAccount(id)));
    const result = request(createGateway(upstream, lease), 'chat').then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({
      value: { choices: [{ message: { content: 'C succeeds after hard quota rotation' } }] },
    });
    expect(upstream.calls.map((call) => call.accessToken)).toEqual(
      accounts.slice(0, 3).map((id) => `access-${id}`),
    );
  });
});
