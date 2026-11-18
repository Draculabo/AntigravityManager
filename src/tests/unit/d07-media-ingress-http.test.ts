// @vitest-environment node
import { createServer, request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { createFastifyAdapter } from '@/server/main';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { registerTrafficAuditHttpHooks } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { trafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import { OpenAIService } from '@/server/gateway/modules/openai/openai.service';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIResponsesController } from '@/server/gateway/modules/openai/responses/openai-responses.controller';
import { OpenAIMediaController } from '@/server/gateway/modules/openai/openai-media.controller';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { PIXEL_PNG } from '../fixtures/image-content';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: (token: string) => token === 'synthetic-opencode-gzip' },
}));
vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'd07-test/1.0',
}));

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const apps: NestFastifyApplication[] = [];
const upstreamCleanup: Array<() => void | Promise<void>> = [];
const key = 'synthetic-d07-key';
const fixtureBody = { model: 'gemini-3-flash', input: 'Review this screenshot', store: false };
const privateText = 'provider refusal body with internal diagnostic detail';

afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const close of upstreamCleanup.splice(0).reverse()) {
      await close();
    }
  } finally {
    setServerConfig(previous);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

async function fixture(
  upstreamBody: unknown = geminiTextResponse('Received'),
  bodyLimit?: number,
  realUpstream = false,
  observeParsedBodyStream?: (stream: NodeJS.ReadableStream) => void,
) {
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: key });
  const audit = vi.spyOn(trafficAuditService, 'startParent').mockReturnValue(null);
  const upstream = createUpstream({
    generate: upstreamBody,
    streamFrames: [{ response: upstreamBody }],
  });
  const lease = createLease([createAccount('d07-fixture')]);
  const wireCalls: string[] = [];
  let gateway = createGateway(upstream, lease);
  if (realUpstream) {
    const server = createServer((req, res) => {
      req.resume();
      req.once('end', () => {
        const url = req.url ?? '';
        wireCalls.push(url);
        const stream = url.includes(':streamGenerateContent');
        res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
        const body = JSON.stringify({ response: upstreamBody });
        res.end(stream ? `data: ${body}\n\n` : body);
      });
    });
    upstreamCleanup.push(async () => {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected an allocated loopback port');
    }
    vi.stubEnv('PROXY_INTERNAL_BASE_URLS', `http://127.0.0.1:${address.port}/v1internal`);
    vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
    const client = new GeminiClient({ capture: vi.fn() } as never);
    upstreamCleanup.push(() => client.onModuleDestroy());
    gateway = createGateway(client as never, lease);
  }
  @Module({
    controllers: [OpenAIResponsesController, OpenAIMediaController],
    providers: [
      ProxyGuard,
      OpenAIOperations,
      { provide: OpenAIService, useValue: gateway.openAIService },
    ],
  })
  class MediaFixtureModule {}
  const adapter = createFastifyAdapter();
  if (observeParsedBodyStream) {
    adapter.getInstance().addHook('preParsing', (_request, _reply, stream, done) => {
      observeParsedBodyStream(stream);
      done(null, stream);
    });
  }
  if (bodyLimit !== undefined) {
    adapter.getInstance().addHook('onRoute', (route) => {
      route.bodyLimit = bodyLimit;
    });
  }
  registerTrafficAuditHttpHooks(adapter.getInstance());
  const app = await NestFactory.create<NestFastifyApplication>(MediaFixtureModule, adapter, {
    logger: false,
  });
  apps.push(app);
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const send = (path: string, body: Buffer, token = key, encoding = 'gzip', chunked = false) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        new URL(path, origin),
        {
          method: 'POST',
          agent: false,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json; charset=utf-8',
            'content-encoding': encoding,
            ...(chunked ? {} : { 'content-length': body.length }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.once('error', reject);
          res.once('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.setTimeout(5_000, () => req.destroy(new Error('Fixture request timed out')));
      req.once('error', reject);
      if (chunked) {
        req.write(body.subarray(0, 20));
        req.end(body.subarray(20));
      } else {
        req.end(body);
      }
    });
  return { send, upstream, audit, lease, origin, wireCalls };
}

const gzipJson = (value: object) => gzipSync(JSON.stringify(value));

it('releases the gzip stream on client disconnect before calling upstream', async () => {
  const started = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const { origin, send, upstream } = await fixture(undefined, undefined, false, (stream) => {
    stream.once('close', () => closed.resolve());
    started.resolve();
  });
  const req = request(new URL('/v1/responses', origin), {
    method: 'POST',
    agent: false,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    },
  });
  req.once('error', () => {});
  req.setTimeout(5_000, () => req.destroy());
  try {
    req.write(gzipJson(fixtureBody).subarray(0, 12));
    await started.promise;
  } finally {
    req.destroy();
  }
  await closed.promise;
  expect(upstream.calls).toEqual([]);
  expect((await send('/v1/responses', gzipJson(fixtureBody))).status).toBe(200);
});

it.each(['/v1/responses', '/responses'])(
  'decodes gzip on %s before auditing the request body',
  async (route) => {
    const { send, upstream, audit } = await fixture();
    const reply = await send(route, gzipJson(fixtureBody));
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('Received');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: fixtureBody, protocol: 'openai-responses' }),
    );
    expect(upstream.calls[0].body.request.contents).toEqual([
      { role: 'user', parts: [{ text: fixtureBody.input }] },
    ]);
  },
);

