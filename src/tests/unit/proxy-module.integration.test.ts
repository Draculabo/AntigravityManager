import { Inject, Injectable, Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { BatchRunnerService } from '@/server/gateway/modules/batch/batch-runner.service';
import { FileContentStore } from '@/server/gateway/modules/files/file-content-store.service';
import { FilesModule } from '@/server/gateway/modules/files/files.module';
import { FilesService } from '@/server/gateway/modules/files/files.service';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { ModelRouteMissJournalService } from '@/server/gateway/shared/services/model-route-miss-journal.service';
import { OpenAIChatCompletionService } from '@/server/gateway/modules/openai/chat/openai-chat-completion.service';
import { OpenAIChatController } from '@/server/gateway/modules/openai/openai-chat.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIMediaController } from '@/server/gateway/modules/openai/openai-media.controller';
import { OpenAIModelsController } from '@/server/gateway/modules/openai/openai-models.controller';
import { OpenAIProbesController } from '@/server/gateway/modules/openai/openai-probes.controller';
import { OpenAIResponsesController } from '@/server/gateway/modules/openai/responses/openai-responses.controller';
import { OpenAIResponsesSessionService } from '@/server/gateway/modules/openai/responses/openai-responses-session.service';
import { OpenAIResponsesStoreController } from '@/server/gateway/modules/openai/responses/openai-responses-store.controller';
import { ProxyModule } from '@/server/gateway/proxy.module';
import { ProxyService } from '@/server/gateway/proxy.service';
import { invalidateThoughtRecoveryPeers } from '@/modules/proxy-gateway/thought-store/thought-recovery-peers';
import { responsesIdentityFixture } from './responses-identity.fixture';

@Injectable()
class FilesConsumer {
  constructor(@Inject(FilesService) public readonly files: FilesService) {}
}

@Module({ imports: [FilesModule], providers: [FilesConsumer] })
class FilesConsumerModule {}

describe('FilesModule exports', () => {
  it('keeps the selected Responses metadata owner available between actual Nest lifetimes', async () => {
    const first = await NestFactory.createApplicationContext(ProxyModule, { logger: false });
    const selected = first.get(OpenAIResponsesSessionService);
    try {
      selected.save('owner-lifecycle-fixture', {
        identity: responsesIdentityFixture,
        thoughtSessionKey: 'owner-lifecycle-scope',
        model: 'fixture',
        inputItems: [],
      });
      await selected.flushStrict();
    } finally {
      await first.close();
    }
    const receipt = await invalidateThoughtRecoveryPeers('owner-lifecycle-scope');
    expect(receipt.recovery.find((effect) => effect.owner === 'responses')).toEqual({
      owner: 'responses',
      state: 'complete',
      removed: 1,
      unknown: 0,
    });
    const second = await NestFactory.createApplicationContext(ProxyModule, { logger: false });
    try {
      expect(second.get(OpenAIResponsesSessionService)).toBe(selected);
      expect(selected.get('owner-lifecycle-fixture')).toBeNull();
    } finally {
      await second.close();
    }
  });
  it('makes FilesService injectable by an importing module', async () => {
    const application = await NestFactory.createApplicationContext(FilesConsumerModule, {
      logger: false,
      abortOnError: false,
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
      abortOnError: false,
    });

    try {
      expect(application.get(ProxyService)).toBeInstanceOf(ProxyService);
      expect(application.get(OpenAIOperations)).toBeInstanceOf(OpenAIOperations);
      expect(application.get(OpenAIModelsController)).toBeInstanceOf(OpenAIModelsController);
      expect(application.get(OpenAIProbesController)).toBeInstanceOf(OpenAIProbesController);
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
      abortOnError: false,
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
