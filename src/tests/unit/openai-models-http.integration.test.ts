import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { OpenAIModelsController } from '@/modules/proxy-gateway/server/modules/openai/openai-models.controller';
import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { OpenAIService } from '@/modules/proxy-gateway/server/modules/openai/openai.service';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const apps: NestFastifyApplication[] = [];
const headers = { authorization: 'Bearer synthetic-model-key' };

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  setServerConfig(previous);
});

async function createSurface() {
  const rawModels = ['gemini-3-flash', 'claude-sonnet-4-6'];
  @Module({
    controllers: [OpenAIModelsController],
    providers: [
      ProxyGuard,
      OpenAIOperations,
      { provide: OpenAIService, useValue: {} },
      {
        provide: AccountLeaseService,
        useValue: {
          getAllRawQuotaModels: vi.fn(() => new Set(rawModels)),
          getAllCollectedModels: vi.fn(() => new Set(rawModels)),
        },
      },
    ],
  })
  class OpenAIModelsHttpTestModule {}
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    api_key: 'synthetic-model-key',
    only_raw_quota_models: true,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    OpenAIModelsHttpTestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  apps.push(app);
  await app.init();
  return app;
}

/**
 * The OpenAI SDK reads `GET /v1/models` and expects `context_length` and
 * `max_completion_tokens` to reach the wire unchanged; controller mocks cannot prove that.
 */
describe('OpenAI model queries HTTP', () => {
  it('serializes the listing metadata for every served model', async () => {
    const app = await createSurface();
    const reply = await app.inject({ url: '/v1/models', headers });

    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 200,
      body: {
        object: 'list',
        data: [
          {
            id: 'claude-sonnet-4-6',
            object: 'model',
            created: 1770652800,
            owned_by: 'antigravity',
            context_length: 200000,
            max_completion_tokens: 64000,
          },
          {
            id: 'gemini-3-flash',
            object: 'model',
            created: 1770652800,
            owned_by: 'antigravity',
            context_length: 1048576,
            max_completion_tokens: 65536,
          },
        ],
      },
    });
  });

  it('serializes the same entry for a single model', async () => {
    const app = await createSurface();
    const listed = await app.inject({ url: '/v1/models', headers });
    const expected = listed
      .json<{ data: Array<{ id: string }> }>()
      .data.find((entry) => entry.id === 'gemini-3-flash');

    const reply = await app.inject({ url: '/v1/models/gemini-3-flash', headers });

    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 200,
      body: expected,
    });
  });
});
