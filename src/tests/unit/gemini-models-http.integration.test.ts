import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const apps: NestFastifyApplication[] = [];
const headers = { authorization: 'Bearer synthetic-model-key' };

vi.setConfig({ testTimeout: 15_000 });

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  setServerConfig(previous);
});

async function createSurface(rawModels = ['gemini-2.5-flash']) {
  const getAllRawQuotaModels = vi.fn(() => new Set(rawModels));
  const getAllCollectedModels = vi.fn(() => new Set(['gemini-3-flash']));
  @Module({
    controllers: [GeminiController, AnthropicController],
    providers: [
      ProxyGuard,
      { provide: GeminiService, useValue: {} },
      { provide: AnthropicService, useValue: {} },
      { provide: AccountLeaseService, useValue: { getAllRawQuotaModels, getAllCollectedModels } },
    ],
  })
  class ModelsHttpTestModule {}
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    api_key: 'synthetic-model-key',
    only_raw_quota_models: true,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    ModelsHttpTestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  apps.push(app);
  await app.init();
  return { app, getAllRawQuotaModels, getAllCollectedModels };
}

describe('Gemini model queries HTTP', () => {
  it('returns identical native Anthropic list/retrieve metadata on the existing Claude routes', async () => {
    const { app } = await createSurface();
    const list = await app.inject({ url: '/v1/models/claude', headers });
    const model = {
      type: 'model',
      id: 'gemini-2.5-flash',
      display_name: 'gemini-2.5-flash',
      created_at: '1970-01-01T00:00:00Z',
    };
    expect({ status: list.statusCode, body: list.json() }).toEqual({
      status: 200,
      body: { data: [model], first_id: model.id, has_more: false, last_id: model.id },
    });
    const get = await app.inject({ url: '/v1/models/claude/GEMINI-2.5-FLASH', headers });
    expect({ status: get.statusCode, body: get.json() }).toEqual({ status: 200, body: model });
  });

  it.each(['/v1/models/claude', '/v1/models/claude/gemini-2.5-flash'])(
    'protects the Anthropic directory before catalog access: %s',
    async (url) => {
      const { app, getAllRawQuotaModels } = await createSurface();
      const reply = await app.inject({ url });
      expect(reply.statusCode).toBe(401);
      expect(getAllRawQuotaModels).not.toHaveBeenCalled();
    },
  );
  it('returns the complete raw model catalog with HTTP 200', async () => {
    const { app, getAllRawQuotaModels, getAllCollectedModels } = await createSurface();
    const reply = await app.inject({ url: '/v1beta/models', headers });
    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 200,
      body: {
        models: [
          {
            name: 'models/gemini-2.5-flash',
            displayName: 'gemini-2.5-flash',
            description: '',
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
            temperature: 1,
            topK: 64,
            topP: 0.95,
            version: '001',
          },
        ],
      },
    });
    expect(getAllRawQuotaModels).toHaveBeenCalledOnce();
    expect(getAllCollectedModels).not.toHaveBeenCalled();
  });

  it.each(['gemini-2.5-flash', 'models%2Fgemini-2.5-flash', 'GEMINI-2.5-FLASH'])(
    'returns an existing model projection for %s',
    async (model) => {
      const { app } = await createSurface();
      const reply = await app.inject({ url: `/v1beta/models/${model}`, headers });
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 200,
        body: {
          name: 'models/gemini-2.5-flash',
          displayName: 'gemini-2.5-flash',
          description: '',
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
          temperature: 1,
          topK: 64,
          topP: 0.95,
          version: '001',
        },
      });
    },
  );

  it('uses exact spelling first and refuses an ambiguous case-insensitive match', async () => {
    const { app } = await createSurface(['case-model', 'CASE-MODEL']);
    for (const id of ['case-model', 'CASE-MODEL']) {
      const reply = await app.inject({ url: `/v1beta/models/${id}`, headers });
      expect(reply.statusCode).toBe(200);
      expect(reply.json().name).toBe(`models/${id}`);
    }
    const ambiguous = await app.inject({ url: '/v1beta/models/Case-Model', headers });
    expect(ambiguous.statusCode).toBe(404);
  });

  it('returns a typed 404 for an unknown model', async () => {
    const { app } = await createSurface();
    const reply = await app.inject({ url: '/v1beta/models/unknown-model', headers });
    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 404,
      body: {
        statusCode: 404,
        error: 'Not Found',
        message: "Model 'models/unknown-model' was not found",
      },
    });
  });

  describe.each(['/v1beta/models', '/v1beta/models/gemini-2.5-flash'])('%s', (url) => {
    it.each([undefined, 'Bearer wrong-key'])(
      'denies %s before reading the catalog',
      async (authorization) => {
        const { app, getAllRawQuotaModels, getAllCollectedModels } = await createSurface();
        const reply = await app.inject({ url, headers: authorization ? { authorization } : {} });
        expect({ status: reply.statusCode, body: reply.json() }).toEqual({
          status: 401,
          body: {
            error: {
              code: 401,
              message: 'API key validation failed',
              status: 'UNAUTHENTICATED',
            },
          },
        });
        expect(getAllRawQuotaModels).not.toHaveBeenCalled();
        expect(getAllCollectedModels).not.toHaveBeenCalled();
      },
    );

    it('retains framework handling for catalog failures', async () => {
      const { app, getAllRawQuotaModels } = await createSurface();
      getAllRawQuotaModels.mockImplementationOnce(() => {
        throw new Error('Catalog failed');
      });
      const reply = await app.inject({ url, headers });
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 500,
        body: { statusCode: 500, message: 'Internal server error' },
      });
    });
  });
});
