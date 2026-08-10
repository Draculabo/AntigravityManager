import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
import { GeminiController } from '@/modules/proxy-gateway/server/modules/gemini/gemini.controller';
import { OpenAIController } from '@/modules/proxy-gateway/server/modules/openai/openai.controller';
import { ProxyModule } from '@/modules/proxy-gateway/server/proxy.module';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

describe('ProxyModule dependency graph', () => {
  it('resolves the facade and all protocol controllers', async () => {
    const application = await NestFactory.createApplicationContext(ProxyModule, {
      logger: false,
    });

    try {
      expect(application.get(ProxyService)).toBeInstanceOf(ProxyService);
      expect(application.get(OpenAIController)).toBeInstanceOf(OpenAIController);
      expect(application.get(AnthropicController)).toBeInstanceOf(AnthropicController);
      expect(application.get(GeminiController)).toBeInstanceOf(GeminiController);
    } finally {
      await application.close();
    }
  });
});
