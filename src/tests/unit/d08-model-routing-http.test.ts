// @vitest-environment node
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { OpenAIChatController } from '@/server/gateway/modules/openai/openai-chat.controller';
import { OpenAIModelsController } from '@/server/gateway/modules/openai/openai-models.controller';
import { OpenAIProbesController } from '@/server/gateway/modules/openai/openai-probes.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIService } from '@/server/gateway/modules/openai/openai.service';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import { AccountLeaseModelPolicy } from '@/server/gateway/modules/account-lease/policies/account-lease-model.policy';
import type { AccountLeaseTokenData } from '@/server/gateway/modules/account-lease/interfaces/account-lease-token-types';
import { updateDynamicForwardingRules } from '@/modules/proxy-gateway/antigravity/ModelMapping';
import {
  createAccount,
  createGateway,
  createLease,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));
vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'd08-test/1.0',
}));

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const cleanup: Array<() => void | Promise<void>> = [];
const key = 'synthetic-d08-key';
const headers = { authorization: `Bearer ${key}` };
const WireBody = z.object({ model: z.string(), request: z.unknown() });

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

async function fixture(models = ['gemini-3.1-pro-low']) {
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    api_key: key,
    model_aliases: [
      { alias: 'd08-client', target: 'gemini-3.1-pro-low', enabled: true },
      { alias: 'd08-retired-target', target: 'gemini-3.1-pro-high', enabled: true },
      { alias: 'd08-retired-http', target: 'claude-sonnet-4-6-thinking', enabled: true },
      { alias: 'claude-d08', target: 'claude-sonnet-4-6-thinking', enabled: true },
    ],
  });
  const wire: Array<{ body: z.infer<typeof WireBody>; beta?: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const beta = req.headers['anthropic-beta'];
    wire.push({
      body: WireBody.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))),
      ...(typeof beta === 'string' ? { beta } : {}),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ response: geminiTextResponse('D08 accepted') }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected an allocated loopback port');
  }
  vi.stubEnv('PROXY_INTERNAL_BASE_URLS', `http://127.0.0.1:${address.port}/v1internal`);
  vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
  const account = createAccount('d08-account');
  const token: AccountLeaseTokenData = {
    ...account.token,
    account_id: account.id,
    email: 'synthetic@example.invalid',
    model_quotas: Object.fromEntries(models.map((model) => [model, 100])),
    model_limits: {},
    model_reset_times: {},
    model_forwarding_rules: {},
    quota: {
      models: Object.fromEntries(
        models.map((model) => [
          model,
          {
            percentage: 100,
            resetTime: '',
            supports_images: true,
            supports_thinking: true,
            max_output_tokens: 65535,
          },
        ]),
      ),
    },
  };
  const policy = new AccountLeaseModelPolicy({
    getTokenCache: () => new Map([[account.id, token]]),
    logger: { log: vi.fn() },
    isModelBlocked: () => false,
  });
  const lease = createLease([account]);
  lease.resolveDynamicModelForAccount.mockImplementation(
    (id, model, effort?: string, physicalTarget = false) =>
      policy.resolveDynamicModelForAccount(id, model, effort, physicalTarget),
  );
  const discovery = {
    ...lease,
    getAllCollectedModels: () => policy.getAllCollectedModels(),
    getAllRawQuotaModels: () => policy.getAllRawQuotaModels(),
    getModelDiscoveryCapabilities: (model: string, physicalTarget = false) =>
      policy.getModelDiscoveryCapabilities(model, physicalTarget),
  };
  const client = new GeminiClient({ capture: vi.fn() } as never);
  cleanup.push(() => client.onModuleDestroy());
  const gateway = createGateway(client as never, lease);
  @Module({
    controllers: [
      OpenAIChatController,
      OpenAIModelsController,
      OpenAIProbesController,
      GeminiController,
      AnthropicController,
    ],
    providers: [
      ProxyGuard,
      OpenAIOperations,
      { provide: OpenAIService, useValue: gateway.openAIService },
      { provide: GeminiService, useValue: gateway.geminiService },
      { provide: AnthropicService, useValue: gateway.anthropicService },
      { provide: AccountLeaseService, useValue: discovery },
    ],
  })
  class D08HttpModule {}
  const app = await NestFactory.create<NestFastifyApplication>(
    D08HttpModule,
    new FastifyAdapter(),
    { logger: false },
  );
  cleanup.push(() => app.close());
  await app.listen(0, '127.0.0.1');
  return { app, wire, lease };
}

