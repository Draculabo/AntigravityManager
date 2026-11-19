import { readFileSync } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';

import { OpenAIService as ProxyService } from '../../server/gateway/modules/openai/openai.service';
import { decodeAntigravityGenerationResult } from '@/modules/proxy-gateway/antigravity/AntigravityResponseDecoder';
import type { GeminiResponse } from '@/modules/proxy-gateway/antigravity/types';
import type { OpenAIChatRequest } from '@/server/gateway/common/interfaces/request-interfaces';
import { toOpenAIGenerationInput } from '@/server/gateway/modules/openai/chat/openai-claude-conversion';
import { toOpenAIChatResponse } from '@/server/gateway/modules/openai/chat/openai-chat-response';

const mockAccountLeaseService = {
  getNextToken: vi.fn(),
  markAsRateLimited: vi.fn(),
  markModelSuccess: vi.fn(),
  markAsForbidden: vi.fn(),
  markFromUpstreamError: vi.fn(),
  recordParityError: vi.fn(),
};
const mockGeminiClient = { streamGenerateInternal: vi.fn(), generateInternal: vi.fn() };

class TestableProxyService extends ProxyService {
  constructor() {
    super(
      mockAccountLeaseService as any,
      mockGeminiClient as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  }

  public streamToOpenAI(upstreamStream: any, model: string): Observable<string> {
    return (this as any).processStreamResponse(upstreamStream, model);
  }
}

function readFixture<T>(relativePath: string): T {
  const fullPath = path.join(process.cwd(), 'src/tests/fixtures/proxy-parity', relativePath);
  return JSON.parse(readFileSync(fullPath, 'utf-8')) as T;
}

describe('Proxy Parity Fixtures', () => {
  it('maps the OpenAI request fixture to expected generation semantics', () => {
    const input = readFixture<OpenAIChatRequest>('request/openai.chat-tools.input.json');
    const expected = readFixture<any>('request/openai.chat-tools.expected.json');

    const actual = toOpenAIGenerationInput(input);

    expect(actual.model).toBe(expected.model);
    expect(actual.system).toBe(expected.system);
    expect(actual.parameters.temperature).toBe(expected.temperature);
    expect(actual.parameters.maxOutputTokens).toBe(expected.max_tokens);
    expect(actual.tools?.[0]?.name).toBe(expected.tools[0].name);
    expect(actual.messages[0]).toEqual(expected.messages[0]);
    expect(actual.messages[1].content[1]).toEqual(expected.messages[1].content[1]);
    expect(actual.messages[2].content[0]).toEqual(expected.messages[2].content[0]);
  });

  it('keeps developer instructions, explicit repeats and their whitespace in source order', () => {
    const actual = toOpenAIGenerationInput({
      model: 'gpt-5-codex',
      messages: [
        { role: 'system', content: 'Shared policy.' },
        { role: 'developer', content: '  Shared   policy.  ' },
        { role: 'developer', content: 'Developer-only policy.' },
        { role: 'developer', content: 'Shared policy.' },
        { role: 'user', content: 'Implement the requested change.' },
      ],
    });

    expect(actual.system).toBe(
      'Shared policy.\n  Shared   policy.  \nDeveloper-only policy.\nShared policy.',
    );
    expect(actual.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Implement the requested change.' }],
      },
    ]);
  });

  it('removes Codex-injected tools from function parameter schemas', () => {
    const input: OpenAIChatRequest = {
      model: 'claude-sonnet-4-5',
      tools: [
        {
          type: 'function',
          function: {
            name: 'search_docs',
            description: 'Search docs',
            parameters: {
              type: 'object',
              tools: [{ type: 'function' }],
              properties: {
                query: {
                  type: 'string',
                  tools: [{ type: 'function' }],
                },
              },
            },
          },
        },
      ],
      messages: [{ role: 'user', content: 'Find API key docs' }],
    };

    const actual = toOpenAIGenerationInput(input);

    expect(actual.tools?.[0]?.input_schema).not.toHaveProperty('tools');
    expect(actual.tools?.[0]?.input_schema?.properties?.query).not.toHaveProperty('tools');
  });

  it('maps the Antigravity response fixture to expected OpenAI response semantics', () => {
    const input = readFixture<GeminiResponse>('response/antigravity.tool-use.input.json');
    const expected = readFixture<any>('response/openai.tool-use.expected.json');
    const actual = toOpenAIChatResponse(decodeAntigravityGenerationResult(input), expected.model);

    expect(actual.model).toBe(expected.model);
    expect(actual.choices[0].message.content).toBe(expected.message.content);
    expect(actual.choices[0].message.reasoning_content).toBe(expected.message.reasoning_content);
    expect(actual.choices[0].message.tool_calls?.[0]).toEqual(expected.message.tool_calls[0]);
    expect(actual.choices[0].finish_reason).toBe(expected.finish_reason);
    expect(actual.usage).toEqual(expected.usage);
  });

  it('preserves the upstream shell tool name', () => {
    const actual = toOpenAIChatResponse(
      decodeAntigravityGenerationResult({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { functionCall: { id: 'call_shell', name: 'shell', args: { command: 'pwd' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }),
      'gpt-5-codex',
    );

    expect(actual.choices[0].message.tool_calls?.[0]?.function?.name).toBe('shell');
  });

  it('passes declared custom tool input through the Chat response unchanged', () => {
    const patch = '--- a/example.ts\r\n+++ b/example.ts\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n';
    const actual = toOpenAIChatResponse(
      decodeAntigravityGenerationResult({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { functionCall: { id: 'call_patch', name: 'apply_patch', args: { input: patch } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }),
      'gpt-5-codex',
      [{ type: 'custom', custom: { name: 'apply_patch' } }],
    );
    expect(actual.choices[0].message.tool_calls).toEqual([
      { id: 'call_patch', type: 'custom', custom: { name: 'apply_patch', input: patch } },
    ]);
  });

  it('maps upstream stream fixture into expected OpenAI SSE semantics', async () => {
    const service = new TestableProxyService();
    const input = readFixture<any>('stream/openai-from-gemini.input.json');
    const expected = readFixture<{ contains: string[] }>('stream/openai-from-gemini.expected.json');

    const stream = new EventEmitter();
    const outputChunks: string[] = [];

    const promise = new Promise<void>((resolve, reject) => {
      service.streamToOpenAI(stream, input.model).subscribe({
        next: (chunk) => outputChunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    stream.emit('data', Buffer.from(`data: ${JSON.stringify(input.upstream)}\n`));
    stream.emit('end');

    await promise;

    const output = outputChunks.join('');
    for (const token of expected.contains) {
      expect(output).toContain(token);
    }
  });
});
