import axios, { AxiosHeaders } from 'axios';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import type { GeminiResponse } from '@/server/gateway/common/interfaces/request-interfaces';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', () => ({
  buildContentRequestUserAgent: () => 'controlled-phase-policy/0.0.0',
  resolveRequestUserAgent: async () => 'controlled-phase-policy/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));

beforeEach(() => {
  vi.useFakeTimers();
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, request_timeout: 120 });
  vi.stubEnv('PROXY_INTERNAL_BASE_URLS', 'https://phase-policy.invalid/v1internal');
  vi.spyOn(thoughtStoreService, 'prepareInternalRequest').mockResolvedValue(undefined);
  vi.spyOn(thoughtStoreService, 'captureGeminiResponse').mockImplementation(() => undefined);
});

afterEach(() => {
  setServerConfig(DEFAULT_APP_CONFIG.proxy);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture() {
  const upstream = new PassThrough();
  const post = vi.spyOn(axios, 'post').mockResolvedValue({
    status: 200,
    headers: new AxiosHeaders(),
    data: upstream,
  });
  const client = new GeminiClient({ capture: vi.fn() } as never);
  const stream = await client.streamGenerateInternal(
    {
      requestId: 'controlled-phase-policy',
      userAgent: 'controlled-phase-policy/0.0.0',
      model: 'gemini-3.8-flash-high',
      request: { contents: [{ role: 'user', parts: [{ text: 'Controlled delayed answer.' }] }] },
    },
    'synthetic-token',
  );
  if (!(stream instanceof Readable)) {
    throw new Error('Expected captured readable stream');
  }
  const errors: unknown[] = [];
  const chunks: string[] = [];
  stream.on('data', (chunk) => chunks.push(String(chunk)));
  stream.on('error', (error) => errors.push(error));
  const write = (response: GeminiResponse) =>
    upstream.write(`data: ${JSON.stringify({ response })}\n\n`);
  return { upstream, stream, post, errors, chunks, write };
}

it('keeps headers and heartbeats separate from the first meaningful output', async () => {
  const { upstream, stream, errors, chunks, write, post } = await fixture();
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    upstream.write(': heartbeat\n\n');
    await vi.advanceTimersByTimeAsync(60_001);
    expect(errors).toEqual([]);
    expect(stream.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(29_999);
    write({
      candidates: [
        { content: { role: 'model', parts: [{ text: 'delayed answer' }] }, finishReason: 'STOP' },
      ],
    });
    upstream.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(chunks.join('')).toContain('delayed answer');
    expect(errors).toEqual([]);
    expect(post).toHaveBeenCalledOnce();
  } finally {
    stream.destroy();
    upstream.destroy();
  }
});

it('uses the generation phase owner when two endpoints never return response headers', async () => {
  vi.stubEnv(
    'PROXY_INTERNAL_BASE_URLS',
    'https://phase-one.invalid/v1internal,https://phase-two.invalid/v1internal',
  );
  const post = vi.spyOn(axios, 'post').mockImplementation(
    (_url, _body, config) =>
      new Promise((_resolve, reject) => {
        config?.signal?.addEventListener?.('abort', () => reject(new axios.CanceledError()), {
          once: true,
        });
      }),
  );
  const client = new GeminiClient({ capture: vi.fn() } as never);
  const pending = client.streamGenerateInternal(
    {
      requestId: 'controlled-no-headers',
      userAgent: 'controlled-phase-policy/0.0.0',
      model: 'gemini-3.8-flash-high',
      request: { contents: [{ role: 'user', parts: [{ text: 'Controlled request.' }] }] },
    },
    'synthetic-token',
  );
  const expired = expect(pending).rejects.toMatchObject({
    name: 'GenerationDeadlineExceededError',
    code: 'ETIMEDOUT',
  });
  await vi.advanceTimersByTimeAsync(180_001);
  await expired;
  expect(post).toHaveBeenCalledOnce();
});

it.each([false, true])(
  'keeps Anthropic pings without an independent cutoff (thought first=%s)',
  async (thoughtFirst) => {
    const upstream = new PassThrough();
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ status: 200, headers: new AxiosHeaders(), data: upstream });
    const client = new GeminiClient({ capture: vi.fn() } as never);
    const service = createUpstream({});
    service.streamGenerateInternal.mockImplementation(async (...args) => {
      const result = await client.streamGenerateInternal(...args);
      if (!(result instanceof Readable)) {
        throw new Error('Expected captured readable stream');
      }
      return result;
    });
    const gateway = createGateway(service, createLease([createAccount('phase-anthropic')]));
    const pending = gateway.anthropicService.handleAnthropicMessages({
      model: 'gemini-3.8-flash-high',
      stream: true,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Controlled delayed answer.' }],
    });
    const send = (response: GeminiResponse) =>
      upstream.write(`data: ${JSON.stringify({ response })}\n\n`);
    if (thoughtFirst) {
      setTimeout(
        () =>
          send({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ thought: true, text: 'controlled reasoning' }],
                },
              },
            ],
          }),
        1_000,
      );
    }
    const answerAt = thoughtFirst ? 200_000 : 150_000;
    setTimeout(() => {
      send({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'delayed Anthropic answer' }] },
            finishReason: 'STOP',
          },
        ],
      });
      upstream.end();
    }, answerAt);
    const chunks: string[] = [];
    const complete = pending.then(async (result) => {
      if (!(result instanceof Observable)) {
        throw new Error('Expected Anthropic stream');
      }
      await new Promise<void>((resolve, reject) =>
        result.subscribe({
          next: (value: string) => chunks.push(value),
          complete: resolve,
          error: reject,
        }),
      );
    });
    const succeeded = expect(complete).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(answerAt + 1);
    await succeeded;
    expect(chunks.join('')).toContain('delayed Anthropic answer');
    expect(chunks.join('')).toContain('message_stop');
    expect(post).toHaveBeenCalledOnce();
  },
);

