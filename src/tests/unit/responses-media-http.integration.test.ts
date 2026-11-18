// @vitest-environment node
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_APP_CONFIG, type ImageSchedulerConfig } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { registerModelRouteBodyLimits } from '@/server/main';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { OpenAIService } from '@/server/gateway/modules/openai/openai.service';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIResponsesController } from '@/server/gateway/modules/openai/responses/openai-responses.controller';
import { inferProtocol } from '@/modules/proxy-gateway/audit/traffic-audit-http-metadata';
import { classifyHttpTraffic } from '@/modules/proxy-gateway/audit/traffic-classifier';
import { PIXEL_PNG, PIXEL_GIF, pngWithBytes } from '../fixtures/image-content';
import {
  createAccount,
  createGateway,
  createLease,
  geminiTextResponse,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));
vi.mock('@/server/gateway/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'responses-media-test/0.0.0',
  buildContentRequestUserAgent: () => 'responses-media-test/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));
vi.setConfig({ testTimeout: 20_000 });

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const cleanup: Array<() => Promise<void> | void> = [];
const WireBody = z.object({
  request: z.object({
    contents: z.array(
      z.object({
        role: z.string(),
        parts: z.array(
          z
            .object({
              text: z.string().optional(),
              inlineData: z.object({ mimeType: z.string(), data: z.string() }).optional(),
              functionResponse: z
                .object({ name: z.string(), id: z.string().optional() })
                .passthrough()
                .optional(),
            })
            .passthrough(),
        ),
      }),
    ),
  }),
});
type WireBody = z.infer<typeof WireBody>;
const image = (data: Buffer) => ({
  type: 'input_image',
  image_url: `data:image/png;base64,${data.toString('base64')}`,
});
const user = (data: Buffer) => ({
  role: 'user',
  content: [{ type: 'input_text', text: 'Inspect screenshot' }, image(data)],
});
const toolRound = (data: Buffer) => [
  { type: 'function_call', name: 'capture', call_id: 'capture-1', arguments: '{}' },
  { type: 'function_call_output', call_id: 'capture-1', output: [image(data)] },
];

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) {
      await close();
    }
  } finally {
    setServerConfig(previous);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
});

