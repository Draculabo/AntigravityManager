import { describe, expect, it } from 'vitest';

import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import { MALFORMED_FUNCTION_CALL_RECOVERY_TEXT } from '@/modules/proxy-gateway/antigravity/GeminiFinishReason';
import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';

describe('ClaudeResponseMapper usage', () => {
  it.each([undefined, 0, 2])(
    'shares modality fallback and explicit precedence across unary/start/finish (%s)',
    (thoughtsTokenCount) => {
      const usageMetadata = {
        promptTokenCount: 20,
        candidatesTokenCount: 12,
        thoughtsTokenCount,
        candidatesTokensDetails: [
          { modality: 'THINKING', tokenCount: 4 },
          { modality: 'REASONING', tokenCount: 3 },
          { modality: 'TEXT', tokenCount: 5 },
        ],
      };
      const expected = {
        input_tokens: 20,
        output_tokens: 12,
        cache_read_input_tokens: 0,
        reasoning_tokens: thoughtsTokenCount ?? 7,
      };
      expect(transformResponse({ usageMetadata }).usage).toEqual({
        ...expected,
        cache_creation_input_tokens: 0,
      });
      const state = new StreamingState();
      const start = state.emitMessageStart({ usageMetadata });
      new PartProcessor(state).process({ text: 'ok' });
      const finish = state.emitFinish('STOP', usageMetadata);
      const startData = start.split('\n').find((line) => line.startsWith('data: '));
      const finalData = finish
        .find((chunk) => chunk.startsWith('event: message_delta'))
        ?.split('\n')
        .find((line) => line.startsWith('data: '));
      expect(JSON.parse(startData?.slice(6) ?? '{}').message.usage).toEqual(expected);
      expect(JSON.parse(finalData?.slice(6) ?? '{}').usage).toEqual(expected);
    },
  );

  it('returns one minimal text block when the upstream response has no content', () => {
    expect(transformResponse({}).content).toEqual([{ type: 'text', text: '.' }]);
  });

  it('uses a stable recovery message instead of a blank response for a malformed function call', () => {
    const response = transformResponse({
      candidates: [
        { content: { role: 'model', parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' },
      ],
    });

    expect(response).toMatchObject({
      content: [{ text: MALFORMED_FUNCTION_CALL_RECOVERY_TEXT, type: 'text' }],
      stop_reason: 'end_turn',
    });
  });

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
  it('gives a raw upstream identifier the msg_ prefix an Anthropic client expects', () => {
    const response = transformResponse({ responseId: 'vux3arD5GLnT28oP' });

    expect(response.id).toBe('msg_vux3arD5GLnT28oP');
  });

  it('leaves an upstream identifier that already carries the prefix alone', () => {
    const response = transformResponse({ responseId: 'msg_existing' });

    expect(response.id).toBe('msg_existing');
  });

  it('mints a unique prefixed id when upstream sent none', () => {
    const first = transformResponse({});
    const second = transformResponse({});

    expect(first.id).toMatch(/^msg_[0-9a-f-]{36}$/u);
    expect(first.id).not.toBe(second.id);
  });
});
