import { Module } from '@nestjs/common';

import { AccountLeaseModule } from '../account-lease/account-lease.module';
import { AnthropicModule } from '../anthropic/anthropic.module';
import { AnthropicService } from '../anthropic/anthropic.service';
import { GeminiModule } from '../gemini/gemini.module';
import { GeminiService } from '../gemini/gemini.service';
import { OpenAIModule } from '../openai/openai.module';
import { OpenAIService } from '../openai/openai.service';
import { BATCH_EXECUTION_TARGET, type BatchExecutionTarget } from './batch-request-executor';
import { BATCH_RUNNER_OPTIONS, BatchRunnerService } from './batch-runner.service';
import { resolveBatchRunnerOptions } from './batch-store-location';

/**
 * Wires the batch runner's core to the already-ported protocol services.
 *
 * This module owns the only place that knows the runner's execution target is
 * backed by `OpenAIService` / `AnthropicService` / `GeminiService`: the runner
 * itself depends on {@link BatchExecutionTarget} through
 * {@link BATCH_EXECUTION_TARGET}, never on those classes directly. Zero
 * controllers -- there is no HTTP surface in this port, only the foundation a
 * future batch protocol task builds on.
 */
@Module({
  imports: [AccountLeaseModule, GeminiModule, AnthropicModule, OpenAIModule],
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
