import { afterEach, describe, expect, it, vi } from 'vitest';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';
import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import {
  createGateway,
  createLease,
  createAccount,
  createUpstream,
  createReply,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock(
  '@/modules/proxy-gateway/server/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    resolveRequestUserAgent: async () => 'tool-choice-fixture/1',
  }),
);

const tools = ['read_left', 'read_right'].map((name) => ({
  name,
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}));
const choices: [ClaudeRequest['tool_choice'], string, string[] | undefined][] = [
  [undefined, 'VALIDATED', undefined],
  ['auto', 'AUTO', undefined],
  ['none', 'NONE', undefined],
  ['required', 'ANY', undefined],
  [{ type: 'auto' }, 'AUTO', undefined],
  [{ type: 'none' }, 'NONE', undefined],
  [{ type: 'any' }, 'ANY', undefined],
  [{ type: 'tool', name: 'read_left' }, 'ANY', ['read_left']],
  [{ type: 'function', function: { name: 'read_right' } }, 'ANY', ['read_right']],
];

afterEach(() => SignatureStore.clear());

describe('tool choice across the Anthropic boundary', () => {
  it.each(choices)('maps %j to the complete provider tool control', (tool_choice, mode, names) => {
    const request: ClaudeRequest = {
      model: 'gemini-3.1-pro-high',
      messages: [{ role: 'user', content: 'Use the selected tool.' }],
      tools,
      tool_choice,
    };
    const before = structuredClone(request);
    const body = transformClaudeRequestIn(request);
    expect(body.request.toolConfig).toEqual({
      functionCallingConfig: { mode, ...(names ? { allowedFunctionNames: names } : {}) },
      includeServerSideToolInvocations: true,
    });
    expect(request).toEqual(before);
  });

  it('retains a named choice through admission, routing and upstream execution', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('fixture answer') });
    const controller = new AnthropicController(
      createGateway(upstream, createLease([createAccount('choice-account')])).anthropicService,
    );
    const reply = createReply();
    await controller.anthropicMessages(
      {
        model: 'gemini-3.1-pro-high',
        messages: [{ role: 'user', content: 'Use read_right.' }],
        max_tokens: 1024,
        tools,
        tool_choice: { type: 'tool', name: 'read_right' },
        stream: false,
      },
      reply as never,
    );
    expect(reply.statusCode).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].body.request.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_right'] },
      includeServerSideToolInvocations: true,
    });
  });
});
