import { Readable } from 'node:stream';
import { Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
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
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'controlled-affinity-test/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));

type Surface = 'chat' | 'responses' | 'anthropic' | 'gemini';
const surfaces: Surface[] = ['chat', 'responses', 'anthropic', 'gemini'];
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const services: AccountLeaseService[] = [];
async function fixture() {
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, quota_aware_scheduling_enabled: false });
  const accounts = ['commit-a', 'commit-b'].map((id) => createAccount(id));
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
    refreshAccessToken: vi.fn(),
    fetchProjectId: vi.fn(),
    fetchQuota: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const lease = new AccountLeaseService(store, upstream);
  services.push(lease);
  await lease.loadAccounts();
  return lease;
}
function request(
  gateway: ReturnType<typeof createGateway>,
  surface: Surface,
  stream: boolean,
  signal?: AbortSignal,
) {
  const model = 'gemini-3-flash';
  if (surface === 'anthropic') {
    return gateway.anthropicService.handleAnthropicMessages(
      {
        model,
        messages: [{ role: 'user', content: 'controlled commit' }],
        max_tokens: 100,
        stream,
      },
      undefined,
      signal,
    );
  }
  if (surface === 'gemini') {
    const body = { contents: [{ role: 'user', parts: [{ text: 'controlled commit' }] }] };
    return stream
      ? gateway.geminiService.handleGeminiStreamGenerateContent(model, body, signal)
      : gateway.geminiService.handleGeminiGenerateContent(model, body, 'generate-content', signal);
  }
  return gateway.openAIService.handleChatCompletions(
    { model, messages: [{ role: 'user', content: 'controlled commit' }], stream },
    surface === 'responses' ? 'responses' : 'chat-completions',
    signal,
  );
}
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.onModuleDestroy();
  }
  setServerConfig(previous);
  vi.useRealTimers();
});

describe('session commit at production protocol success boundaries', () => {
  it('shares account affinity across authenticated sibling steps and fails over if that account is unavailable', async () => {
    const lease = await fixture();
    const upstream = createUpstream({ generate: geminiTextResponse('step completed') });
    const gateway = createGateway(upstream, lease);
    const send = (sessionId: string) =>
      gateway.openAIService.handleChatCompletions(
        { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'controlled step' }] },
        'chat-completions',
        undefined,
        undefined,
        undefined,
        { headers: { authorization: 'Bearer synthetic-key', 'x-session-id': sessionId } },
      );

    await send('batch-a:step:1');
    await send('batch-a:step:2');
    await send('batch-b:step:1');
    lease.markAsForbidden('commit-a');
    await send('batch-a:step:3');

    expect(upstream.calls.map(({ accessToken }) => accessToken)).toEqual([
      'access-commit-a',
      'access-commit-a',
      'access-commit-b',
      'access-commit-b',
    ]);
  });

  it.each(['gemini'] as const)(
    'commits token-count affinity only after a valid count: %s',
    async (_surface) => {
      const lease = await fixture();
      const committed = vi.spyOn(lease, 'commitSession');
      const upstream = createUpstream({ countTokens: { totalTokens: 23 } });
      const gateway = createGateway(upstream, lease);
      const result = await gateway.geminiService.handleGeminiCountTokens('gemini-3-flash', {
        contents: [{ role: 'user', parts: [{ text: 'count controlled' }] }],
      });
      expect(result).toBe(23);
      expect(committed.mock.calls.map(([token]) => token.id)).toEqual(['commit-a']);
    },
  );
  it.each(surfaces.flatMap((surface) => [false, true].map((stream) => ({ surface, stream }))))(
    'publishes the selected lease only after upstream success: $surface stream=$stream',
    async ({ surface, stream }) => {
      const lease = await fixture();
      const committed = vi.spyOn(lease, 'commitSession');
      const selected = vi.spyOn(lease, 'getNextToken');
      const arrived = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const upstream = createUpstream({
        generate: async () => {
          arrived.resolve();
          await release.promise;
          return geminiTextResponse('committed');
        },
      });
      upstream.streamGenerateInternal.mockImplementation(async () => {
        arrived.resolve();
        await release.promise;
        return Readable.from([
          Buffer.from(
            'data: ' + JSON.stringify(geminiStreamFrame(geminiTextResponse('committed'))) + '\n\n',
          ),
        ]);
      });
      const pending = request(createGateway(upstream, lease), surface, stream);
      await arrived.promise;
      try {
        expect(committed).not.toHaveBeenCalled();
        const options = selected.mock.calls[0][0];
        expect((await lease.getNextToken(options))?.id).toBe('commit-b');
      } finally {
        release.resolve();
      }
      const result = await pending;
      expect(committed).toHaveBeenCalledOnce();
      expect(committed.mock.calls[0][0].id).toBe('commit-a');
      if (result instanceof Observable) {
        expect(await collect(result)).toContain('committed');
      }
      const options = selected.mock.calls[0][0];
      if (options?.sessionKey) {
        expect((await lease.getNextToken(options))?.id).toBe('commit-a');
      }
    },
  );

  it.each(surfaces)(
    'commits only the successful replacement after a rate-limit failure: %s',
    async (surface) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const lease = await fixture();
      const committed = vi.spyOn(lease, 'commitSession');
      const rejected = vi.spyOn(lease, 'rejectSession');
      const upstream = createUpstream({
        generate: () => {
          if (upstream.calls.length === 1) {
            throw new UpstreamRequestError({
              status: 429,
              message: 'RESOURCE_EXHAUSTED',
              body: 'RESOURCE_EXHAUSTED',
            });
          }
          return geminiTextResponse('replacement succeeded');
        },
      });
      const pending = request(createGateway(upstream, lease), surface, false);
      await vi.runAllTimersAsync();
      await pending;
      expect(upstream.calls.map((call) => call.accessToken)).toEqual([
        'access-commit-a',
        'access-commit-b',
      ]);
      expect(rejected.mock.calls.map(([token]) => token.id)).toEqual(['commit-a']);
      expect(committed.mock.calls.map(([token]) => token.id)).toEqual(['commit-b']);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('keeps an established stream binding after a later stream error and never replays', async () => {
    const lease = await fixture();
    const selected = vi.spyOn(lease, 'getNextToken');
    const committed = vi.spyOn(lease, 'commitSession');
    const stream = new Readable({ read() {} });
    const upstream = createUpstream({});
    upstream.streamGenerateInternal.mockResolvedValue(stream);
    const result = await request(createGateway(upstream, lease), 'chat', true);
    if (!(result instanceof Observable)) {
      throw new Error('Expected a stream');
    }
    const collected = collect(result);
    stream.destroy(new Error('controlled upstream interruption'));
    expect(await collected).toContain('upstream_stream_error');
    expect(committed).toHaveBeenCalledOnce();
    expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
    expect(upstream.generateInternal).not.toHaveBeenCalled();
    expect((await lease.getNextToken(selected.mock.calls[0][0]))?.id).toBe('commit-a');
  });

  it.each(surfaces)('does not commit an already cancelled provider result: %s', async (surface) => {
    const lease = await fixture();
    const committed = vi.spyOn(lease, 'commitSession');
    const controller = new AbortController();
    const upstream = createUpstream({
      generate: () => {
        controller.abort();
        return geminiTextResponse('late');
      },
    });
    await request(createGateway(upstream, lease), surface, false, controller.signal).catch(
      () => undefined,
    );
    expect(committed).not.toHaveBeenCalled();
  });
});
