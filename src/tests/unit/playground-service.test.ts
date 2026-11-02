import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { PlaygroundService } from '@/modules/proxy-gateway/playground/playground.service';
import * as mainServer from '@/server/main';
import * as serverConfig from '@/server/server-config';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { createPlaygroundRouter } from '@/modules/proxy-gateway/playground/playground.router';
import { PLAYGROUND_MAX_COMPARE_ACCOUNTS } from '@/modules/proxy-gateway/playground/playground.schema';
import { createRouterClient } from '@orpc/server';

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const DONE = 'data: [DONE]\n\n';

function streamOf(chunks: string[]): AsyncIterable<string> {
  return (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

/** Serves a fixed clock so every derived timing is exact. */
function clockAt(times: number[]): () => number {
  let index = 0;
  return () => times[Math.min(index++, times.length - 1)];
}

function runningGateway() {
  return vi.spyOn(mainServer, 'getNestServerStatus').mockResolvedValue({
    running: true,
    port: 8045,
    base_url: 'http://localhost:8045',
    active_accounts: 1,
  });
}

function streamingResponse(chunks: string[], headers: Record<string, string> = {}) {
  return { status: 200, statusText: 'OK', headers, data: streamOf(chunks) } as never;
}

describe('PlaygroundService', () => {
  it('propagates cancellation and the configured deadline through the router to HTTP', async () => {
    runningGateway();
    vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
      ...DEFAULT_APP_CONFIG.proxy,
      request_timeout: 37,
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let forwardedSignal: AbortSignal | undefined;
    const post = vi.spyOn(axios, 'post').mockImplementation((_url, _body, config) => {
      forwardedSignal = config?.signal as AbortSignal;
      markStarted();
      return new Promise((_resolve, reject) => {
        forwardedSignal?.addEventListener('abort', () => reject(new axios.CanceledError()), {
          once: true,
        });
      });
    });
    const controller = new AbortController();
    const client = createRouterClient(createPlaygroundRouter(new PlaygroundService()));
    const execution = client.execute(
      { model: 'gemini-3-flash', prompt: 'Hi' },
      { signal: controller.signal },
    );
    await started;
    expect(post.mock.calls[0][2]).toMatchObject({
      timeout: 37000,
      proxy: false,
      responseType: 'stream',
    });
    controller.abort();
    await execution.catch(() => undefined);
    expect(forwardedSignal?.aborted).toBe(true);
  });

  it.each([2, PLAYGROUND_MAX_COMPARE_ACCOUNTS])(
    'returns validated comparison results for %i accounts through the public router',
    async (count) => {
      runningGateway();
      vi.spyOn(axios, 'post').mockImplementation(async () =>
        streamingResponse([sse({ choices: [{ delta: { content: 'Hello' } }] }), DONE]),
      );
      const client = createRouterClient(createPlaygroundRouter(new PlaygroundService()));
      const response = await client.compare({
        model: 'gemini-3-flash',
        prompt: 'Hi',
        accountIds: Array.from({ length: count }, (_, index) => 'account-' + index),
      });
      expect(response.results.map((entry) => entry.request?.accountId)).toEqual(
        Array.from({ length: count }, (_, index) => 'account-' + index),
      );
      expect(response.results.every((entry) => entry.success)).toBe(true);
    },
  );

  it('rejects a comparison larger than the account limit before any request', async () => {
    runningGateway();
    const post = vi.spyOn(axios, 'post');
    const input = {
      model: 'gemini-3-flash',
      prompt: 'Hi',
      accountIds: Array.from(
        { length: PLAYGROUND_MAX_COMPARE_ACCOUNTS + 1 },
        (_, index) => 'account-' + index,
      ),
    };
    await expect(new PlaygroundService().compare(input)).rejects.toThrow('At most');
    const client = createRouterClient(createPlaygroundRouter(new PlaygroundService()));
    await expect(client.compare(input)).rejects.toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ['data: not-json\n\n', 'Malformed completion stream event from API Proxy.'],
    [
      'data: {"choices":[{"delta":{"content":42}}]}\n\n',
      'Malformed completion stream event from API Proxy.',
    ],
    ['data: {"error":{"message":"upstream exploded"}}\n\n', 'upstream exploded'],
    [
      '<html>Error</html>',
      'The completion stream ended before the API Proxy finished the response.',
    ],
    [
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'The completion stream ended before the API Proxy finished the response.',
    ],
  ])('rejects a malformed or truncated stream: %j', async (body, message) => {
    runningGateway();
    vi.spyOn(axios, 'post').mockResolvedValue(streamingResponse([body]));
    const result = await new PlaygroundService().execute({
      model: 'gemini-3-flash',
      prompt: 'Hi',
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe(message);
  });

  let service: PlaygroundService;

  beforeEach(() => {
    service = new PlaygroundService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 503 error if gateway is not running', async () => {
    vi.spyOn(mainServer, 'getNestServerStatus').mockResolvedValue({
      running: false,
      port: 8045,
      base_url: 'http://localhost:8045',
      active_accounts: 0,
    });

    const result = await service.execute({
      model: 'gemini-3-flash',
      prompt: 'Hello world',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toContain('API Proxy is not running');
  });

  it('streams a prompt and reports every timing on the client clock', async () => {
    runningGateway();
    vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
      api_key: 'test-secret-key',
    } as never);

    const captured: {
      url?: string;
      headers: Record<string, string>;
      body?: Record<string, unknown>;
    } = { headers: {} };
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      captured.url = String(url);
      captured.headers = (config?.headers as Record<string, string>) ?? {};
      captured.body = body as Record<string, unknown>;
      return streamingResponse(
        [
          sse({ choices: [{ delta: { reasoning_content: 'Let me think' } }] }),
          sse({ choices: [{ delta: { content: 'Hello' } }] }),
          sse({ choices: [{ delta: { content: ' world' } }] }),
          sse({
            model: 'gemini-3-flash',
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 },
          }),
          DONE,
        ],
        {
          'x-antigravity-account-id': 'acc-1',
          'x-antigravity-account-email': 'user1@example.com',
          'x-timing-ttft-ms': '125.400',
        },
      );
    });

    service = new PlaygroundService(clockAt([1000, 1040, 1100, 1150, 1600, 1900, 2000]));
    const result = await service.execute({
      accountId: 'acc-1',
      model: 'gemini-3-flash',
      prompt: 'What is 2+2?',
      systemPrompt: 'Be concise.',
      temperature: 0.5,
    });

    expect(captured.url).toBe('http://localhost:8045/v1/chat/completions');
    expect(captured.headers['authorization']).toBe('Bearer test-secret-key');
    expect(captured.headers['x-antigravity-account-id']).toBe('acc-1');
    expect(captured.body?.stream).toBe(true);
    expect(captured.body?.messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'What is 2+2?' },
    ]);
    expect(captured.body?.temperature).toBe(0.5);

    expect(result).toMatchObject({
      success: true,
      status: 200,
      content: 'Hello world',
      thinkingContent: 'Let me think',
      attributedAccountId: 'acc-1',
      attributedAccountEmail: 'user1@example.com',
      model: 'gemini-3-flash',
      durationMs: 1000,
      responseStartedMs: 40,
      upstreamFirstByteMs: 125,
      firstReasoningDeltaMs: 100,
      firstTextDeltaMs: 150,
      completionTokens: 30,
      promptTokens: 10,
      totalTokens: 40,
      generationTokensPerSec: 60,
      e2eTokensPerSec: 30,
    });
  });

  it('never derives generation throughput from end-to-end time when usage is missing', async () => {
    runningGateway();
    vi.spyOn(axios, 'post').mockResolvedValue(
      streamingResponse([
        sse({ choices: [{ delta: { content: 'Hello' } }] }),
        sse({ choices: [{ delta: { content: ' world' } }] }),
        DONE,
      ]),
    );

    const result = await service.execute({ model: 'gemini-3-flash', prompt: 'Hi' });

    expect(result.success).toBe(true);
    expect(result.content).toBe('Hello world');
    expect(result.completionTokens).toBeUndefined();
    expect(result.generationTokensPerSec).toBeUndefined();
    expect(result.e2eTokensPerSec).toBeUndefined();
  });

  it('treats a reasoning-only stream as unmeasured for text and generation speed', async () => {
    runningGateway();
    vi.spyOn(axios, 'post').mockResolvedValue(
      streamingResponse([
        sse({ choices: [{ delta: { reasoning_content: 'Thinking' } }] }),
        sse({ choices: [], usage: { completion_tokens: 12 } }),
        DONE,
      ]),
    );

    service = new PlaygroundService(clockAt([0, 5, 10, 20, 100]));
    const result = await service.execute({ model: 'gemini-3-flash', prompt: 'Hi' });

    expect(result.success).toBe(true);
    expect(result.content).toBe('');
    expect(result.thinkingContent).toBe('Thinking');
    expect(result.firstReasoningDeltaMs).toBe(10);
    expect(result.firstTextDeltaMs).toBeUndefined();
    expect(result.generationTokensPerSec).toBeUndefined();
    expect(result.e2eTokensPerSec).toBe(120);
  });

  it('forwards reasoning effort and disable thinking flags to gateway body', async () => {
    runningGateway();

    const sent: Array<Record<string, unknown>> = [];
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      sent.push(body as Record<string, unknown>);
      return streamingResponse([sse({ choices: [{ delta: { content: 'No reasoning' } }] }), DONE]);
    });

    await service.execute({
      model: 'gemini-3.7-flash',
      prompt: 'Test',
      reasoningEffort: 'off',
    });
    expect(sent[0].reasoning_effort).toBeUndefined();
    expect(sent[0].thinking).toEqual({ type: 'disabled', budget_tokens: 0 });

    await service.execute({
      model: 'gemini-3.7-flash',
      prompt: 'Test',
      reasoningEffort: 'high',
    });
    expect(sent[1].reasoning_effort).toBe('high');
    expect(sent[1].thinking).toEqual({ type: 'enabled', effort: 'high' });
  });

  it('handles upstream 429 rate limit error gracefully', async () => {
    runningGateway();
    vi.spyOn(axios, 'post').mockResolvedValue({
      status: 429,
      statusText: 'Too Many Requests',
      headers: {
        'content-type': 'application/json',
        'x-antigravity-account-id': 'acc-limited',
      },
      data: streamOf([
        JSON.stringify({
          error: { message: 'Quota exceeded for model gemini-3-flash. Try again later.' },
        }),
      ]),
    } as never);

    const result = await service.execute({
      accountId: 'acc-limited',
      model: 'gemini-3-flash',
      prompt: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
    expect(result.error).toBe('Quota exceeded for model gemini-3-flash. Try again later.');
    expect(result.attributedAccountId).toBe('acc-limited');
  });

  it('keeps failed accounts inside a bounded comparison', async () => {
    runningGateway();
    let active = 0;
    let peak = 0;
    vi.spyOn(axios, 'post').mockImplementation(async (_url, _body, config) => {
      const target = (config?.headers as Record<string, string>)['x-antigravity-account-id'];
      if (target === 'acc-fail') {
        return {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'x-antigravity-account-id': 'acc-fail' },
          data: streamOf([JSON.stringify({ error: { message: 'Quota exhausted' } })]),
        } as never;
      }
      active += 1;
      peak = Math.max(peak, active);
      return {
        status: 200,
        statusText: 'OK',
        headers: {
          'x-antigravity-account-id': target,
          'x-antigravity-account-email': `${target}@example.com`,
        },
        data: (async function* () {
          try {
            await new Promise((resolve) => setTimeout(resolve, 5));
            yield sse({
              model: 'gemini-3-flash',
              choices: [{ delta: { content: `Response for ${target}` } }],
            });
            yield sse({ choices: [], usage: { completion_tokens: 5 } });
            yield DONE;
          } finally {
            active -= 1;
          }
        })(),
      } as never;
    });

    const accountIds = Array.from({ length: 6 }, (_, index) => `acc-${index}`);
    const compareRes = await service.compare({
      accountIds: [...accountIds, 'acc-fail'],
      model: 'gemini-3-flash',
      prompt: 'Compare ping',
    });

    expect(compareRes.results).toHaveLength(7);
    expect(compareRes.results.filter((entry) => entry.success)).toHaveLength(6);
    expect(compareRes.results[0].content).toBe('Response for acc-0');
    const failure = compareRes.results.find((entry) => entry.request?.accountId === 'acc-fail');
    expect(failure?.success).toBe(false);
    expect(failure?.status).toBe(429);
    expect(failure?.error).toBe('Quota exhausted');
    expect(peak).toBeLessThanOrEqual(4);
  });
});
