// @vitest-environment node
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { name, version } from '../../../package.json';
import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import { OpenAIModelsController } from '@/server/gateway/modules/openai/openai-models.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIProbesController } from '@/server/gateway/modules/openai/openai-probes.controller';
import { OpenAIService } from '@/server/gateway/modules/openai/openai.service';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const apps: NestFastifyApplication[] = [];
const headers = { authorization: 'Bearer synthetic-probe-key' };
const routes = ['/props', '/v1/props', '/version', '/v1/version'];
const geminiProps = {
  default_generation_settings: { n_ctx: 1_048_576, n_predict: 65_536 },
  total_slots: 1,
  model_alias: 'gemini-3-flash',
};
const claudeProps = {
  default_generation_settings: { n_ctx: 200_000, n_predict: 64_000 },
  total_slots: 1,
  model_alias: 'claude-sonnet-4-6',
};

afterEach(async () => {
  try {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  } finally {
    setServerConfig(previous);
  }
});

async function createSurface(
  overrides: Partial<ProxyConfig> = {},
  rawModels = ['gemini-3-flash', 'claude-sonnet-4-6'],
) {
  const accounts = {
    getAllRawQuotaModels: vi.fn(() => new Set(rawModels)),
    getAllCollectedModels: vi.fn(() => new Set([...rawModels, 'synthetic-collected-only'])),
    getNextToken: vi.fn(() => {
      throw new Error('A metadata probe must not lease an account');
    }),
  };
  const generation = vi.fn(() => {
    throw new Error('A metadata probe must not generate');
  });
  @Module({
    controllers: [OpenAIModelsController, OpenAIProbesController],
    providers: [
      ProxyGuard,
      OpenAIOperations,
      { provide: OpenAIService, useValue: { handleChatCompletions: generation } },
      { provide: AccountLeaseService, useValue: accounts },
    ],
  })
  class ModelProbesHttpTestModule {}
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    api_key: 'synthetic-probe-key',
    only_raw_quota_models: true,
    ...overrides,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    ModelProbesHttpTestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  apps.push(app);
  await app.init();
  return { app, accounts, generation };
}

function notFound(model: string) {
  return {
    error: {
      code: 'model_not_found',
      message: `The model '${model}' does not exist or you do not have access to it.`,
      param: 'model',
      type: 'invalid_request_error',
    },
  };
}

