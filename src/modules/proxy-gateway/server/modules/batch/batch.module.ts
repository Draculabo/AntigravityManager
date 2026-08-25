import { Module } from '@nestjs/common';

import { AccountLeaseModule } from '../account-lease/account-lease.module';
import { AnthropicModule } from '../anthropic/anthropic.module';
import { AnthropicService } from '../anthropic/anthropic.service';
import { FilesModule } from '../files/files.module';
import { GeminiModule } from '../gemini/gemini.module';
import { GeminiService } from '../gemini/gemini.service';
import { OpenAIModule } from '../openai/openai.module';
import { OpenAIService } from '../openai/openai.service';
import { AnthropicMessageBatchesController } from './anthropic-message-batches.controller';
import { BATCH_EXECUTION_TARGET, type BatchExecutionTarget } from './batch-request-executor';
import { BATCH_RUNNER_OPTIONS, BatchRunnerService } from './batch-runner.service';
import { BatchService } from './batch.service';
import { resolveBatchRunnerOptions } from './batch-store-location';
import { GeminiBatchesController } from './gemini-batches.controller';
import { OpenAIBatchesController } from './openai-batches.controller';

/**
 * Owns the Batch runner, shared controller service, and three protocol adapters.
 * The execution target token keeps the runner independent of vendor services.
 * Gemini submission stays on GeminiController's model-action route; this module
 * provides only its `/v1beta/batches` polling controller.
 */
@Module({
  imports: [AccountLeaseModule, GeminiModule, AnthropicModule, OpenAIModule, FilesModule],
  controllers: [
    OpenAIBatchesController,
    AnthropicMessageBatchesController,
    GeminiBatchesController,
  ],
  providers: [
    {
      provide: BATCH_RUNNER_OPTIONS,
      useFactory: resolveBatchRunnerOptions,
    },
    {
      provide: BATCH_EXECUTION_TARGET,
      useFactory: (
        openai: OpenAIService,
        anthropic: AnthropicService,
        gemini: GeminiService,
      ): BatchExecutionTarget => ({
        handleChatCompletions: (request) => openai.handleChatCompletions(request),
        handleAnthropicMessages: (request) => anthropic.handleAnthropicMessages(request),
        handleGeminiGenerateContent: (model, request) =>
          gemini.handleGeminiGenerateContent(model, request),
      }),
      inject: [OpenAIService, AnthropicService, GeminiService],
    },
    BatchRunnerService,
    BatchService,
  ],
  exports: [BatchRunnerService],
})
export class BatchModule {}
