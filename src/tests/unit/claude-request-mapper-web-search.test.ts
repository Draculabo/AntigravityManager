import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';

function createWebSearchRequest(model: string): ClaudeRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'Find the latest documentation.' }],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
      },
    ],
  };
}

describe('ClaudeRequestMapper web-search model compatibility', () => {
  it.each(['gemini-pro-agent', 'gemini-3.5-flash-high', 'agent-pro'])(
    'keeps allowlisted model %s when web search is enabled',
    (model) => {
      const body = transformClaudeRequestIn(createWebSearchRequest(model));

      expect(body.model).toBe(model);
      expect(body.request.tools).toContainEqual({ googleSearch: {} });
      expect(body.request.toolConfig).toEqual({
        functionCallingConfig: { mode: 'VALIDATED' },
        includeServerSideToolInvocations: true,
      });
    },
  );

  it('falls back to Gemini Flash for a model outside the web-search allowlist', () => {
    const body = transformClaudeRequestIn(createWebSearchRequest('custom-model'));

    expect(body.model).toBe('gemini-3-flash');
    expect(body.request.tools).toContainEqual({ googleSearch: {} });
  });

  it('keeps Google Search mutually exclusive with function declarations', () => {
    const request = createWebSearchRequest('gemini-pro-agent');
    request.tools?.push({
      name: 'get_weather',
      description: 'Look up weather.',
      input_schema: { type: 'object', properties: {} },
    });

    const body = transformClaudeRequestIn(request);

    expect(body.request.tools).toEqual([
      {
        functionDeclarations: [
          expect.objectContaining({
            name: 'get_weather',
          }),
        ],
      },
    ]);
    expect(body.request.tools).not.toContainEqual({ googleSearch: {} });
  });
});
