import { describe, expect, it } from 'vitest';

import { buildAntigravityGenerationRequest } from '@/modules/proxy-gateway/antigravity/AntigravityRequestBuilder';
import type { AntigravityGenerationInput } from '@/modules/proxy-gateway/antigravity/generation-input';
import { createGeminiRequestEnvelope } from '@/server/gateway/modules/gemini/gemini-request-envelope';
import type { GeminiRequest } from '@/server/gateway/common/interfaces/request-interfaces';

function buildRequest(overrides: Partial<AntigravityGenerationInput> = {}) {
  return buildAntigravityGenerationRequest(
    {
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'Hello' }],
      parameters: {},
      ...overrides,
    },
    { projectId: 'project-a', userAgent: 'test-agent' },
  );
}

describe('tool-enabled quota routing', () => {
  it('omits requestType and credits for plain text requests', () => {
    const body = buildRequest();
    expect(body).not.toHaveProperty('requestType');
    expect(body).not.toHaveProperty('enabledCreditTypes');
  });

  it('marks requests with tools as agent without adding credits', () => {
    const body = buildRequest({
      tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: {} } }],
    });
    expect(body.requestType).toBe('agent');
    expect(body).not.toHaveProperty('enabledCreditTypes');
  });

  it('marks requests with historical tool interaction as agent', () => {
    const body = buildRequest({
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
    });
    expect(body.requestType).toBe('agent');
    expect(body).not.toHaveProperty('enabledCreditTypes');
  });

  it('marks image requests as image_gen without adding credits', () => {
    const body = buildRequest({ model: 'gemini-3-pro-image' });
    expect(body.requestType).toBe('image_gen');
    expect(body).not.toHaveProperty('enabledCreditTypes');
  });

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
