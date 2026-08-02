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
  it.each(['gemini-3.1-pro-low', 'gemini-3-pro-low'])(
    'omits thinkingConfig for low-tier Gemini Pro variant %s',
    (model) => {
      const body = transformClaudeRequestIn(createThinkingRequest(model));

      expect(body.model).toBe(model);
      expect(body.request.generationConfig?.thinkingConfig).toBeUndefined();
    },
  );

  it.each(['gemini-3.1-pro-high', 'gemini-3-pro-high'])(
    'routes high-tier Gemini Pro variant %s through gemini-pro-agent',
    (model) => {
      const body = transformClaudeRequestIn(createThinkingRequest(model));

      expect(body.model).toBe('gemini-pro-agent');
      expect(body.request.generationConfig?.thinkingConfig).toEqual({
        includeThoughts: true,
        thinkingBudget: 256,
      });
    },
  );

  it.each(['gemini-pro-agent', 'gemini-3-pro-agent', 'gemini-3-flash-agent'])(
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
