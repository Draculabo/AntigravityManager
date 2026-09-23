import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { convertOpenAIToClaude } from '@/modules/proxy-gateway/server/modules/openai/chat/openai-claude-conversion';
import { buildResponsesChatRequest } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-request';

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

  it('normalizes the stale Codex model identity only in OpenAI system instructions', () => {
    const staleIdentity = 'You are Codex, an agent based on GPT-5.';
    const genericIdentity = 'You are Codex, an agent.';
    const chatRequest = buildResponsesChatRequest({
      model: 'gpt-5-codex',
      instructions: `Top-level: ${staleIdentity}`,
      input: [
        { type: 'message', role: 'system', content: `System: ${staleIdentity}` },
        { type: 'message', role: 'developer', content: `Developer: ${staleIdentity}` },
        { type: 'message', role: 'user', content: `User echo: ${staleIdentity}` },
      ],
    });

    const claudeRequest = convertOpenAIToClaude(chatRequest);
    if (typeof claudeRequest.system !== 'string') {
      throw new Error('Expected an OpenAI system prompt string');
    }
    expect(claudeRequest.system).toContain(genericIdentity);
    expect(claudeRequest.system).not.toContain(staleIdentity);

    const upstream = transformClaudeRequestIn(
      claudeRequest,
      'project',
      'agent',
      undefined,
      'openai',
    );
    const systemText = upstream.request.systemInstruction?.parts
      .map((part) => part.text)
      .join('\n');

    expect(systemText).toContain(genericIdentity);
    expect(systemText).not.toContain(staleIdentity);
    expect(upstream.request.contents).toContainEqual({
      role: 'user',
      parts: [{ text: `User echo: ${staleIdentity}` }],
    });
  });
});
