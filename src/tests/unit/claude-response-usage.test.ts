import { describe, expect, it } from 'vitest';

import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';

describe('ClaudeResponseMapper usage', () => {
  it('maps Gemini implicit cache and thinking counts into Claude-compatible usage', () => {
    const response = transformResponse({
      usageMetadata: {
        cachedContentTokenCount: 700,
        candidatesTokenCount: 260,
        promptTokenCount: 1000,
        thoughtsTokenCount: 140,
      },
    });

    expect(response.usage).toMatchObject({
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 700,
      input_tokens: 1000,
      output_tokens: 260,
      reasoning_tokens: 140,
    });
  });

  it('maps Interactions usage fields without dropping cache or thought tokens', () => {
    const response = transformResponse({
      usageMetadata: {
        total_input_tokens: 1200,
        total_output_tokens: 80,
        total_cached_tokens: 900,
        total_thought_tokens: 35,
        total_tokens: 1315,
      },
    });

    expect(response.usage).toMatchObject({
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 900,
      input_tokens: 1200,
      output_tokens: 80,
      reasoning_tokens: 35,
    });
  });

  it('preserves prompt safety feedback as an explicit refusal', () => {
    const response = transformResponse({
      candidates: [],
      promptFeedback: {
        blockReason: 'SAFETY',
      },
    });

    expect(response).toMatchObject({
      refusal: 'Request blocked by safety policy (blockReason: SAFETY)',
      stop_reason: 'content_filter',
    });
  });
});
