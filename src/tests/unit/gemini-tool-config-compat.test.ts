import { afterEach, describe, expect, it, vi } from 'vitest';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import {
  GeminiToolConfigAliasesSchema,
  normalizeGeminiToolConfigAliases,
  canCacheGeminiToolConfig,
  toSnakeToolConfig,
} from '@/modules/proxy-gateway/antigravity/GeminiToolConfigCompat';
import { ExplicitContextCacheManager } from '@/modules/proxy-gateway/server/modules/gemini/explicit-context-cache.store';
import type { GeminiToolConfig } from '@/modules/proxy-gateway/antigravity/types';

afterEach(() => vi.unstubAllEnvs());
describe('Gemini tool configuration compatibility', () => {
  it.each([
    undefined,
    'none',
    'auto',
    'required',
    { type: 'function', function: { name: 'read_file' } },
  ])('emits both aliases for OpenAI function choice %j', (tool_choice) => {
    const result = transformClaudeRequestIn(
      {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'Read' }],
        tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
        tool_choice,
      },
      '',
      'test',
      undefined,
      'openai',
    ).request;
    const mode =
      tool_choice === undefined
        ? 'VALIDATED'
        : tool_choice === 'none'
          ? 'NONE'
          : tool_choice === 'auto'
            ? 'AUTO'
            : 'ANY';
    expect(result.toolConfig).toEqual({
      functionCallingConfig: { mode },
      includeServerSideToolInvocations: true,
    });
    expect(result.tool_config).toEqual({
      function_calling_config: { mode },
      include_server_side_tool_invocations: true,
    });
    expect(result.tools).toHaveLength(1);
    expect(result.tools?.[0]).not.toHaveProperty('googleSearch');
  });
  it('keeps the different OpenAI and Anthropic search-only behavior', () => {
    const request = {
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'Search' }],
      tools: [{ name: 'web_search', type: 'web_search_20250305' }],
    };
    const openai = transformClaudeRequestIn(request, '', 'test', undefined, 'openai').request;
    const anthropic = transformClaudeRequestIn(request, '', 'test', undefined, 'anthropic').request;
    expect(openai.tools).toBeDefined();
    expect(openai.toolConfig).toBeUndefined();
    expect(openai.tool_config).toBeUndefined();
    expect(anthropic.tool_config).toEqual({
      function_calling_config: { mode: 'VALIDATED' },
      include_server_side_tool_invocations: true,
    });
  });
  it('treats empty tools, empty config and missing config separately', () => {
    expect(normalizeGeminiToolConfigAliases({ tools: [] })).toEqual({
      toolConfig: {
        functionCallingConfig: { mode: 'VALIDATED' },
        includeServerSideToolInvocations: true,
      },
      tool_config: {
        function_calling_config: { mode: 'VALIDATED' },
        include_server_side_tool_invocations: true,
      },
    });
    expect(
      normalizeGeminiToolConfigAliases({ tools: [], toolConfig: {}, tool_config: {} }),
    ).toEqual({
      toolConfig: { includeServerSideToolInvocations: true },
      tool_config: { include_server_side_tool_invocations: true },
    });
    const noTools = {
      toolConfig: {
        functionCallingConfig: { mode: 'NONE' },
        includeServerSideToolInvocations: false,
      },
    };
    expect(normalizeGeminiToolConfigAliases(noTools)).toEqual({
      ...noTools,
      tool_config: undefined,
    });
  });
  it('preserves extensions, allowed names and independent alias defaults without mutation', () => {
    const input = {
      tools: [],
      toolConfig: {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['read_file'],
          providerOption: 1,
        },
        extension: { enabled: true },
        includeServerSideToolInvocations: false,
      },
    };
    const before = structuredClone(input);
    const parsed = GeminiToolConfigAliasesSchema.parse(input);
    const result = normalizeGeminiToolConfigAliases({ ...parsed, tools: input.tools });
    expect(result).toEqual({
      toolConfig: { ...input.toolConfig, includeServerSideToolInvocations: true },
      tool_config: {
        function_calling_config: { mode: 'VALIDATED' },
        include_server_side_tool_invocations: true,
      },
    });
    expect(input).toEqual(before);
    expect(canCacheGeminiToolConfig(result)).toBe(false);
  });
  it.each([
    null,
    [],
    7,
    { functionCallingConfig: [] },
    { includeServerSideToolInvocations: 'true' },
    { functionCallingConfig: { allowedFunctionNames: [1] } },
  ])('rejects malformed camel alias %j', (toolConfig) => {
    expect(GeminiToolConfigAliasesSchema.safeParse({ toolConfig }).success).toBe(false);
  });
  it('bypasses conflicting, snake-only and unrepresentable configurations', () => {
    expect(canCacheGeminiToolConfig({ tool_config: {} })).toBe(false);
    expect(
      canCacheGeminiToolConfig({ toolConfig: {}, tool_config: { function_calling_config: {} } }),
    ).toBe(false);
    expect(
      canCacheGeminiToolConfig({
        toolConfig: { functionCallingConfig: { mode: 'ANY' } },
        tool_config: { function_calling_config: { mode: 'NONE' } },
      }),
    ).toBe(false);
    const extended = { functionCallingConfig: { mode: 'ANY' }, extension: true };
    expect(canCacheGeminiToolConfig({ toolConfig: extended })).toBe(false);
  });
  it('includes every represented semantic change in the cache identity', () => {
    vi.stubEnv('PROXY_CONTEXT_CACHE_MIN_CHARACTERS', '1');
    const configs: GeminiToolConfig[] = [
      {},
      { functionCallingConfig: {} },
      { functionCallingConfig: { mode: 'ANY' } },
      { functionCallingConfig: { mode: 'NONE' } },
      { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read'] } },
      { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['write'] } },
      { includeServerSideToolInvocations: true },
      { includeServerSideToolInvocations: false },
    ];
    const manager = new ExplicitContextCacheManager();
    const keys = configs.map((toolConfig) => {
      const candidate = manager.createCandidate({
        model: 'gemini-3-flash',
        project: 'project-test',
        requestId: 'fixture',
        userAgent: 'test',
        request: {
          contents: [],
          tools: [{ functionDeclarations: [{ name: 'read' }] }],
          toolConfig,
          tool_config: toSnakeToolConfig(toolConfig),
        },
      });
      expect(candidate).not.toBeNull();
      return candidate?.key;
    });
    expect(new Set(keys).size).toBe(configs.length);
  });
});
