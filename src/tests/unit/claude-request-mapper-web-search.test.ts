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
    },
  );

  it('falls back to Gemini Flash for a model outside the web-search allowlist', () => {
    const body = transformClaudeRequestIn(createWebSearchRequest('custom-model'));

    expect(body.model).toBe('gemini-3-flash');
    expect(body.request.tools).toContainEqual({ googleSearch: {} });
  });
});
