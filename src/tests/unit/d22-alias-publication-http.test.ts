import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG, type ModelAliasRoute } from '@/modules/config/types';
import { getConfiguredModelMapping } from '@/modules/config/model-aliases';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import { OpenAIModelsController } from '@/server/gateway/modules/openai/openai-models.controller';
import { OpenAIProbesController } from '@/server/gateway/modules/openai/openai-probes.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { ModelRoutingService } from '@/server/gateway/shared/services/model-routing.service';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const apps: NestFastifyApplication[] = [];
const headers = { authorization: 'Bearer synthetic-alias-key' };
vi.setConfig({ testTimeout: 15_000 });

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  setServerConfig(previous);
});

async function createSurface(
  onlyRaw = false,
  available: ReadonlySet<string> | null = new Set<string>(),
) {
  const accounts = {
    getAllRawQuotaModels: () => new Set(['gemini-3-flash', 'physical-overlap']),
    getAllCollectedModels: () => new Set(['gemini-3-flash', 'physical-overlap']),
    ...(available ? { getAvailableAdaptiveModels: () => available } : {}),
  };
  @Module({
    controllers: [
      GeminiController,
      AnthropicController,
      OpenAIModelsController,
      OpenAIProbesController,
    ],
    providers: [
      ProxyGuard,
      { provide: GeminiService, useValue: {} },
      { provide: AnthropicService, useValue: {} },
      { provide: AccountLeaseService, useValue: accounts },
      {
        provide: OpenAIOperations,
        useFactory: () => new OpenAIOperations({} as never, accounts as never),
      },
    ],
  })
  class AliasPublicationHttpModule {}
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    api_key: 'synthetic-alias-key',
    only_raw_quota_models: onlyRaw,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AliasPublicationHttpModule,
    new FastifyAdapter(),
    { logger: false },
  );
  apps.push(app);
  await app.init();
  return app;
}

function setRoutes(model_aliases: ModelAliasRoute[]) {
  setServerConfig({
    ...(getServerConfig() ?? DEFAULT_APP_CONFIG.proxy),
    model_aliases,
    custom_mapping: Object.fromEntries(
      model_aliases.filter((route) => route.enabled).map((route) => [route.alias, route.target]),
    ),
  });
}

async function readDirectories(app: NestFastifyApplication) {
  const replies = await Promise.all(
    ['/v1/models', '/v1beta/models', '/v1/models/claude'].map((url) =>
      app.inject({ url, headers }),
    ),
  );
  expect(replies.map((reply) => reply.statusCode)).toEqual([200, 200, 200]);
  return [
    replies[0].json().data.map((entry: { id: string }) => entry.id),
    replies[1].json().models.map((entry: { name: string }) => entry.name.replace(/^models\//, '')),
    replies[2].json().data.map((entry: { id: string }) => entry.id),
  ];
}

async function queryModel(app: NestFastifyApplication, model: string) {
  return Promise.all(
    [
      `/v1/models/${encodeURIComponent(model)}`,
      `/v1beta/models/${encodeURIComponent(model)}`,
      `/v1/models/claude/${encodeURIComponent(model)}`,
      `/props?model=${encodeURIComponent(model)}`,
      `/v1/props?model=${encodeURIComponent(model)}`,
    ].map((url) => app.inject({ url, headers })),
  );
}

describe('D22 alias publication HTTP', () => {
  it('publishes an explicitly public adaptive alias only while its pool resolves, without failing other models', async () => {
    const available = new Set<string>();
    const app = await createSurface(false, available);
    setRoutes([
      { alias: 'adaptive-fast', target: 'auto:gemini-flash-low', enabled: true, published: true },
    ]);
    for (const present of [false, true, false]) {
      if (present) {
        available.add('gemini-3.7-flash-low');
      } else {
        available.clear();
      }
      for (const ids of await readDirectories(app)) {
        expect(ids.includes('adaptive-fast')).toBe(present);
        expect(ids).toContain('gemini-3-flash');
      }
      expect((await queryModel(app, 'adaptive-fast')).map((reply) => reply.statusCode)).toEqual(
        Array(5).fill(present ? 200 : 404),
      );
    }
  });
  it('hot reloads publication across list, retrieve and probes while preserving generation', async () => {
    const app = await createSurface();
    for (const published of [undefined, false, true]) {
      setRoutes([{ alias: 'private-fast', target: 'gemini-3-flash', enabled: true, published }]);
      const visible = published !== false;
      for (const ids of await readDirectories(app)) {
        expect(ids.includes('private-fast')).toBe(visible);
      }
      expect((await queryModel(app, 'private-fast')).map((reply) => reply.statusCode)).toEqual(
        Array(5).fill(visible ? 200 : 404),
      );
      expect(new ModelRoutingService().resolveModelRoute('private-fast')).toMatchObject({
        resolvedModel: 'gemini-3-flash',
        source: 'configured',
      });
      expect(getConfiguredModelMapping(getServerConfig())['private-fast']).toBe('gemini-3-flash');
    }
  });

  it('never publishes wildcard rules or strategy identifiers, and defaults adaptive aliases to hidden', async () => {
    const app = await createSurface();
    setRoutes([
      { alias: 'wild-*', target: 'gemini-3-flash', enabled: true, published: true },
      { alias: 'auto:gemini-flash-low', target: 'gemini-3-flash', enabled: true, published: true },
      { alias: 'adaptive-fast', target: 'auto:gemini-flash-low', enabled: true },
    ]);
    const directories = await readDirectories(app);
    for (const alias of ['wild-*', 'auto:gemini-flash-low', 'adaptive-fast']) {
      for (const ids of directories) {
        expect(ids).not.toContain(alias);
      }
      expect((await queryModel(app, alias)).map((reply) => reply.statusCode)).toEqual([
        404, 404, 404, 404, 404,
      ]);
    }
    expect(new ModelRoutingService().resolveModelRoute('wild-sample')).toMatchObject({
      resolvedModel: 'gemini-3-flash',
      source: 'configured',
    });
  });

  it.each([false, true])(
    'preserves real IDs that collide with hidden aliases in raw mode %s',
    async (raw) => {
      const app = await createSurface(raw);
      setRoutes([
        { alias: 'physical-overlap', target: 'gemini-3-flash', enabled: true, published: false },
        { alias: 'visible-alias', target: 'gemini-3-flash', enabled: true, published: true },
      ]);
      for (const ids of await readDirectories(app)) {
        expect(ids).toContain('physical-overlap');
        expect(ids.includes('visible-alias')).toBe(!raw);
        if (raw) {
          expect(ids).toEqual(['gemini-3-flash', 'physical-overlap']);
        }
      }
      expect((await queryModel(app, 'physical-overlap')).map((reply) => reply.statusCode)).toEqual([
        200, 200, 200, 200, 200,
      ]);
      expect(new ModelRoutingService().resolveModelRoute('visible-alias').resolvedModel).toBe(
        'gemini-3-flash',
      );
    },
  );

  it.each([false, true])(
    'retains physical collisions with an unavailable hidden auto alias in raw mode %s',
    async (raw) => {
      const app = await createSurface(raw, null);
      setRoutes([
        {
          alias: 'physical-overlap',
          target: 'auto:gemini-flash-low',
          enabled: true,
          published: false,
        },
      ]);
      for (const ids of await readDirectories(app)) {
        expect(ids).toContain('physical-overlap');
      }
      expect((await queryModel(app, 'physical-overlap')).map((reply) => reply.statusCode)).toEqual([
        200, 200, 200, 200, 200,
      ]);
    },
  );
});
