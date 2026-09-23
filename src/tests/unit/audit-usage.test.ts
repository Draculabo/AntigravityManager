import { describe, expect, it } from 'vitest';

import { extractAuditUsage, mergeAuditUsage } from '@/modules/proxy-gateway/audit/audit-usage';

describe('traffic audit usage extraction', () => {
  it('keeps reported token totals separate from cached and reasoning details', () => {
    expect(
      extractAuditUsage({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 70 },
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 30, cachedTokens: 70, reasoningTokens: 20 });
    expect(
      extractAuditUsage({
        response: {
          usage: {
            input_tokens: 50,
            output_tokens: 10,
            input_tokens_details: { cached_tokens: 12 },
            output_tokens_details: { reasoning_tokens: 4 },
          },
        },
      }),
    ).toEqual({ inputTokens: 50, outputTokens: 10, cachedTokens: 12, reasoningTokens: 4 });
  });

  it('merges Anthropic streaming events without erasing earlier input and cache fields', () => {
    const start = extractAuditUsage({
      type: 'message_start',
      message: { usage: { input_tokens: 38, output_tokens: 1, cache_read_input_tokens: 20 } },
    });
    const delta = extractAuditUsage({ type: 'message_delta', usage: { output_tokens: 7 } });
    expect(mergeAuditUsage(start, delta)).toEqual({
      cachedTokens: 20,
      inputTokens: 38,
      outputTokens: 7,
      reasoningTokens: undefined,
    });
    expect(
      extractAuditUsage({
        events: [
          {
            type: 'message_start',
            message: { usage: { input_tokens: 38, cache_read_input_tokens: 20 } },
          },
          { type: 'message_delta', usage: { output_tokens: 7 } },
        ],
      }),
    ).toEqual({ cachedTokens: 20, inputTokens: 38, outputTokens: 7, reasoningTokens: undefined });
  });

  it('reads Responses completion wrappers and Gemini usage metadata', () => {
    expect(
      extractAuditUsage({
        type: 'response.completed',
        response: { usage: { input_tokens: 11, output_tokens: 5 } },
      }),
    ).toEqual({
      inputTokens: 11,
      outputTokens: 5,
      cachedTokens: undefined,
      reasoningTokens: undefined,
    });
    expect(
      extractAuditUsage({
        response: {
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 2,
            cachedContentTokenCount: 3,
            thoughtsTokenCount: 4,
          },
        },
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 2, cachedTokens: 3, reasoningTokens: 4 });
    expect(
      extractAuditUsage({
        usageMetadata: {
          total_input_tokens: 20,
          total_output_tokens: 6,
          total_cached_tokens: 9,
          total_thought_tokens: 5,
          promptTokenCount: 17,
        },
      }),
    ).toEqual({ inputTokens: 20, outputTokens: 6, cachedTokens: 9, reasoningTokens: 5 });
    expect(extractAuditUsage({ usageMetadata: { totalThoughtTokens: 7 } })).toEqual({
      cachedTokens: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      reasoningTokens: 7,
    });
  });
});