it('uses the same alias target limits in OpenAI, Gemini and props discovery', async () => {
  const { app, wire, lease } = await fixture();
  const listed = await app.inject({ url: '/v1/models', headers });
  const detail = await app.inject({ url: '/v1/models/d08-client', headers });
  const gemini = await app.inject({ url: '/v1beta/models/d08-client', headers });
  const props = await app.inject({ url: '/props?model=d08-client', headers });
  const expected = {
    id: 'd08-client',
    object: 'model',
    created: 1770652800,
    owned_by: 'antigravity',
    context_length: 1048576,
    max_context_length: 1048576,
    max_input_tokens: 1048576,
    max_model_len: 1048576,
    max_tokens: 1048576,
    max_completion_tokens: 65535,
    max_output_tokens: 65535,
    supports_images: true,
    supports_thinking: true,
    capability_source: 'provider-catalog',
  };
  expect(detail.json()).toEqual(expected);
  expect(listed.json().data).toContainEqual(expected);
  expect(gemini.json()).toEqual({
    name: 'models/d08-client',
    displayName: 'd08-client',
    description: '',
    inputTokenLimit: 1048576,
    outputTokenLimit: 65535,
    supports_images: true,
    supports_thinking: true,
    capability_source: 'provider-catalog',
    supportedGenerationMethods: ['generateContent', 'countTokens'],
    temperature: 1,
    topK: 64,
    topP: 0.95,
    version: '001',
  });
  expect(props.json()).toEqual({
    model_alias: 'd08-client',
    total_slots: 1,
    default_generation_settings: { n_ctx: 1048576, n_predict: 65535 },
  });
  expect(lease.getNextToken).not.toHaveBeenCalled();
  expect(wire).toEqual([]);
});

it('rejects retired models and aliases before leasing despite stale provider catalog data', async () => {
  const retired = ['gemini-pro-agent', 'gemini-3.1-pro-high'];
  const { app, wire, lease } = await fixture(['gemini-3.1-pro-low', ...retired]);
  const listed = await app.inject({ url: '/v1/models', headers });
  expect(listed.statusCode).toBe(200);
  expect(listed.json().data).toContainEqual(expect.objectContaining({ id: 'gemini-3.1-pro-low' }));
  for (const model of [...retired, 'd08-retired-target']) {
    expect(listed.json().data).not.toContainEqual(expect.objectContaining({ id: model }));
    const detail = await app.inject({ url: `/v1/models/${model}`, headers });
    expect(detail.statusCode).toBe(404);
    const completion = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: { model, messages: [{ role: 'user', content: 'Reply briefly' }] },
    });
    expect(completion.statusCode).toBe(404);
    expect(completion.json()).toMatchObject({ error: { code: 'model_not_found', param: 'model' } });

    const gemini = await app.inject({
      method: 'POST',
      url: `/v1beta/models/${model}:generateContent`,
      headers,
      payload: { contents: [{ role: 'user', parts: [{ text: 'Reply briefly' }] }] },
    });
    expect(gemini.statusCode).toBe(404);

    const anthropic = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers,
      payload: { model, max_tokens: 32, messages: [{ role: 'user', content: 'Reply briefly' }] },
    });
    expect(anthropic.statusCode).toBe(404);
  }
  expect(lease.getNextToken).not.toHaveBeenCalled();
  expect(wire).toEqual([]);

  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers,
    payload: {
      model: 'gemini-3.1-pro-low',
      messages: [{ role: 'user', content: 'Reply briefly' }],
    },
  });
  expect(response.statusCode).toBe(200);
  expect(wire.map((entry) => entry.body.model)).toEqual(['gemini-3.1-pro-low']);
});