describe('OpenAI service probes HTTP', () => {
  it.each(['/props', '/v1/props'])(
    '%s publishes the default and an explicit model',
    async (route) => {
      const { app } = await createSurface();
      const defaultReply = await app.inject({ url: route, headers });
      const namedReply = await app.inject({ url: `${route}?model=claude-sonnet-4-6`, headers });

      expect({ status: defaultReply.statusCode, body: defaultReply.json() }).toEqual({
        status: 200,
        body: geminiProps,
      });
      expect({ status: namedReply.statusCode, body: namedReply.json() }).toEqual({
        status: 200,
        body: claudeProps,
      });
    },
  );

  it.each(['/version', '/v1/version'])('%s publishes this application identity', async (route) => {
    const { app, accounts, generation } = await createSurface({}, []);
    const reply = await app.inject({ url: route, headers });

    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 200,
      body: { version, app: name, name },
    });
    expect(accounts.getAllRawQuotaModels).not.toHaveBeenCalled();
    expect(accounts.getNextToken).not.toHaveBeenCalled();
    expect(generation).not.toHaveBeenCalled();
  });

  it.each(routes)('%s requires the configured key and supports open mode', async (route) => {
    const { app } = await createSurface();
    for (const requestHeaders of [{}, { authorization: 'Bearer synthetic-wrong-key' }]) {
      const reply = await app.inject({ url: route, headers: requestHeaders });
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 401,
        body: {
          error: {
            code: 'invalid_api_key',
            message: 'API key validation failed',
            param: null,
            type: 'invalid_request_error',
          },
        },
      });
    }
    setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: '', only_raw_quota_models: true });
    const open = await app.inject({ url: route });
    expect({ status: open.statusCode, body: open.json() }).toEqual({
      status: 200,
      body: route.endsWith('props') ? geminiProps : { version, app: name, name },
    });
  });

  it.each(['/props', '/v1/props'])('%s rejects malformed and unpublished models', async (route) => {
    const { app } = await createSurface();
    for (const query of ['model=', 'model=gemini-3-flash&model=claude-sonnet-4-6']) {
      const reply = await app.inject({ url: `${route}?${query}`, headers });
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 400,
        body: {
          error: {
            code: 'invalid_parameter',
            message: 'model must be a single non-empty string.',
            param: 'model',
            type: 'invalid_request_error',
          },
        },
      });
    }
    for (const model of ['unknown-gpt-custom', 'gemini-3-flash-preview', 'Gemini-3-Flash']) {
      const reply = await app.inject({ url: `${route}?model=${model}`, headers });
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 404,
        body: notFound(model),
      });
    }
  });

  it('keeps props, list and retrieve consistent for a configured alias', async () => {
    const { app, accounts, generation } = await createSurface({
      only_raw_quota_models: false,
      model_aliases: [{ alias: 'my-claude', target: 'claude-sonnet-4-6', enabled: true }],
    });
    const listed = await app.inject({ url: '/v1/models', headers });
    const metadata = {
      id: 'my-claude',
      object: 'model',
      created: 1770652800,
      owned_by: 'antigravity',
      context_length: 200_000,
      max_context_length: 200_000,
      max_input_tokens: 200_000,
      max_model_len: 200_000,
      max_tokens: 200_000,
      max_completion_tokens: 64_000,
      max_output_tokens: 64_000,
    };
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ data: unknown[] }>().data).toContainEqual(metadata);
    const retrieved = await app.inject({ url: '/v1/models/my-claude', headers });
    expect({ status: retrieved.statusCode, body: retrieved.json() }).toEqual({
      status: 200,
      body: metadata,
    });
    for (const route of ['/props', '/v1/props']) {
      const reply = await app.inject({ url: `${route}?model=my-claude&autoload=false`, headers });
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 200,
        body: { ...claudeProps, model_alias: 'my-claude' },
      });
    }
    expect(accounts.getAllCollectedModels).toHaveBeenCalled();
    expect(accounts.getAllRawQuotaModels).not.toHaveBeenCalled();
    expect(accounts.getNextToken).not.toHaveBeenCalled();
    expect(generation).not.toHaveBeenCalled();
  });

  it('keeps raw-only models authoritative and does not invent a missing default', async () => {
    const { app } = await createSurface(
      { model_aliases: [{ alias: 'my-claude', target: 'claude-sonnet-4-6', enabled: true }] },
      ['claude-sonnet-4-6'],
    );
    const listed = await app.inject({ url: '/v1/models', headers });
    expect(listed.json<{ data: Array<{ id: string }> }>().data.map((entry) => entry.id)).toEqual([
      'claude-sonnet-4-6',
    ]);
    for (const route of ['/props', '/v1/props']) {
      for (const [query, model] of [
        ['', 'gemini-3-flash'],
        ['?model=my-claude', 'my-claude'],
        ['?model=synthetic-collected-only', 'synthetic-collected-only'],
      ]) {
        const reply = await app.inject({ url: `${route}${query}`, headers });
        expect({ status: reply.statusCode, body: reply.json() }).toEqual({
          status: 404,
          body: notFound(model),
        });
      }
    }
  });

  it('identifies the gateway as llama.cpp through ordered model discovery over HTTP', async () => {
    const { app, accounts, generation } = await createSurface();
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const seen: Array<{ path: string; status: number }> = [];
    let serverType: string | undefined;
    for (const path of ['/api/v1/models', '/api/tags', '/v1/props', '/props', '/version']) {
      const reply = await fetch(`${base}${path}`, { headers });
      const text = await reply.text();
      seen.push({ path, status: reply.status });
      if (reply.status === 200 && text.includes('default_generation_settings')) {
        serverType = 'llamacpp';
        expect(JSON.parse(text)).toEqual(geminiProps);
        break;
      }
    }
    expect({ seen, serverType }).toEqual({
      seen: [
        { path: '/api/v1/models', status: 404 },
        { path: '/api/tags', status: 404 },
        { path: '/v1/props', status: 200 },
      ],
      serverType: 'llamacpp',
    });
    const listingReply = await fetch(`${base}/v1/models`, { headers });
    const listed = z
      .object({ data: z.array(z.object({ id: z.string() })) })
      .parse(await listingReply.json());
    expect({ status: listingReply.status, ids: listed.data.map((item) => item.id) }).toEqual({
      status: 200,
      ids: ['claude-sonnet-4-6', 'gemini-3-flash'],
    });
    const props = await fetch(`${base}/props?model=claude-sonnet-4-6`, { headers });
    const body: unknown = await props.json();
    expect({ status: props.status, body }).toEqual({ status: 200, body: claudeProps });
    expect(accounts.getNextToken).not.toHaveBeenCalled();
    expect(generation).not.toHaveBeenCalled();
  });
});