it('uses the same credentials before decompression and rejects unauthenticated malformed gzip', async () => {
  const { send, upstream } = await fixture();
  const bad = await send('/v1/responses', Buffer.from('not gzip'), 'invalid');
  expect(bad.status).toBe(401);
  expect(JSON.parse(bad.body)).toMatchObject({ error: { code: 'invalid_api_key' } });
  expect(upstream.calls).toEqual([]);
  expect(
    (await send('/v1/responses', gzipJson(fixtureBody), 'synthetic-opencode-gzip')).status,
  ).toBe(200);
});

it('rejects a blocked source before decompressing even with the correct key', async () => {
  const { send, upstream } = await fixture();
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    api_key: key,
    network: {
      ...DEFAULT_APP_CONFIG.proxy.network,
      ip_filter_mode: 'blocklist',
      ip_blocklist: ['127.0.0.1'],
    },
  });
  const response = await send('/v1/responses', Buffer.from('not gzip'));
  expect(response.status).toBe(403);
  expect(response.body).toContain('Request source is not allowed');
  expect(upstream.calls).toEqual([]);
});

it.runIf(Boolean(process.env.AGM_D07_CURL_EXE))(
  'accepts a gzip file from the installed curl client',
  async () => {
    const executable = process.env.AGM_D07_CURL_EXE;
    if (!executable) {
      throw new Error('Supply the local curl executable explicitly');
    }
    const { origin } = await fixture();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agm-d07-curl-'));
    const payload = path.join(dir, 'request.gz');
    try {
      await writeFile(payload, gzipJson(fixtureBody));
      const result = await promisify(execFile)(
        executable,
        [
          '-q',
          '--silent',
          '--show-error',
          '--fail-with-body',
          '--max-time',
          '5',
          '--noproxy',
          '*',
          '-H',
          `Authorization: Bearer ${key}`,
          '-H',
          'Content-Type: application/json',
          '-H',
          'Content-Encoding: gzip',
          '--data-binary',
          `@${payload}`,
          `${origin}/responses`,
        ],
        { windowsHide: true, timeout: 7_000 },
      );
      expect(result.stdout).toContain('Received');
    } finally {
      await rm(payload, { force: true });
      await rmdir(dir);
    }
  },
  10_000,
);

it('rejects damaged gzip, unsupported encodings and invalid decoded JSON', async () => {
  const { send, upstream } = await fixture();
  const damaged = await send('/v1/responses', gzipJson(fixtureBody).subarray(0, 12));
  expect(damaged.status).toBe(400);
  expect(damaged.body).toContain('Invalid gzip request body');
  expect((await send('/v1/responses', Buffer.from('{}'), key, 'br')).status).toBe(415);
  expect((await send('/v1/responses', gzipSync('{bad json'))).status).toBe(400);
  expect(upstream.calls).toEqual([]);
  expect(
    (await send('/v1/responses', Buffer.from(JSON.stringify(fixtureBody)), key, 'identity')).status,
  ).toBe(200);
});

it.each([false, true])(
  'enforces compressed and expanded limits before upstream work (chunked=%s)',
  async (chunked) => {
    const { send, upstream } = await fixture(undefined, 1024);
    const compressed = gzipJson({ ...fixtureBody, input: randomBytes(2048).toString('hex') });
    const expanded = gzipJson({ ...fixtureBody, input: 'A'.repeat(32 * 1024) });
    expect(compressed.length).toBeGreaterThan(1024);
    expect(expanded.length).toBeLessThan(1024);
    for (const body of [compressed, expanded]) {
      expect((await send('/v1/responses', body, key, 'gzip', chunked)).status).toBe(413);
    }
    expect(upstream.calls).toEqual([]);
  },
);

const cases = [
  [
    'image_policy_blocked',
    400,
    { promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: privateText } },
  ],
  [
    'image_policy_blocked',
    400,
    {
      candidates: [
        { finishReason: 'SAFETY', content: { role: 'model', parts: [{ text: privateText }] } },
      ],
    },
  ],
  ['image_text_only', 502, geminiTextResponse(privateText)],
  ['image_empty_response', 502, { candidates: [] }],
  [
    'image_missing_data',
    502,
    {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AAAA' } }],
          },
        },
      ],
    },
  ],
  [
    'image_missing_data',
    502,
    { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [] } }] },
  ],
] as const;

it.each(cases)('reports %s safely for image generation', async (code, status, providerResponse) => {
  const { send, lease, wireCalls } = await fixture(providerResponse, undefined, true);
  const reply = await send(
    '/v1/images/generations',
    Buffer.from(JSON.stringify({ prompt: 'Draw a fox' })),
    key,
    'identity',
  );
  expect(reply.status).toBe(status);
  expect(JSON.parse(reply.body)).toMatchObject({ error: { code } });
  expect(reply.body).not.toContain(privateText);
  expect(lease.penalties).toEqual([]);
  expect(wireCalls[0]).toContain(':generateContent');
});

it('returns the existing successful image response for gzipped generation requests', async () => {
  const encoded = PIXEL_PNG.toString('base64');
  const { send } = await fixture({
    candidates: [
      {
        finishReason: 'STOP',
        content: {
          role: 'model',
          parts: [{ inlineData: { mimeType: 'image/png', data: encoded } }],
        },
      },
    ],
  });
  const reply = await send('/v1/images/generations', gzipJson({ prompt: 'Draw a fox' }));
  expect(reply.status).toBe(200);
  expect(JSON.parse(reply.body)).toMatchObject({ data: [{ b64_json: encoded }] });
});
