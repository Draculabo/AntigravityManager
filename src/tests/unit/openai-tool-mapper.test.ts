import { describe, expect, it, vi } from 'vitest';

import { OpenAIService as ProxyService } from '../../server/gateway/modules/openai/openai.service';
import { generateGeminiWithAggregationFallback } from '@/server/gateway/common/aggregate-gemini-fallback';
import type { GeminiResponse } from '@/server/gateway/common/interfaces/request-interfaces';
import { convertOpenAIGenerationTools } from '@/server/gateway/modules/openai/chat/openai-claude-conversion';

describe('OpenAI tool mapper compatibility', () => {
  it('maps a Responses apply_patch custom tool to the upstream freeform input schema', () => {
    const result = convertOpenAIGenerationTools([
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Apply a patch.',
      },
    ]);

    expect(result).toEqual([
      {
        name: 'apply_patch',
        description: 'Apply a patch.',
        input_schema: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: 'Pass the exact freeform text in this field.',
            },
          },
          required: ['input'],
        },
      },
    ]);
  });

  it('returns safety prompt feedback without starting an aggregation fallback', async () => {
    const response: GeminiResponse = {
      candidates: [],
      promptFeedback: {
        blockReason: 'SAFETY',
      },
    };
    const start = vi.fn();
    const collect = vi.fn();
    const onFallback = vi.fn();
    await expect(
      generateGeminiWithAggregationFallback({
        request: {
          model: 'gemini-3-flash',
          request: { contents: [] },
          requestId: 'controlled-safety-response',
          userAgent: 'controlled-mapper-test/0.0.0',
        },
        generate: async () => response,
        start,
        collect,
        onFallback,
      }),
    ).resolves.toEqual(response);
    expect(start).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('preserves incomplete PowerShell arguments without inserting an executable command', () => {
    const service = Object.create(ProxyService.prototype) as ProxyService;
    const result = Reflect.get(service, 'convertClaudeToOpenAIResponse').call(
      service,
      {
        content: [
          {
            id: 'call_powershell',
            input: { description: 'sensitive tool detail' },
            name: 'PowerShell',
            type: 'tool_use',
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      'gpt-5-codex',
    );

    expect(result.choices[0]).toMatchObject({ finish_reason: 'tool_calls' });
    const toolCall = result.choices[0].message.tool_calls?.[0];
    expect(toolCall?.function?.name).toBe('PowerShell');
    expect(JSON.parse(toolCall?.function?.arguments ?? '{}')).toEqual({
      description: 'sensitive tool detail',
    });
  });
});
