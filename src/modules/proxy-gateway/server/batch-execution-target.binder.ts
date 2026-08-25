import { Injectable, OnApplicationBootstrap } from '@nestjs/common';

import { AnthropicService } from './modules/anthropic/anthropic.service';
import { BatchService } from './modules/batch/batch.service';
import type { BatchExecutionTarget } from './modules/batch/batch-request-executor';
import { GeminiService } from './modules/gemini/gemini.service';
import { OpenAIService } from './modules/openai/openai.service';

@Injectable()
export class BatchExecutionTargetBinder implements OnApplicationBootstrap {
  constructor(
    private readonly batches: BatchService,
    private readonly openAI: OpenAIService,
    private readonly anthropic: AnthropicService,
    private readonly gemini: GeminiService,
  ) {}

  onApplicationBootstrap(): void {
    const target: BatchExecutionTarget = {
      handleChatCompletions: (request) => this.openAI.handleChatCompletions(request),
      handleAnthropicMessages: (request) => this.anthropic.handleAnthropicMessages(request),
      handleGeminiGenerateContent: (model, request) =>
        this.gemini.handleGeminiGenerateContent(model, request),
    };
    this.batches.bindExecutionTarget(target);
  }
}
