import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, vi } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { BatchService } from '@/modules/proxy-gateway/server/modules/batch/batch.service';
import { OpenAIBatchesController } from '@/modules/proxy-gateway/server/modules/batch/openai-batches.controller';
import { AnthropicMessageBatchesController } from '@/modules/proxy-gateway/server/modules/batch/anthropic-message-batches.controller';
import { GeminiBatchesController } from '@/modules/proxy-gateway/server/modules/batch/gemini-batches.controller';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));

export const batchTestHeaders = { authorization: 'Bearer synthetic-batch-key' };

const apps: NestFastifyApplication[] = [];
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  setServerConfig(previous);
});

/** Exercises the production guards and decorators against an injected Batch service. */
export async function createBatchHttpApp(batches: BatchService): Promise<NestFastifyApplication> {
  @Module({
    controllers: [
      OpenAIBatchesController,
      AnthropicMessageBatchesController,
      GeminiBatchesController,
    ],
    providers: [ProxyGuard, { provide: BatchService, useValue: batches }],
  })
  class BatchHttpTestModule {}

  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: 'synthetic-batch-key' });
  const app = await NestFactory.create<NestFastifyApplication>(
    BatchHttpTestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  apps.push(app);
  await app.init();
  return app;
}
