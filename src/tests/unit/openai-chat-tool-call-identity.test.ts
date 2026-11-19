import { describe, expect, it, vi } from 'vitest';
import { InvalidToolResultAssociationError } from '@/modules/proxy-gateway/antigravity/ClaudeToolResultAssociation';
import type { OpenAIChatRequest } from '@/server/gateway/common/interfaces/request-interfaces';
import { OpenAIService } from '@/server/gateway/modules/openai/openai.service';
import {
  toOpenAIGenerationInput,
  InvalidOpenAIToolArgumentsError,
  normalizeOpenAIChatToolCallIds,
  parseOpenAIFunctionArguments,
} from '@/server/gateway/modules/openai/chat/openai-claude-conversion';

function createRequest(messages: unknown[]): OpenAIChatRequest {
  return {
    model: 'gpt-4o',
    messages,
  } as unknown as OpenAIChatRequest;
}

function missingIdCall(name: string, args = '{"query":"docs"}') {
  return {
    type: 'function',
    function: { name, arguments: args },
  };
}

describe('OpenAI Chat tool-call identity', () => {
  it('parses complete object arguments and rejects incomplete or non-object JSON', () => {
    expect(parseOpenAIFunctionArguments('{"query":"docs"}')).toEqual({ query: 'docs' });
    expect(parseOpenAIFunctionArguments('')).toEqual({});
    expect(() => parseOpenAIFunctionArguments('{"query":')).toThrow(
      expect.objectContaining<Partial<InvalidOpenAIToolArgumentsError>>({
        name: 'InvalidOpenAIToolArgumentsError',
      }),
    );
    expect(() => parseOpenAIFunctionArguments('["docs"]')).toThrow(
      expect.objectContaining<Partial<InvalidOpenAIToolArgumentsError>>({
        name: 'InvalidOpenAIToolArgumentsError',
      }),
    );
  });

  it('generates distinct stable IDs for parallel calls without changing the client history', () => {
    const request = createRequest([
      { role: 'user', content: 'Find these two records.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [missingIdCall('search'), missingIdCall('search')],
      },
    ]);

    const first = normalizeOpenAIChatToolCallIds(request);
    const replay = normalizeOpenAIChatToolCallIds(request);
    const firstIds = first.messages[1]?.tool_calls?.map((call) => call.id);
    const changedHistory = normalizeOpenAIChatToolCallIds(
      createRequest([
        { role: 'user', content: 'Find a different pair of records.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [missingIdCall('search'), missingIdCall('search')],
        },
      ]),
    );

    expect(firstIds).toHaveLength(2);
    expect(new Set(firstIds).size).toBe(2);
    expect(replay.messages[1]?.tool_calls?.map((call) => call.id)).toEqual(firstIds);
    expect(changedHistory.messages[1]?.tool_calls?.[0]?.id).not.toBe(firstIds?.[0]);
    expect(request.messages[1]?.tool_calls?.[0]).not.toHaveProperty('id');
  });

  it('associates one missing-ID result with its unique pending call in the mapped request', () => {
    const request = createRequest([
      { role: 'user', content: 'Find the documentation.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [missingIdCall('search')],
      },
      { role: 'tool', content: 'Found the documentation.' },
    ]);

    const normalized = normalizeOpenAIChatToolCallIds(request);
    const callId = normalized.messages[1]?.tool_calls?.[0]?.id;
    const mapped = toOpenAIGenerationInput(request);
    const blocks = mapped.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    );

    expect(normalized.messages[2]?.tool_call_id).toBe(callId);
    expect(blocks.find((block) => block.type === 'tool_use')).toMatchObject({
      type: 'tool_use',
      id: callId,
    });
    expect(blocks.find((block) => block.type === 'tool_result')).toMatchObject({
      type: 'tool_result',
      tool_use_id: callId,
    });
    expect(request.messages[2]).not.toHaveProperty('tool_call_id');
  });

  it('rejects an ambiguous or orphan result without guessing from its name', () => {
    const ambiguous = createRequest([
      {
        role: 'assistant',
        content: null,
        tool_calls: [missingIdCall('search'), missingIdCall('read')],
      },
      { role: 'tool', name: 'search', content: 'result' },
    ]);
    const orphan = createRequest([{ role: 'tool', name: 'search', content: 'result' }]);

    expect(() => normalizeOpenAIChatToolCallIds(ambiguous)).toThrow(
      expect.objectContaining<Partial<InvalidToolResultAssociationError>>({
        reason: 'ambiguous-missing-id',
      }),
    );
    expect(() => normalizeOpenAIChatToolCallIds(orphan)).toThrow(
      expect.objectContaining<Partial<InvalidToolResultAssociationError>>({
        reason: 'missing-pending-call',
      }),
    );
  });

  it('preserves explicit IDs and permits reuse after their result is consumed', () => {
    const request = createRequest([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'first' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'write', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'second' },
    ]);

    expect(normalizeOpenAIChatToolCallIds(request)).toBe(request);
  });

  it('rejects ambiguous history before selecting an account or dispatching upstream', async () => {
    const accountLease = { getNextToken: vi.fn() };
    const geminiClient = { generateInternal: vi.fn(), streamGenerateInternal: vi.fn() };
    const service = new OpenAIService(
      accountLease as never,
      geminiClient as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const request = createRequest([
      {
        role: 'assistant',
        content: null,
        tool_calls: [missingIdCall('search'), missingIdCall('read')],
      },
      { role: 'tool', content: 'result' },
    ]);

    await expect(service.handleChatCompletions(request)).rejects.toBeInstanceOf(
      InvalidToolResultAssociationError,
    );
    expect(accountLease.getNextToken).not.toHaveBeenCalled();
    expect(geminiClient.generateInternal).not.toHaveBeenCalled();
    expect(geminiClient.streamGenerateInternal).not.toHaveBeenCalled();
  });
});