async function fixture(window: Partial<ImageSchedulerConfig> = {}) {
  const seen: WireBody[] = [];
  const upstream = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      seen.push(WireBody.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      const result = geminiTextResponse('Screenshot inspected');
      if (request.url?.includes(':streamGenerateContent')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify(geminiStreamFrame(result))}\n\n`);
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ response: result }));
      }
    } catch {
      response.writeHead(500);
      response.end('Fixture rejected request');
    }
  });
  cleanup.push(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const address = upstream.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected loopback port');
  }
  vi.stubEnv('PROXY_INTERNAL_BASE_URLS', `http://127.0.0.1:${address.port}/v1internal`);
  vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    api_key: 'synthetic-media-key',
    image_scheduler: {
      ...DEFAULT_APP_CONFIG.proxy.image_scheduler,
      send_window_enabled: true,
      send_window_count: 1,
      ...window,
    },
    experimental: { ...DEFAULT_APP_CONFIG.proxy.experimental, context_cache_enabled: false },
  });
  const client = new GeminiClient({ capture: vi.fn() } as never);
  cleanup.push(() => client.onModuleDestroy());
  const lease = createLease([createAccount('responses-media')]);
  const gateway = createGateway(client as never, lease);
  @Module({
    controllers: [OpenAIResponsesController],
    providers: [
      ProxyGuard,
      OpenAIOperations,
      { provide: OpenAIService, useValue: gateway.openAIService },
    ],
  })
  class ResponsesMediaModule {}
  const adapter = new FastifyAdapter();
  registerModelRouteBodyLimits(adapter.getInstance());
  const app = await NestFactory.create<NestFastifyApplication>(ResponsesMediaModule, adapter, {
    logger: false,
  });
  cleanup.push(() => app.close());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const send = (
    input: unknown[],
    options: {
      stream?: boolean;
      route?: string;
      key?: string;
      store?: boolean;
      previous_response_id?: string;
    } = {},
  ) =>
    fetch(`${base}${options.route ?? '/v1/responses'}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.key ?? 'synthetic-media-key'}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gemini-3-flash',
        input,
        stream: options.stream ?? false,
        store: options.store ?? false,
        previous_response_id: options.previous_response_id,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  return { send, seen, lease, base };
}

function sentImages(body: WireBody) {
  return body.request.contents
    .flatMap((content) => content.parts)
    .flatMap((part) => (part.inlineData ? [part.inlineData.data] : []));
}

describe('Responses full-history media through HTTP and the real upstream client', () => {
  it.runIf(Boolean(process.env.AGM_CODEX_EXE))(
    'accepts a screenshot from an installed Codex client using an isolated profile',
    async () => {
      const executable = process.env.AGM_CODEX_EXE;
      if (!executable) {
        throw new Error('The installed client path must be explicitly supplied');
      }
      const { base, seen } = await fixture();
      const directory = await mkdtemp(path.join(os.tmpdir(), 'agm-d06-codex-'));
      cleanup.push(async () => {
        if (
          path.dirname(directory) !== path.resolve(os.tmpdir()) ||
          !path.basename(directory).startsWith('agm-d06-codex-')
        ) {
          throw new Error('Unexpected isolated client directory');
        }
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
      });
      const screenshot = path.join(directory, 'screenshot.png');
      await writeFile(screenshot, PIXEL_PNG);
      const execution = promisify(execFile)(
        executable,
        [
          'exec',
          '--skip-git-repo-check',
          '--ephemeral',
          '--json',
          '--sandbox',
          'read-only',
          '-C',
          directory,
          '--image',
          screenshot,
          '-c',
          'model_provider="d06_fixture"',
          '-c',
          'model="gemini-3-flash"',
          '-c',
          'model_providers.d06_fixture.name="D06 local fixture"',
          '-c',
          `model_providers.d06_fixture.base_url="${base}"`,
          '-c',
          'model_providers.d06_fixture.wire_api="responses"',
          '-c',
          'model_providers.d06_fixture.env_key="AGM_D06_TEST_KEY"',
          '-c',
          'model_providers.d06_fixture.requires_openai_auth=false',
          '-c',
          'analytics.enabled=false',
          '-c',
          'feedback.enabled=false',
          'Inspect the attached screenshot. Reply in one short sentence.',
        ],
        {
          env: { ...process.env, CODEX_HOME: directory, AGM_D06_TEST_KEY: 'synthetic-media-key' },
          cwd: directory,
          windowsHide: true,
          timeout: 35_000,
          maxBuffer: 128 * 1024,
        },
      );
      execution.child.stdin?.end();
      const result = await execution;
      expect(result.stdout).toContain('Screenshot inspected');
      expect(seen).toHaveLength(1);
      expect(sentImages(seen[0])).toEqual([PIXEL_PNG.toString('base64')]);
    },
    45_000,
  );

  it('retains the hard image count for the current user turn', async () => {
    const { send, seen } = await fixture();
    const response = await send([
      { role: 'user', content: Array.from({ length: 17 }, () => image(PIXEL_PNG)) },
    ]);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Too many input images');
    expect(seen).toEqual([]);
  });

  it('uses the configured memory window to trim historical images', async () => {
    const { send, seen } = await fixture({
      send_window_strategy: 'memory',
      send_window_memory_mib: 1,
    });
    const response = await send([
      user(pngWithBytes(2 * 1024 * 1024)),
      { role: 'assistant', content: 'Old screenshot inspected' },
      user(PIXEL_PNG),
    ]);
    expect(response.status).toBe(200);
    await response.text();
    expect(sentImages(seen[0])).toEqual([PIXEL_PNG.toString('base64')]);
  });

  it('retains the existing unknown-parent error on the root alias', async () => {
    const { send, seen } = await fixture();
    const response = await send([{ role: 'user', content: 'Continue' }], {
      route: '/responses',
      previous_response_id: 'resp_missing',
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('previous_response_id');
    expect(seen).toEqual([]);
  });
  it.each([false, true])(
    'trims full replay before aggregate admission (stream=%s)',
    async (stream) => {
      const { send, seen } = await fixture();
      const large = pngWithBytes(12 * 1024 * 1024);
      const response = await send(
        [
          user(large),
          { role: 'assistant', content: 'First inspected' },
          user(large),
          { role: 'assistant', content: 'Second inspected' },
          user(large),
        ],
        { stream },
      );
      expect(response.status).toBe(200);
      const output = await response.text();
      expect(output).toContain(stream ? 'response.completed' : 'Screenshot inspected');
      expect(seen).toHaveLength(1);
      expect(sentImages(seen[0])).toEqual([large.toString('base64')]);
      expect(JSON.stringify(seen[0])).toContain('First inspected');
      expect(JSON.stringify(seen[0])).toContain('Second inspected');
    },
  );

  it('protects both the latest user image and the following tool screenshot in both windows', async () => {
    const { send, seen } = await fixture();
    const response = await send([
      user(pngWithBytes(120)),
      { role: 'assistant', content: 'Old inspected' },
      user(PIXEL_PNG),
      ...toolRound(PIXEL_GIF),
    ]);
    expect(response.status).toBe(200);
    await response.text();
    expect(sentImages(seen[0])).toEqual([
      PIXEL_PNG.toString('base64'),
      PIXEL_GIF.toString('base64'),
    ]);
    expect(
      seen[0].request.contents
        .flatMap((item) => item.parts)
        .filter((part) => part.functionResponse)
        .map((part) => part.functionResponse),
    ).toEqual([{ name: 'capture', id: 'capture-1', response: { result: '' } }]);
  });

  it('retains hard aggregate admission when the window is disabled', async () => {
    const { send, seen } = await fixture({ send_window_enabled: false });
    const large = pngWithBytes(12 * 1024 * 1024);
    const response = await send([
      user(large),
      { role: 'assistant', content: 'old' },
      user(large),
      { role: 'assistant', content: 'old' },
      user(large),
    ]);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Total input image data is too large');
    expect(seen).toEqual([]);
  });

  it('rejects a current user and following tool round above the hard aggregate budget', async () => {
    const { send, seen } = await fixture();
    const large = pngWithBytes(17 * 1024 * 1024);
    const response = await send([user(large), ...toolRound(large)]);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Total input image data is too large');
    expect(seen).toEqual([]);
  });

  it('reports a current-turn memory window violation as a client error', async () => {
    const { send, seen } = await fixture({
      send_window_strategy: 'memory',
      send_window_memory_mib: 1,
    });
    const response = await send([user(pngWithBytes(2 * 1024 * 1024))]);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Current request images exceed');
    expect(seen).toEqual([]);
  });

  it('reports the same client error for a current screenshot extracted from tool text', async () => {
    const { send, seen, lease } = await fixture({
      send_window_strategy: 'memory',
      send_window_memory_mib: 1,
    });
    const screenshot = pngWithBytes(2 * 1024 * 1024).toString('base64');
    const response = await send([
      { role: 'user', content: 'Inspect the next tool screenshot' },
      { type: 'function_call', name: 'capture', call_id: 'capture-1', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'capture-1',
        output: `![screenshot](data:image/png;base64,${screenshot})`,
      },
    ]);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Current request images exceed');
    expect(seen).toEqual([]);
    expect(lease.penalties).toEqual([]);
  });

  it('validates single historical images even when the window could discard them', async () => {
    const { send, seen } = await fixture();
    const response = await send([
      user(pngWithBytes(20 * 1024 * 1024 + 1)),
      { role: 'assistant', content: 'old' },
      user(PIXEL_PNG),
    ]);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Input image is too large');
    expect(seen).toEqual([]);
  });

  it('windows stored history and restores its original media when the window is disabled', async () => {
    const { send, seen } = await fixture();
    const first = await send([user(PIXEL_PNG)], { store: true });
    const id = z.object({ id: z.string() }).parse(await first.json()).id;
    const second = await send([user(PIXEL_GIF)], { previous_response_id: id });
    expect(second.status).toBe(200);
    await second.text();
    expect(sentImages(seen[1])).toEqual([PIXEL_GIF.toString('base64')]);
    setServerConfig({
      ...getServerConfig()!,
      image_scheduler: { ...DEFAULT_APP_CONFIG.proxy.image_scheduler, send_window_enabled: false },
    });
    const third = await send([{ role: 'user', content: 'Compare history' }], {
      previous_response_id: id,
    });
    expect(third.status).toBe(200);
    await third.text();
    expect(sentImages(seen[2])).toEqual([PIXEL_PNG.toString('base64')]);
  });

  it.each([false, true])(
    'serves the root alias with Responses output (stream=%s)',
    async (stream) => {
      const { send, seen } = await fixture();
      const response = await send([user(PIXEL_PNG)], { route: '/responses', stream });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        stream ? 'response.completed' : 'Screenshot inspected',
      );
      expect(seen).toHaveLength(1);
      expect(inferProtocol('/responses?session_id=fixture')).toBe('openai-responses');
      expect(classifyHttpTraffic('POST', '/responses')).toBe('model');
    },
  );

  it('enforces the existing key guard on the root alias before upstream work', async () => {
    const { send, seen } = await fixture();
    const response = await send([user(PIXEL_PNG)], {
      route: '/responses',
      key: 'wrong-fixture-key',
    });
    expect(response.status).toBe(401);
    await response.text();
    expect(seen).toEqual([]);
  });
});