it('accepts a structured OpenAI title request with reasoning disabled as a routing hint', async () => {
  const { app, wire } = await fixture(['gemini-3.8-flash-high']);
  const payload = {
    model: 'gemini-3.8-flash-high',
    messages: [
      { role: 'system', content: 'Return a short title.' },
      { role: 'user', content: 'Inspect a fixture.' },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'session_title',
        strict: true,
        schema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
          additionalProperties: false,
        },
      },
    },
  };
  for (const extra of [{}, { reasoning_effort: 'none' }]) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: { ...payload, ...extra },
    });
    expect(response.statusCode).toBe(200);
  }
  expect(wire.map(({ body }) => body.model)).toEqual([
    'gemini-3.8-flash-high',
    'gemini-3.8-flash-high',
  ]);
  expect(wire[0]?.body.request).toMatchObject({
    generationConfig: { responseMimeType: 'application/json' },
  });
  expect(wire[1]?.body.request).toEqual(wire[0]?.body.request);
});

it('uses exact replacement metadata and sends its target despite a runtime retirement rule', async () => {
  updateDynamicForwardingRules('d08-retired-http', 'gemini-3.1-pro-high');
  const { app, wire } = await fixture(['claude-sonnet-4-6-thinking']);
  const detail = await app.inject({ url: '/v1/models/d08-retired-http', headers });
  expect(detail.json()).toMatchObject({ context_length: 200000, max_completion_tokens: 64000 });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers,
    payload: { model: 'd08-retired-http', messages: [{ role: 'user', content: 'Reply briefly' }] },
  });
  expect(response.statusCode).toBe(200);
  expect(wire.map((entry) => entry.body.model)).toEqual(['claude-sonnet-4-6-thinking']);
});

it('routes Claude context suffixes and admits only supported Beta flags on the upstream wire', async () => {
  const { app, wire } = await fixture(['claude-sonnet-4-6-thinking']);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: {
      ...headers,
      'anthropic-beta': 'context-1m-2025-08-07,interleaved-thinking-2025-05-14,unknown-beta',
    },
    payload: {
      model: 'claude-d08[1m]',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Reply briefly' }],
    },
  });
  expect(response.statusCode).toBe(200);
  expect(wire.map((entry) => ({ model: entry.body.model, beta: entry.beta }))).toEqual([
    {
      model: 'claude-sonnet-4-6-thinking',
      beta: 'claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
    },
  ]);
});

it.runIf(Boolean(process.env.AGM_D08_CURL_EXE))(
  'serves a configured model to the installed curl client',
  async () => {
    const executable = process.env.AGM_D08_CURL_EXE;
    if (!executable) {
      throw new Error('Expected the installed curl path');
    }
    const { app, wire } = await fixture();
    const origin = await app.getUrl();
    const { stdout } = await promisify(execFile)(
      executable,
      [
        '-q',
        '--noproxy',
        '*',
        '--fail-with-body',
        '--silent',
        '--show-error',
        '-H',
        `Authorization: Bearer ${key}`,
        '-H',
        'Content-Type: application/json',
        '--data-binary',
        JSON.stringify({
          model: 'd08-client',
          messages: [{ role: 'user', content: 'Reply briefly' }],
        }),
        `${origin}/v1/chat/completions`,
      ],
      { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      choices: [{ message: { content: 'D08 accepted' } }],
    });
    expect(wire.map((entry) => entry.body.model)).toEqual(['gemini-3.1-pro-low']);
  },
);
