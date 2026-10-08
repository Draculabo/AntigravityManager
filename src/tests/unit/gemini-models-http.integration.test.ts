import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { GeminiController } from '@/modules/proxy-gateway/server/modules/gemini/gemini.controller';
import { GeminiService } from '@/modules/proxy-gateway/server/modules/gemini/gemini.service';
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
  const getAllRawQuotaModels = vi.fn(() => new Set(['gemini-2.5-flash']));
  const getAllCollectedModels = vi.fn(() => new Set(['gemini-3-flash']));
  @Module({
    controllers: [GeminiController],
    providers: [
      ProxyGuard,
      { provide: GeminiService, useValue: {} },
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
            inputTokenLimit: 128000,
            outputTokenLimit: 8192,
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

  it.each(['gemini-2.5-flash', 'models%2Fgemini-2.5-flash'])(
    'returns an existing model projection for %s',
    async (model) => {
      const { app } = await createSurface();
      const reply = await app.inject({ url: `/v1beta/models/${model}`, headers });
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 200,
        body: { name: 'models/gemini-2.5-flash', displayName: 'gemini-2.5-flash' },
      });
    },
  );

  it('preserves HTTP 200 fallback metadata for an unknown model', async () => {
    const { app } = await createSurface();
    const reply = await app.inject({ url: '/v1beta/models/unknown-model', headers });
    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 200,
      body: { name: 'models/unknown-model', displayName: 'unknown-model' },
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
