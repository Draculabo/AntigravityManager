import { describe, expect, it } from 'vitest';
import { buildResponsesChatRequest, parseResponsesRequestBody } from '@/server/gateway/modules/openai/responses/openai-responses-request';

describe('OpenAI Responses reasoning effort', () => {
  it('preserves reasoning.effort and max_tokens in the internal Chat request', () => {
    const body = parseResponsesRequestBody({
      model: 'gemini-3.5-flash',
      input: 'hello',
      reasoning: {
        effort: 'medium',
        max_tokens: 2048,
      },
    });

    expect(body).not.toBeNull();
    expect(buildResponsesChatRequest(body!)).toMatchObject({
      model: 'gemini-3.5-flash',
      reasoning: {
        effort: 'medium',
        max_tokens: 2048,
      },
    });
  });

  it('rejects a malformed reasoning object instead of silently dropping it', () => {
    expect(
      parseResponsesRequestBody({
        model: 'gemini-3.5-flash',
        input: 'hello',
        reasoning: { effort: 42 },
      }),
    ).toBeNull();
  });
});
