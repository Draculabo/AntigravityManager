import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { convertOpenAIToClaude } from '@/modules/proxy-gateway/server/modules/openai/chat/openai-claude-conversion';

describe('OpenAI conversation order compatibility', () => {
  it('prepends a user turn when history starts with an assistant tool call', () => {
    const claudeRequest = convertOpenAIToClaude({
      model: 'gemini-3-flash',
      messages: [
        { role: 'system', content: 'Use tools when needed.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'File contents',
        },
      ],
    });

    const contents = transformClaudeRequestIn(
      claudeRequest,
      'project',
      'agent',
      undefined,
      'openai',
    ).request.contents;

    expect(contents.map((content) => content.role)).toEqual(['user', 'model', 'user']);
    expect(contents[0]).toEqual({
      role: 'user',
      parts: [{ text: 'Continue the task.' }],
    });
    expect(contents[1]).toMatchObject({
      role: 'model',
      parts: [
        {
          functionCall: {
            name: 'read_file',
            args: { path: 'README.md' },
            id: 'call_1',
          },
        },
      ],
    });
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'read_file',
            response: { result: 'File contents' },
            id: 'call_1',
          },
        },
      ],
    });
  });

  it('adds a user turn when system messages are the only effective input', () => {
    const claudeRequest = convertOpenAIToClaude({
      model: 'gemini-3-flash',
      messages: [{ role: 'system', content: 'Use tools when needed.' }],
    });

    const contents = transformClaudeRequestIn(
      claudeRequest,
      'project',
      'agent',
      undefined,
      'openai',
    ).request.contents;

    expect(contents).toEqual([
      {
        role: 'user',
        parts: [{ text: 'Continue' }],
      },
    ]);
  });
});
