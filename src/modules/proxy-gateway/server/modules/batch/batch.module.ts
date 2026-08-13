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
import { resolveBatchRunnerOptions } from './batch-store-location';
import { GeminiOperationsController } from './gemini-operations.controller';
import { OpenAIBatchesController } from './openai-batches.controller';

/**
 * Wires the batch runner's core to the already-ported protocol services, and
 * hosts the three per-dialect protocol surfaces that sit on top of it.
 *
 * This module owns the only place that knows the runner's execution target is
 * backed by `OpenAIService` / `AnthropicService` / `GeminiService`: the runner
 * itself depends on {@link BatchExecutionTarget} through
 * {@link BATCH_EXECUTION_TARGET}, never on those classes directly.
 *
 * `OpenAIBatchesController` (`/v1/batches`) and `AnthropicMessageBatchesController`
 * (`/v1/messages/batches`) are registered here because they are new resources
 * with no other natural home. Gemini's `:batchGenerateContent` is different:
 * it answers on the *existing* `/v1beta/models/{model}:generateContent`-style
 * route table, so that submission logic is dispatched from
 * `GeminiController` itself (`gemini-batch-submit.ts`) rather than duplicated
 * as a second controller here; only the polling half,
 * `GeminiOperationsController` (`/v1beta/operations`), is a genuinely new
 * resource and lives in this module. `GeminiController` reaches
 * `BatchRunnerService` through `ModuleRef.get(..., { strict: false })`
 * instead of `GeminiModule` importing this module back, so this module's own
 * import of `GeminiModule` below stays a plain, non-circular import.
 */
@Module({
  imports: [AccountLeaseModule, GeminiModule, AnthropicModule, OpenAIModule, FilesModule],
  controllers: [
    OpenAIBatchesController,
    AnthropicMessageBatchesController,
    GeminiOperationsController,
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
  ],
  exports: [BatchRunnerService],
})
export class BatchModule {}
