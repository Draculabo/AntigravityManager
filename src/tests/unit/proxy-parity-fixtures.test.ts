import { readFileSync } from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';

import { OpenAIService as ProxyService } from '../../modules/proxy-gateway/server/modules/openai/openai.service';

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
    super(mockAccountLeaseService as any, mockGeminiClient as any, {} as any);
  }

  public toAnthropic(request: any): any {
    return (this as any).convertOpenAIToClaude(request);
  }

  public toOpenAI(response: any, model: string, clientToolNames?: ReadonlySet<string>): any {
    return (this as any).convertClaudeToOpenAIResponse(response, model, clientToolNames);
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
  it('maps OpenAI request fixture to expected Anthropic request semantics', () => {
    const service = new TestableProxyService();
    const input = readFixture<any>('request/openai.chat-tools.input.json');
    const expected = readFixture<any>('request/openai.chat-tools.expected.json');

    const actual = service.toAnthropic(input);

    expect(actual.model).toBe(expected.model);
    expect(actual.system).toBe(expected.system);
    expect(actual.temperature).toBe(expected.temperature);
    expect(actual.max_tokens).toBe(expected.max_tokens);
    expect(actual.tools?.[0]?.name).toBe(expected.tools[0].name);
    expect(actual.messages[0]).toEqual(expected.messages[0]);
    expect(actual.messages[1].content[1]).toEqual(expected.messages[1].content[1]);
    expect(actual.messages[2].content[0]).toEqual(expected.messages[2].content[0]);
  });

  it('keeps developer instructions in the system prompt and removes duplicates', () => {
    const service = new TestableProxyService();
    const actual = service.toAnthropic({
      model: 'gpt-5-codex',
      messages: [
        { role: 'system', content: 'Shared policy.' },
        { role: 'developer', content: '  Shared   policy.  ' },
        { role: 'developer', content: 'Developer-only policy.' },
        { role: 'user', content: 'Implement the requested change.' },
      ],
    });

    expect(actual.system).toBe('Shared policy.\nDeveloper-only policy.');
    expect(actual.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Implement the requested change.' }],
      },
    ]);
  });

  it('removes Codex-injected tools from function parameter schemas', () => {
    const service = new TestableProxyService();
    const input = {
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

    const actual = service.toAnthropic(input);

    expect(actual.tools?.[0]?.input_schema).not.toHaveProperty('tools');
    expect(actual.tools?.[0]?.input_schema.properties.query).not.toHaveProperty('tools');
  });

  it('maps Anthropic response fixture to expected OpenAI response semantics', () => {
    const service = new TestableProxyService();
    const input = readFixture<any>('response/anthropic.tool-use.input.json');
    const expected = readFixture<any>('response/anthropic.tool-use.expected.json');

    const actual = service.toOpenAI(input, expected.model);

    expect(actual.model).toBe(expected.model);
    expect(actual.choices[0].message.content).toBe(expected.message.content);
    expect(actual.choices[0].message.reasoning_content).toBe(expected.message.reasoning_content);
    expect(actual.choices[0].message.tool_calls?.[0]).toEqual(expected.message.tool_calls[0]);
    expect(actual.choices[0].finish_reason).toBe(expected.finish_reason);
    expect(actual.usage).toEqual(expected.usage);
  });

  it('returns the shell tool name declared by the OpenAI client', () => {
    const service = new TestableProxyService();

    const actual = service.toOpenAI(
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_shell',
            name: 'shell',
            input: { command: 'pwd' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      'gpt-5-codex',
      new Set(['bash']),
    );

    expect(actual.choices[0].message.tool_calls[0].function.name).toBe('bash');
  });

  it('normalizes non-stream apply_patch arguments to repaired freeform input', () => {
    const service = new TestableProxyService();
    const patch = [
      '*** Begin Patch',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -1 +1 @@',
      '-const value = 1;',
      '+const value = 2;',
      '*** End Patch',
    ].join('\n');
    const repairedPatch = [
      '*** Begin Patch',
      '*** Update File: src/example.ts',
      '@@',
      '-const value = 1;',
      '+const value = 2;',
      '*** End Patch',
    ].join('\n');

    const actual = service.toOpenAI(
      {
        content: [
          {
            type: 'tool_use',
            id: 'call_patch',
            name: 'apply_patch',
            input: { command: ['apply_patch', patch] },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      'gpt-5-codex',
    );

    expect(actual.choices[0].message.tool_calls[0].function.arguments).toBe(
      JSON.stringify({ input: repairedPatch }),
    );
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
