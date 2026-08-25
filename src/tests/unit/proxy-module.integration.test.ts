import { Inject, Injectable, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
import { BatchRunnerService } from '@/modules/proxy-gateway/server/modules/batch/batch-runner.service';
import { FileContentStore } from '@/modules/proxy-gateway/server/modules/files/file-content-store.service';
import { FilesModule } from '@/modules/proxy-gateway/server/modules/files/files.module';
import { FilesService } from '@/modules/proxy-gateway/server/modules/files/files.service';
import { GeminiController } from '@/modules/proxy-gateway/server/modules/gemini/gemini.controller';
import { ModelRouteMissJournalService } from '@/modules/proxy-gateway/server/shared/services/model-route-miss-journal.service';
import { OpenAIChatCompletionService } from '@/modules/proxy-gateway/server/modules/openai/chat/openai-chat-completion.service';
import { OpenAIChatController } from '@/modules/proxy-gateway/server/modules/openai/openai-chat.controller';
import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { OpenAIMediaController } from '@/modules/proxy-gateway/server/modules/openai/openai-media.controller';
import { OpenAIModelsController } from '@/modules/proxy-gateway/server/modules/openai/openai-models.controller';
import { OpenAIResponsesController } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses.controller';
import { OpenAIResponsesSessionService } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.service';
import { OpenAIResponsesStoreController } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-store.controller';
import { ProxyModule } from '@/modules/proxy-gateway/server/proxy.module';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

@Injectable()
class FilesConsumer {
  constructor(@Inject(FilesService) public readonly files: FilesService) {}
}

@Module({ imports: [FilesModule], providers: [FilesConsumer] })
class FilesConsumerModule {}

describe('FilesModule exports', () => {
  it('makes FilesService injectable by an importing module', async () => {
    const application = await NestFactory.createApplicationContext(FilesConsumerModule, {
      logger: false,
    });

    try {
      expect(application.get(FilesConsumer).files).toBeInstanceOf(FilesService);
    } finally {
      await application.close();
    }
  });

  it('keeps FileContentStore private to FilesModule', () => {
    const exports = Reflect.getMetadata(MODULE_METADATA.EXPORTS, FilesModule) as unknown[];

    expect(exports).toContain(FilesService);
    expect(exports).not.toContain(FileContentStore);
  });
});

describe('ProxyModule dependency graph', () => {
  it('resolves the OpenAI operations service and all protocol controllers', async () => {
    const application = await NestFactory.createApplicationContext(ProxyModule, {
      logger: false,
    });

    try {
      expect(application.get(ProxyService)).toBeInstanceOf(ProxyService);
      expect(application.get(OpenAIOperations)).toBeInstanceOf(OpenAIOperations);
      expect(application.get(OpenAIModelsController)).toBeInstanceOf(OpenAIModelsController);
      expect(application.get(OpenAIChatController)).toBeInstanceOf(OpenAIChatController);
      expect(application.get(OpenAIResponsesController)).toBeInstanceOf(OpenAIResponsesController);
      expect(application.get(OpenAIMediaController)).toBeInstanceOf(OpenAIMediaController);
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
