import { describe, expect, it } from 'vitest';
import {
  OutputTokenLimitConflictError,
  resolveOutputTokenLimit,
} from '@/server/gateway/common/output-token-limit';
import { buildResponsesChatRequest } from '@/server/gateway/modules/openai/responses/openai-responses-request';

describe('output token limit aliases', () => {
  it('accepts equivalent aliases and normalizes Responses to max_tokens', () => {
    const body = {
      model: 'gemini-3-flash',
      input: 'hello',
      max_output_tokens: 256,
      max_completion_tokens: 256,
      maxCompletionTokens: 256,
      maxTokens: 256,
    };

    expect(resolveOutputTokenLimit(body)).toBe(256);
    expect(buildResponsesChatRequest(body).max_tokens).toBe(256);
    expect(body).toEqual({
      model: 'gemini-3-flash',
      input: 'hello',
      max_output_tokens: 256,
      max_completion_tokens: 256,
      maxCompletionTokens: 256,
      maxTokens: 256,
    });
  });

  it('rejects conflicting aliases instead of selecting by field order', () => {
    expect(() =>
      resolveOutputTokenLimit({
        max_tokens: 128,
        max_completion_tokens: 256,
      }),
    ).toThrow(OutputTokenLimitConflictError);
  });

  it('rejects invalid explicit values instead of treating them as absent', () => {
    expect(() => resolveOutputTokenLimit({ maxTokens: 0 })).toThrow(
      'maxTokens must be a positive safe integer',
    );
    expect(() => resolveOutputTokenLimit({ max_output_tokens: 1.5 })).toThrow(
      'max_output_tokens must be a positive safe integer',
    );
  });

  it('returns undefined when no output limit is supplied', () => {
    expect(resolveOutputTokenLimit({ thinking: { budget_tokens: 1024 } })).toBeUndefined();
  });
});
