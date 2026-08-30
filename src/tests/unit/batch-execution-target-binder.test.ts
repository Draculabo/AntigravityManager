import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { BatchExecutionTargetBinder } from '@/modules/proxy-gateway/server/batch-execution-target.binder';
import { BatchService } from '@/modules/proxy-gateway/server/modules/batch/batch.service';
import type { BatchExecutionTarget } from '@/modules/proxy-gateway/server/modules/batch/batch-request-executor';
import { OpenAIService } from '@/modules/proxy-gateway/server/modules/openai/openai.service';
import { AnthropicService } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.service';
import { GeminiService } from '@/modules/proxy-gateway/server/modules/gemini/gemini.service';

describe('batch execution target Nest bootstrap', () => {
  it('injects all targets without relying on emitted design:paramtypes metadata', async () => {
    let target: BatchExecutionTarget | undefined;
    const bindExecutionTarget = vi.fn((value: BatchExecutionTarget) => {
      target = value;
    });
    const openai = vi.fn(async () => ({ marker: 'openai' }));
    const anthropic = vi.fn(async () => ({ marker: 'anthropic' }));
    const gemini = vi.fn(async () => ({ marker: 'gemini' }));
    @Module({
      providers: [
        BatchExecutionTargetBinder,
        { provide: BatchService, useValue: { bindExecutionTarget } },
        { provide: OpenAIService, useValue: { handleChatCompletions: openai } },
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
      const openaiInput = { model: 'test', messages: [] };
      const anthropicInput = { model: 'test', messages: [], max_tokens: 1 };
      const geminiInput = { contents: [] };
      expect(await target.handleChatCompletions(openaiInput)).toEqual({ marker: 'openai' });
      expect(await target.handleAnthropicMessages(anthropicInput)).toEqual({ marker: 'anthropic' });
      expect(await target.handleGeminiGenerateContent('test', geminiInput)).toEqual({
        marker: 'gemini',
      });
      expect(openai).toHaveBeenCalledWith(openaiInput);
      expect(anthropic).toHaveBeenCalledWith(anthropicInput);
      expect(gemini).toHaveBeenCalledWith('test', geminiInput);
    } finally {
      await app.close();
    }
  });
});
