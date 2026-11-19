// @vitest-environment node
import { execFile } from 'node:child_process';
import { createServer, type RequestListener } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';
import { OpenAIChatController } from '@/server/gateway/modules/openai/openai-chat.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIService } from '@/server/gateway/modules/openai/openai.service';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { logger } from '@/shared/logging/logger';
import {
  createAccount,
  createGateway,
  createLease,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<typeof import('@/server/gateway/common/utils/request-user-agent')>()),
  resolveRequestUserAgent: async () => 'd10-loopback-fixture',
  buildContentRequestUserAgent: () => 'd10-loopback-fixture',
}));

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));

const key = 'synthetic-d10-key';
const previousConfig = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const cleanup: Array<() => Promise<void> | void> = [];

async function sendChat(url: string, content: string) {
  const body = JSON.stringify({
    model: 'gemini-3-flash',
    messages: [{ role: 'user', content }],
  });
  const curl = process.env.AGM_D10_CURL_EXE;
  if (!curl) {
    return fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  }
  const pending = promisify(execFile)(
    curl,
    [
      '--silent',
      '--show-error',
      '--noproxy',
      '*',
      '--max-time',
      '15',
      '--header',
      `Authorization: Bearer ${key}`,
      '--header',
      'Content-Type: application/json',
      '--data-binary',
      '@-',
      '--write-out',
      '\n%{http_code}',
      url,
    ],
    { windowsHide: true, timeout: 16_000 },
  );
  const stdin = pending.child.stdin;
  if (!stdin) {
    throw new Error('Expected piped curl stdin');
  }
  const [{ stdout }] = await Promise.all([pending, pipeline(Readable.from([body]), stdin)]);
  const separator = stdout.lastIndexOf('\n');
  return new Response(stdout.slice(0, separator), { status: Number(stdout.slice(separator + 1)) });
}

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) {
      await close();
    }
  } finally {
    setServerConfig(previousConfig);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
});

async function upstream(listener: RequestListener, endpoints = ['first']) {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a loopback listener');
  }
  vi.stubEnv('NO_PROXY', '127.0.0.1');
  vi.stubEnv('no_proxy', '127.0.0.1');
  vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
  vi.stubEnv(
    'PROXY_INTERNAL_BASE_URLS',
    endpoints.map((name) => `http://127.0.0.1:${address.port}/${name}`).join(','),
  );
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: key, request_timeout: 10 });
  const client = new GeminiClient(new Upstream4xxCaptureService());
  cleanup.push(() => client.onModuleDestroy());
  return client;
}