it('ends headers, heartbeats and metadata-only output at the initial 180-second window', async () => {
  const { upstream, stream, errors, write, post } = await fixture();
  try {
    for (let index = 0; index < 3; index++) {
      await vi.advanceTimersByTimeAsync(59_000);
      upstream.write(': heartbeat\n\n');
      write({ usageMetadata: { promptTokenCount: 7 } });
    }
    await vi.advanceTimersByTimeAsync(3_001);
    expect(errors).toMatchObject([{ name: 'GenerationDeadlineExceededError', code: 'ETIMEDOUT' }]);
    expect(stream.destroyed).toBe(true);
    expect(upstream.destroyed).toBe(true);
    expect(post).toHaveBeenCalledOnce();
  } finally {
    stream.destroy();
    upstream.destroy();
  }
});

it('keeps a responsive stream inside the original 270-second total budget', async () => {
  const { upstream, stream, errors, write, post } = await fixture();
  try {
    for (let index = 0; index < 5; index++) {
      write({ candidates: [{ content: { role: 'model', parts: [{ text: 'progress' }] } }] });
      await vi.advanceTimersByTimeAsync(index < 4 ? 60_000 : 30_001);
    }
    expect(errors).toMatchObject([{ name: 'GenerationDeadlineExceededError', code: 'ETIMEDOUT' }]);
    expect(upstream.destroyed).toBe(true);
    expect(post).toHaveBeenCalledOnce();
  } finally {
    stream.destroy();
    upstream.destroy();
  }
});

it('keeps a background warmup inside its configured non-generation transport limit', async () => {
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, request_timeout: 37 });
  const upstream = new PassThrough();
  const post = vi.spyOn(axios, 'post').mockResolvedValue({
    status: 200,
    headers: new AxiosHeaders(),
    data: upstream,
  });
  const client = new GeminiClient({ capture: vi.fn() } as never);
  await client.warmupInternal(
    {
      requestId: 'controlled-warmup',
      userAgent: 'controlled-phase-policy/0.0.0',
      model: 'gemini-3.8-flash-high',
      request: { contents: [{ role: 'user', parts: [{ text: 'Controlled warmup.' }] }] },
    },
    'synthetic-token',
  );
  expect(post).toHaveBeenCalledOnce();
  expect(post.mock.calls[0][2]).toMatchObject({ timeout: 37_000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(upstream.destroyed).toBe(true);
});
