import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';

function createThinkingRequest(model: string): ClaudeRequest {
  return {
    model,
    max_tokens: 1024,
    thinking: {
      type: 'enabled',
      budget_tokens: 256,
    },
    messages: [
      {
        role: 'user',
        content: 'Explain the fix.',
      },
    ],
  };
}

describe('ClaudeRequestMapper thinking support', () => {
  it('keeps signed tool history when new thinking generation is disabled', () => {
    const signature = 'provider-signature-'.repeat(8);
    const body = transformClaudeRequestIn({
      model: 'gemini-3-flash',
      thinking: { type: 'disabled' },
      messages: [
        { role: 'user', content: 'Read the fixture.' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Inspecting the fixture.', signature },
            {
              type: 'tool_use',
              id: 'read-1',
              name: 'read_fixture',
              input: { path: 'fixture.txt' },
              signature,
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'fixture content' }],
        },
      ],
    });
    expect(body.request.generationConfig?.thinkingConfig).toBeUndefined();
    expect(body.request.contents[1].parts).toEqual([
      {
        text: 'Inspecting the fixture.',
        thought: true,
        thoughtSignature: signature,
        thought_signature: signature,
      },
      {
        functionCall: { id: 'read-1', name: 'read_fixture', args: { path: 'fixture.txt' } },
        thoughtSignature: signature,
        thought_signature: signature,
      },
    ]);
    expect(body.request.contents[2].parts).toEqual([
      {
        functionResponse: {
          id: 'read-1',
          name: 'read_fixture',
          response: { result: 'fixture content' },
        },
      },
    ]);
  });
  it('preserves tool-call arguments instead of treating them as a JSON Schema', () => {
    const body = transformClaudeRequestIn({
      model: 'gemini-3-flash',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call-configure',
              name: 'configure',
              input: {
                default: 'preserve-me',
                examples: ['safe'],
                format: 'json',
              },
            },
          ],
        },
      ],
    });

    const functionCall = body.request.contents[0]?.parts.find(
      (part) => part.functionCall?.id === 'call-configure',
    )?.functionCall;

    expect(functionCall).toEqual(
      expect.objectContaining({
        args: {
          default: 'preserve-me',
          examples: ['safe'],
          format: 'json',
        },
        id: 'call-configure',
        name: 'configure',
      }),
    );
  });

  it.each(['gemini-3.1-pro-low', 'gemini-3-pro-low'])(
    'omits thinkingConfig for low-tier Gemini Pro variant %s',
    (model) => {
      const body = transformClaudeRequestIn(createThinkingRequest(model));

      expect(body.model).toBe(model);
      expect(body.request.generationConfig?.thinkingConfig).toBeUndefined();
    },
  );

  it.each(['gemini-3-pro-agent', 'gemini-3-flash-agent'])(
    'enables thinking by default for Agent model %s',
    (model) => {
      const request = createThinkingRequest(model);
      delete request.thinking;

      const body = transformClaudeRequestIn(request);

      expect(body.model).toBe(model);
      expect(body.request.generationConfig?.thinkingConfig).toMatchObject({
        includeThoughts: true,
      });
    },
  );
});
