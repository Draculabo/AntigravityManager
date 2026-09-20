import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';
import { createGeminiRequestEnvelope } from '@/modules/proxy-gateway/server/modules/gemini/gemini-request-envelope';
import type { GeminiRequest } from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';

function createClaudeRequest(overrides: Partial<ClaudeRequest> = {}): ClaudeRequest {
  return {
    model: 'gemini-3-flash',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

describe('tool-enabled quota routing', () => {
  it.each(['anthropic', 'openai'] as const)(
    'omits requestType and credits for plain %s text requests',
    (source) => {
      const body = transformClaudeRequestIn(
        createClaudeRequest(),
        'project-a',
        'test-agent',
        undefined,
        source,
      );

      expect(body).not.toHaveProperty('requestType');
      expect(body).not.toHaveProperty('enabledCreditTypes');
    },
  );

  it.each(['anthropic', 'openai'] as const)(
    'marks %s requests with tools as agent without adding credits',
    (source) => {
      const body = transformClaudeRequestIn(
        createClaudeRequest({
          tools: [
            {
              name: 'get_weather',
              input_schema: { type: 'object', properties: {} },
            },
          ],
        }),
        'project-a',
        'test-agent',
        undefined,
        source,
      );

      expect(body.requestType).toBe('agent');
      expect(body).not.toHaveProperty('enabledCreditTypes');
    },
  );

  it.each(['anthropic', 'openai'] as const)(
    'marks %s requests with historical tool interaction as agent',
    (source) => {
      const body = transformClaudeRequestIn(
        createClaudeRequest({
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'call-weather',
                  name: 'get_weather',
                  input: {},
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'call-weather',
                  content: 'Sunny',
                },
              ],
            },
          ],
        }),
        'project-a',
        'test-agent',
        undefined,
        source,
      );

      expect(body.requestType).toBe('agent');
      expect(body).not.toHaveProperty('enabledCreditTypes');
    },
  );

  it.each(['anthropic', 'openai'] as const)(
    'marks %s image requests as image_gen without adding credits',
    (source) => {
      const body = transformClaudeRequestIn(
        createClaudeRequest({ model: 'gemini-3-pro-image' }),
        'project-a',
        'test-agent',
        undefined,
        source,
      );

      expect(body.requestType).toBe('image_gen');
      expect(body).not.toHaveProperty('enabledCreditTypes');
    },
  );

  it('omits requestType and credits for a plain native Gemini request', () => {
    const body = createGeminiRequestEnvelope(
      'gemini-3-flash',
      { contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] },
      'project-a',
      'generate-content',
      'test-agent',
      'request-plain',
    );

    expect(body).not.toHaveProperty('requestType');
    expect(body).not.toHaveProperty('enabledCreditTypes');
  });

  it.each([
    {
      name: 'tool declarations',
      request: {
        contents: [{ role: 'user', parts: [{ text: 'Use the tool' }] }],
        tools: [{ functionDeclarations: [{ name: 'get_weather' }] }],
      },
    },
    {
      name: 'historical tool interaction',
      request: {
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { name: 'get_weather', args: {} } }],
          },
        ],
      },
    },
  ] satisfies Array<{ name: string; request: GeminiRequest }>)(
    'marks native Gemini requests with $name as agent with Google One credits',
    ({ request }) => {
      const body = createGeminiRequestEnvelope(
        'gemini-3-flash',
        request,
        'project-a',
        'generate-content',
        'test-agent',
        'request-agent',
      );

      expect(body.requestType).toBe('agent');
      expect(body.enabledCreditTypes).toEqual(['GOOGLE_ONE_AI']);
    },
  );

  it('marks native Gemini image requests as image_gen without credits', () => {
    const body = createGeminiRequestEnvelope(
      'gemini-3-pro-image',
      { contents: [{ role: 'user', parts: [{ text: 'Draw a cat' }] }] },
      'project-a',
      'image_gen',
      'test-agent',
      'request-image',
    );

    expect(body.requestType).toBe('image_gen');
    expect(body).not.toHaveProperty('enabledCreditTypes');
  });
});
