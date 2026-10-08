import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, vi } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { AnthropicCompleteController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic-complete.controller';
import { AnthropicService } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.service';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));

export const completionTestHeaders = { authorization: 'Bearer synthetic-completion-key' };
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const apps: NestFastifyApplication[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  setServerConfig(previous);
});

/** Runs legacy completion requests through the production guard and error interceptor. */
export async function createAnthropicCompleteHttpApp(
  operations: Pick<AnthropicService, 'handleAnthropicMessages'>,
): Promise<NestFastifyApplication> {
  @Module({
    controllers: [AnthropicCompleteController],
    providers: [ProxyGuard, { provide: AnthropicService, useValue: operations }],
  })
  class CompletionHttpTestModule {}
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: 'synthetic-completion-key' });
  const app = await NestFactory.create<NestFastifyApplication>(
    CompletionHttpTestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  apps.push(app);
  await app.init();
  return app;
}
