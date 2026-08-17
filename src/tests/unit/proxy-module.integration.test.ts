import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
import { BatchRunnerService } from '@/modules/proxy-gateway/server/modules/batch/batch-runner.service';
import { FileContentStore } from '@/modules/proxy-gateway/server/modules/files/file-content-store.service';
import { GeminiController } from '@/modules/proxy-gateway/server/modules/gemini/gemini.controller';
import { ModelRouteMissJournalService } from '@/modules/proxy-gateway/server/shared/services/model-route-miss-journal.service';
import { OpenAIChatCompletionService } from '@/modules/proxy-gateway/server/modules/openai/chat/openai-chat-completion.service';
import { OpenAIController } from '@/modules/proxy-gateway/server/modules/openai/openai.controller';
import { OpenAIResponsesSessionService } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.service';
import { OpenAIResponsesStoreController } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-store.controller';
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

  /**
   * The state owners, resolved from the real graph rather than constructed by
   * hand. A provider that only ever appears in a unit test proves its own logic
   * and nothing about whether Nest can build it: a missing module import or an
   * unregistered token surfaces here and nowhere else.
   */
  it('builds every durable state owner and the file plane', async () => {
    const application = await NestFactory.createApplicationContext(ProxyModule, {
      logger: false,
    });

    try {
      expect(application.get(OpenAIResponsesSessionService)).toBeInstanceOf(
        OpenAIResponsesSessionService,
      );
      expect(application.get(OpenAIChatCompletionService)).toBeInstanceOf(
        OpenAIChatCompletionService,
      );
      expect(application.get(OpenAIResponsesStoreController)).toBeInstanceOf(
        OpenAIResponsesStoreController,
      );
      expect(application.get(FileContentStore)).toBeInstanceOf(FileContentStore);
      expect(application.get(BatchRunnerService)).toBeInstanceOf(BatchRunnerService);
      expect(application.get(ModelRouteMissJournalService)).toBeInstanceOf(
        ModelRouteMissJournalService,
      );
    } finally {
      await application.close();
    }
  });
});
