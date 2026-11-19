import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { decodeAntigravityGenerationResult } from '@/modules/proxy-gateway/antigravity/AntigravityResponseDecoder';
import { ToolConfigurationError } from '@/modules/proxy-gateway/antigravity/ToolChoiceCompat';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';
import { convertOpenAIGenerationTools } from '@/server/gateway/modules/openai/chat/openai-claude-conversion';
import { toOpenAIChatResponse } from '@/server/gateway/modules/openai/chat/openai-chat-response';

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
        includeServerSideToolInvocations: true,
      });
    },
  );

  it('falls back to Gemini Flash for a model outside the web-search allowlist', () => {
    const body = transformClaudeRequestIn(createWebSearchRequest('custom-model'));

    expect(body.model).toBe('gemini-3-flash');
    expect(body.request.tools).toContainEqual({ googleSearch: {} });
  });

  it('rejects requests that mix Google Search with function declarations', () => {
    const request = createWebSearchRequest('gemini-pro-agent');
    request.tools?.push({
      name: 'get_weather',
      description: 'Look up weather.',
      input_schema: { type: 'object', properties: {} },
    });

    expect(() => transformClaudeRequestIn(request)).toThrow(ToolConfigurationError);
  });

  it('keeps an ordinary function named web_search as a function', () => {
    const request: ClaudeRequest = {
      model: 'gemini-pro-agent',
      messages: [{ role: 'user', content: 'Call the project search function.' }],
      tools: [
        {
          name: 'web_search',
          description: 'Search an internal index.',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      tool_choice: { type: 'tool', name: 'web_search' },
    };

    const body = transformClaudeRequestIn(request);

    expect(body.request.tools).toEqual([
      {
        functionDeclarations: [
          expect.objectContaining({
            name: 'web_search',
          }),
        ],
      },
    ]);
    expect(body.request.tools).not.toContainEqual({ googleSearch: {} });
    expect(body.request.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['web_search'] },
      includeServerSideToolInvocations: true,
    });
  });

  it('classifies OpenAI built-ins by declared type instead of function name', () => {
    const ordinaryFunction = convertOpenAIGenerationTools([
      {
        type: 'function',
        function: {
          name: 'google_search',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
    const builtInSearch = convertOpenAIGenerationTools([
      {
        type: 'google_search',
        name: 'custom_search_alias',
      },
    ]);

    expect(ordinaryFunction).toEqual([expect.objectContaining({ name: 'google_search' })]);
    expect(ordinaryFunction?.[0]).not.toHaveProperty('type');
    expect(builtInSearch).toEqual([expect.objectContaining({ type: 'web_search_20250305' })]);
  });

  it('keeps an ordinary OpenAI function named apply_patch on its declared schema', () => {
    const tools = convertOpenAIGenerationTools([
      {
        type: 'function',
        function: {
          name: 'apply_patch',
          parameters: {
            type: 'object',
            properties: { patch: { type: 'string' } },
            required: ['patch'],
          },
        },
      },
    ]);

    expect(tools).toEqual([
      {
        name: 'apply_patch',
        description: undefined,
        input_schema: {
          type: 'object',
          properties: { patch: { type: 'string' } },
          required: ['patch'],
        },
      },
    ]);
  });

  it('preserves ordinary apply_patch function arguments and adapts explicit custom tools', () => {
    const command = `echo ${'long-argument '.repeat(200)}`;
    const decodeToolCall = (args: { command: string } | { input: string }) =>
      decodeAntigravityGenerationResult({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { id: 'call_apply_patch', name: 'apply_patch', args } }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });
    const ordinaryFunction = toOpenAIChatResponse(decodeToolCall({ command }), 'gpt-5-codex', [
      {
        type: 'function',
        function: {
          name: 'apply_patch',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      },
    ]);
    const customTool = toOpenAIChatResponse(
      decodeToolCall({ input: 'patch text' }),
      'gpt-5-codex',
      [{ type: 'custom', name: 'apply_patch' }],
    );

    expect(
      JSON.parse(ordinaryFunction.choices[0].message.tool_calls?.[0].function?.arguments ?? '{}'),
    ).toEqual({ command });
    expect(customTool.choices[0].message.tool_calls).toEqual([
      {
        id: 'call_apply_patch',
        type: 'custom',
        custom: { name: 'apply_patch', input: 'patch text' },
      },
    ]);
  });
});
