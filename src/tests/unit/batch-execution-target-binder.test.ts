import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { BatchExecutionTargetBinder } from '@/server/gateway/batch-execution-target.binder';
import { BatchService } from '@/server/gateway/modules/batch/batch.service';
import type { BatchExecutionTarget } from '@/server/gateway/modules/batch/batch-request-executor';
import { OpenAIService } from '@/server/gateway/modules/openai/openai.service';
import { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

describe('batch execution target Nest bootstrap', () => {
  it('injects all targets without relying on emitted design:paramtypes metadata', async () => {
    let target: BatchExecutionTarget | undefined;
    const bindExecutionTarget = vi.fn((value: BatchExecutionTarget) => {
      target = value;
    });
    const upstream = createUpstream({ generate: geminiTextResponse('Batch complete') });
    const { openAIService } = createGateway(upstream, createLease([createAccount('batch')]));
    const anthropic = vi.fn(async () => ({ marker: 'anthropic' }));
    const gemini = vi.fn(async () => ({ marker: 'gemini' }));
    @Module({
      providers: [
        BatchExecutionTargetBinder,
        { provide: BatchService, useValue: { bindExecutionTarget } },
        { provide: OpenAIService, useValue: openAIService },
        { provide: AnthropicService, useValue: { handleAnthropicMessages: anthropic } },
        { provide: GeminiService, useValue: { handleGeminiGenerateContent: gemini } },
      ],
    })
    class TestModule {}
    const app = await NestFactory.createApplicationContext(TestModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      expect(bindExecutionTarget).toHaveBeenCalledTimes(1);
      if (!target) {
        throw new Error('Bootstrap did not bind an execution target');
      }
      const openaiInput = {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'Summarize this batch' }],
      };
      const anthropicInput = { model: 'test', messages: [], max_tokens: 1 };
      const geminiInput = { contents: [] };
      expect(await target.handleChatCompletions(openaiInput)).toMatchObject({
        choices: [{ message: { content: 'Batch complete' } }],
      });
      expect(upstream.calls.map(({ body }) => body.request.contents)).toEqual([
        [{ role: 'user', parts: [{ text: 'Summarize this batch' }] }],
      ]);
      expect(await target.handleAnthropicMessages(anthropicInput)).toEqual({ marker: 'anthropic' });
      expect(await target.handleGeminiGenerateContent('test', geminiInput)).toEqual({
        marker: 'gemini',
      });
      expect(anthropic).toHaveBeenCalledWith(anthropicInput);
      expect(gemini).toHaveBeenCalledWith('test', geminiInput);
    } finally {
      await app.close();
    }
  });
});