it.each([
  {
    status: 502,
    largeEndpoints: ['first', 'second', 'third'],
    smallEndpoints: ['first', 'second', 'third', 'fourth'],
  },
  {
    status: 503,
    largeEndpoints: ['first', 'first', 'second'],
    smallEndpoints: ['first', 'first', 'second', 'third', 'fourth'],
  },
])(
  'caps large UTF-8 physical sends and allows small sends after upstream $status',
  async ({ status, largeEndpoints, smallEndpoints }) => {
    const received: Array<{ path: string | undefined; bytes: number }> = [];
    const client = await upstream(
      (request, response) => {
        let bytes = 0;
        request.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
        });
        request.on('end', () => {
          received.push({ path: request.url, bytes });
          if (request.url?.startsWith('/fourth:')) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ response: geminiTextResponse('D10 accepted') }));
            return;
          }
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ error: { code: status, message: 'Synthetic endpoint failure' } }),
          );
        });
      },
      ['first', 'second', 'third', 'fourth'],
    );
    const lease = createLease([createAccount('d10-first'), createAccount('d10-spare')]);
    const gateway = createGateway(client as never, lease);
    @Module({
      controllers: [OpenAIChatController],
      providers: [
        ProxyGuard,
        OpenAIOperations,
        { provide: OpenAIService, useValue: gateway.openAIService },
      ],
    })
    class ReplayHttpModule {}
    const app = await NestFactory.create<NestFastifyApplication>(
      ReplayHttpModule,
      new FastifyAdapter({ bodyLimit: 8 * 1024 * 1024 }),
      { logger: false },
    );
    cleanup.push(() => app.close());
    await app.listen(0, '127.0.0.1');
    const url = `${await app.getUrl()}/v1/chat/completions`;

    const limit = 4 * 1024 * 1024;
    const large = await sendChat(url, '界'.repeat(Math.ceil(limit / 3)));
    expect(large.status).toBe(503);
    expect(await large.json()).toEqual({
      error: {
        message: 'The generation replay limit for large upstream requests was reached.',
        type: 'server_error',
        code: 'generation_replay_limit',
        param: null,
      },
    });
    expect(received.map(({ path }) => path)).toEqual(
      largeEndpoints.map((endpoint) => `/${endpoint}:generateContent`),
    );
    expect(received.every(({ bytes }) => bytes >= limit)).toBe(true);
    expect(lease.markModelSuccess).not.toHaveBeenCalled();
    expect(lease.markFromUpstreamError).not.toHaveBeenCalled();

    received.length = 0;
    const small = await sendChat(url, 'Small request');
    expect(small.status).toBe(200);
    expect(await small.text()).toContain('D10 accepted');
    expect(received.map(({ path }) => path)).toEqual(
      smallEndpoints.map((endpoint) => `/${endpoint}:generateContent`),
    );
    expect(received.every(({ bytes }) => bytes < limit)).toBe(true);
  },
  30_000,
);

it('keeps an automatic HTTP redirect from resending a large generation body', async () => {
  const paths: Array<string | undefined> = [];
  const client = await upstream((request, response) => {
    request.resume();
    request.once('end', () => {
      paths.push(request.url);
      if (request.url === '/first:generateContent') {
        response.writeHead(307, { location: '/redirect-target' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ response: geminiTextResponse('Redirect accepted') }));
    });
  });
  const generate = (text: string) =>
    client.generateInternal(
      {
        model: 'gemini-3-flash',
        requestId: 'd10-redirect-fixture',
        userAgent: 'fixture',
        request: { contents: [{ role: 'user', parts: [{ text }] }] },
      },
      'synthetic-token',
    );

  await expect(generate('界'.repeat(Math.ceil((4 * 1024 * 1024) / 3)))).rejects.toMatchObject({
    status: 307,
  });
  expect(paths).toEqual(['/first:generateContent']);
  await expect(generate('Small request')).resolves.toEqual(geminiTextResponse('Redirect accepted'));
  expect(paths).toEqual(['/first:generateContent', '/first:generateContent', '/redirect-target']);
}, 20_000);

it.each([false, true])('records actual HTTP stages with visible output=%s', async (visible) => {
  const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  const client = await upstream((request, response) => {
    request.resume();
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': keepalive\n\n');
      const part = visible ? { text: 'Visible output' } : { thought: true, text: 'Reasoning' };
      response.end(
        `data: ${JSON.stringify({
          response: {
            candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }],
          },
        })}\n\n`,
      );
    });
  });
  const stream = await client.streamGenerateInternal(
    {
      model: 'gemini-3-flash',
      requestId: 'd10-stage-fixture',
      userAgent: 'fixture',
      request: { contents: [{ role: 'user', parts: [{ text: 'Fixture input' }] }] },
    },
    'synthetic-token',
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  expect(Buffer.concat(chunks).toString('utf8')).toContain(
    visible ? 'Visible output' : 'Reasoning',
  );
  const stages = debug.mock.calls.filter(([name]) => name === 'Upstream generation stages');
  expect(stages).toEqual([
    [
      'Upstream generation stages',
      {
        requestId: undefined,
        attemptId: expect.any(String),
        uploadFinishedMs: expect.any(Number),
        responseHeadersMs: expect.any(Number),
        firstByteMs: expect.any(Number),
        firstUsableOutputMs: visible ? expect.any(Number) : null,
        version: 1,
      },
    ],
  ]);
});
