import { describe, expect, it } from 'vitest';

import { decodeAntigravityStreamUsage } from '@/modules/proxy-gateway/antigravity/AntigravityStreamDecoder';
import {
  toOpenAIResponsesUsage,
  toOpenAIUsage,
} from '@/modules/proxy-gateway/antigravity/OpenAIUsageMapper';

function toStreamingOpenAIUsage(usage: Parameters<typeof decodeAntigravityStreamUsage>[0]) {
  return toOpenAIUsage(decodeAntigravityStreamUsage(usage));
}

describe('toOpenAIUsage', () => {
  const candidatesTokensDetails = [
    { modality: 'THINKING', tokenCount: 4 },
    { modality: 'reasoning', tokenCount: 3 },
    { modality: 'TEXT', tokenCount: 5 },
  ];

  it('adds modality reasoning details without changing legacy totals', () => {
    const usage = toStreamingOpenAIUsage({
      promptTokenCount: 20,
      candidatesTokenCount: 12,
      totalTokenCount: 32,
      candidatesTokensDetails,
    });
    expect(usage).toEqual({
      prompt_tokens: 20,
      completion_tokens: 12,
      total_tokens: 32,
      prompt_tokens_details: undefined,
      completion_tokens_details: { reasoning_tokens: 7 },
    });
    expect(toOpenAIResponsesUsage(usage)).toEqual({
      input_tokens: 20,
      output_tokens: 12,
      total_tokens: 32,
      input_tokens_details: undefined,
      output_tokens_details: { reasoning_tokens: 7 },
    });
  });

  it.each([
    { total_thought_tokens: 2, totalThoughtTokens: 3, thoughtsTokenCount: 4 },
    { totalThoughtTokens: 2, thoughtsTokenCount: 4 },
    { thoughtsTokenCount: 2 },
  ])('keeps explicit reasoning totals authoritative (%j)', (explicit) => {
    expect(
      toStreamingOpenAIUsage({
        ...explicit,
        promptTokenCount: 20,
        candidatesTokenCount: 12,
        totalTokenCount: 32,
        candidatesTokensDetails,
      }),
    ).toEqual({
      prompt_tokens: 20,
      completion_tokens: 12,
      total_tokens: 32,
      prompt_tokens_details: undefined,
      completion_tokens_details: { reasoning_tokens: 2 },
    });
  });

  it('does not replace an explicit zero with modality estimates', () => {
    expect(
      toStreamingOpenAIUsage({
        thoughtsTokenCount: 0,
        candidatesTokenCount: 12,
        candidatesTokensDetails,
      }),
    ).toEqual({
      prompt_tokens: 0,
      completion_tokens: 12,
      total_tokens: 12,
      prompt_tokens_details: undefined,
      completion_tokens_details: undefined,
    });
  });

  it('uses modality counts in the existing Interactions output accounting', () => {
    expect(
      toStreamingOpenAIUsage({
        total_input_tokens: 20,
        total_output_tokens: 5,
        total_tool_use_tokens: 2,
        total_tokens: 34,
        candidatesTokensDetails,
      }),
    ).toEqual({
      prompt_tokens: 20,
      completion_tokens: 14,
      total_tokens: 34,
      prompt_tokens_details: undefined,
      completion_tokens_details: { reasoning_tokens: 7 },
    });
  });

  it('preserves totals while exposing cache and reasoning token details', () => {
    expect(
      toOpenAIUsage({
        inputTokens: 1200,
        outputTokens: 300,
        cachedInputTokens: 800,
        reasoningTokens: 120,
      }),
    ).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 800 },
      completion_tokens_details: { reasoning_tokens: 120 },
    });
  });

  it('omits optional details when upstream did not provide them', () => {
    expect(toOpenAIUsage({ inputTokens: 12, outputTokens: 4 })).toEqual({
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      prompt_tokens_details: undefined,
      completion_tokens_details: undefined,
    });
  });

  it('uses Responses input/output usage field names', () => {
    expect(
      toOpenAIResponsesUsage({
        prompt_tokens: 20,
        completion_tokens: 5,
        total_tokens: 25,
        prompt_tokens_details: { cached_tokens: 15 },
      }),
    ).toEqual({
      input_tokens: 20,
      output_tokens: 5,
      total_tokens: 25,
      input_tokens_details: { cached_tokens: 15 },
      output_tokens_details: undefined,
    });
  });

  it('does not double-count reasoning already included in legacy Gemini output totals', () => {
    expect(
      toStreamingOpenAIUsage({
        cachedContentTokenCount: 11,
        candidatesTokenCount: 7,
        promptTokenCount: 19,
        thoughtsTokenCount: 5,
      }),
    ).toEqual({
      prompt_tokens: 19,
      completion_tokens: 7,
      total_tokens: 26,
      prompt_tokens_details: { cached_tokens: 11 },
      completion_tokens_details: { reasoning_tokens: 5 },
    });
  });

  it('does not double-count tool-use tokens already included in legacy Gemini output totals', () => {
    expect(
      toStreamingOpenAIUsage({
        candidatesTokenCount: 20,
        promptTokenCount: 7,
        thoughtsTokenCount: 8,
        total_tool_use_tokens: 5,
      }),
    ).toEqual({
      prompt_tokens: 7,
      completion_tokens: 20,
      total_tokens: 27,
      prompt_tokens_details: undefined,
      completion_tokens_details: { reasoning_tokens: 8 },
    });
  });

  it('maps Gemini Interactions usage without subtracting cached input tokens', () => {
    expect(
      toStreamingOpenAIUsage({
        total_cached_tokens: 40,
        total_input_tokens: 100,
        total_output_tokens: 25,
        total_thought_tokens: 10,
        total_tokens: 135,
      }),
    ).toEqual({
      prompt_tokens: 100,
      completion_tokens: 35,
      total_tokens: 135,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 10 },
    });
  });

  it('counts Gemini tool-use tokens as output tokens', () => {
    expect(
      toStreamingOpenAIUsage({
        total_input_tokens: 7,
        total_output_tokens: 20,
        total_thought_tokens: 22,
        total_tool_use_tokens: 5,
        total_tokens: 54,
      }),
    ).toEqual({
      prompt_tokens: 7,
      completion_tokens: 47,
      total_tokens: 54,
      prompt_tokens_details: undefined,
      completion_tokens_details: { reasoning_tokens: 22 },
    });
  });

  it('preserves the upstream Gemini total when it is provided', () => {
    expect(
      toStreamingOpenAIUsage({
        total_input_tokens: 10,
        total_output_tokens: 5,
        total_tokens: 20,
      }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 20,
      prompt_tokens_details: undefined,
      completion_tokens_details: undefined,
    });
  });

  it('preserves the legacy Gemini total when it is provided', () => {
    expect(
      toStreamingOpenAIUsage({
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 18,
      }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 18,
      prompt_tokens_details: undefined,
      completion_tokens_details: undefined,
    });
  });
});
