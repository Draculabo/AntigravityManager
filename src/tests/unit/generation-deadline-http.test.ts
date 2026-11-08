import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/modules/proxy-gateway/server/common/upstream-4xx-capture.service';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';
import { logger } from '@/shared/logging/logger';

vi.mock('@/modules/proxy-gateway/server/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/modules/proxy-gateway/server/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'controlled-deadline-fixture',
  buildContentRequestUserAgent: () => 'controlled-deadline-fixture',
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setServerConfig(DEFAULT_APP_CONFIG.proxy);
});

it('cancels a real HTTP attempt with only the remaining endpoint budget', async () => {
  const received: string[] = [];
  let observeClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    observeClosed = resolve;
  });
  const server = createServer((request, response) => {
    received.push(request.url ?? '');
    request.resume();
    if (request.url?.startsWith('/first')) {
      const timer = setTimeout(() => {
        response.writeHead(503);
        response.end('{}');
      }, 600);
      response.once('close', () => clearTimeout(timer));
    } else {
      response.once('close', observeClosed);
      // Leave the second response open; only the caller's remaining deadline may close it.
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected isolated loopback listener');
  }
  const originalPost = axios.post.bind(axios);
  const post = vi
    .spyOn(axios, 'post')
    .mockImplementation((url, data, config) =>
      originalPost(url, data, { ...config, adapter: 'http' }),
    );
  vi.stubEnv(
    'PROXY_INTERNAL_BASE_URLS',
    `http://127.0.0.1:${address.port}/first,http://127.0.0.1:${address.port}/second`,
  );
  vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    vi.stubEnv(name, '');
  }
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, request_timeout: 1 });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(
      new GeminiClient(new Upstream4xxCaptureService()).generateInternal(
        {
          model: 'gemini-3-flash',
          requestId: 'deadline-http',
          userAgent: 'fixture',
          request: {
            contents: [{ role: 'user', parts: [{ text: 'Controlled deadline request.' }] }],
          },
        },
        'synthetic-token',
      ),
    ).rejects.toMatchObject({ name: 'GenerationDeadlineExceededError' });
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error('The cancelled HTTP response remained open')),
          3000,
        );
      }),
    ]);
    expect(received).toEqual(['/first:generateContent', '/second:generateContent']);
    const timeouts = post.mock.calls.map(([, , config]) => config?.timeout ?? Infinity);
    expect(timeouts[0]).toBeLessThanOrEqual(1000);
    expect(timeouts[1]).toBeGreaterThan(0);
    expect(timeouts[1]).toBeLessThan(450);
    expect(post.mock.calls[1]?.[2]?.signal?.aborted).toBe(true);
  } finally {
    clearTimeout(watchdog);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 15_000);

it.each([
  ['waiting_for_output', []],
  ['thinking_only', [{ thought: true, text: 'Synthetic reasoning' }]],
  ['output_started', [{ text: 'Synthetic answer' }]],
] as const)(
  'classifies %s and closes the real upstream stream at the deadline',
  async (phase, parts) => {
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let observeClosed = () => {};
    const closed = new Promise<void>((resolve) => {
      observeClosed = resolve;
    });
    const server = createServer((request, response) => {
      request.resume();
      response.once('close', observeClosed);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(': heartbeat\n\n');
      response.write(
        `data: ${JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts } }] } })}\n\n`,
      );
    });
    const client = new GeminiClient(new Upstream4xxCaptureService());
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected isolated loopback listener');
      }
      const originalPost = axios.post.bind(axios);
      vi.spyOn(axios, 'post').mockImplementation((url, data, config) =>
        originalPost(url, data, { ...config, adapter: 'http' }),
      );
      vi.stubEnv('PROXY_INTERNAL_BASE_URLS', `http://127.0.0.1:${address.port}`);
      vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
      for (const name of [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
      ]) {
        vi.stubEnv(name, '');
      }
      setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, request_timeout: 1 });
      const stream = await client.streamGenerateInternal(
        {
          model: 'gemini-3-flash',
          requestId: 'deadline-http-stream',
          userAgent: 'fixture',
          request: {
            contents: [{ role: 'user', parts: [{ text: 'Controlled stream request.' }] }],
          },
        },
        'synthetic-token',
      );
      if (!(stream instanceof Readable)) {
        throw new Error('Expected a Node upstream stream');
      }
      const failure = new Promise<unknown>((resolve) => stream.once('error', resolve));
      stream.resume();
      watchdog = setTimeout(
        () => stream.destroy(new Error('Stream deadline did not terminate')),
        3000,
      );
      // Axios destroys its source with ERR_CANCELED when the deadline owner aborts the signal.
      expect(await failure).toMatchObject({ code: 'ERR_CANCELED' });
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => reject(new Error('The upstream stream remained open')), 3000);
        }),
      ]);
      expect(
        warning.mock.calls.filter(([message]) => message === 'Generation stream deadline exceeded'),
      ).toEqual([['Generation stream deadline exceeded', { phase, requestId: null }]]);
      expect(stream.destroyed).toBe(true);
    } finally {
      clearTimeout(watchdog);
      client.onModuleDestroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  15_000,
);
