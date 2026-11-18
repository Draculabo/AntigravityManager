import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { convertOpenAIToClaude } from '@/server/gateway/modules/openai/chat/openai-claude-conversion';
import { buildResponsesChatRequest } from '@/server/gateway/modules/openai/responses/openai-responses-request';

describe('OpenAI conversation order compatibility', () => {
  it('preserves leading system/developer order and wraps only later reminders in place', () => {
    const claudeRequest = convertOpenAIToClaude({
      model: 'gemini-3-flash',
      messages: [
        { role: 'system', content: 'Rule S1.' },
        { role: 'developer', content: 'Rule D1.' },
        { role: 'user', content: 'Inspect the code.' },
        { role: 'assistant', content: 'The inspection is complete.' },
        { role: 'system', content: 'Rule S2.' },
        { role: 'developer', content: 'Rule D2.' },
        { role: 'user', content: 'Continue.' },
      ],
    });

    expect(claudeRequest.system).toBe('Rule S1.\nRule D1.');
    expect(claudeRequest.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Inspect the code.' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'The inspection is complete.' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>\nRule S2.\n</system-reminder>' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>\nRule D2.\n</system-reminder>' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Continue.' }],
      },
    ]);

    const upstream = transformClaudeRequestIn(
      claudeRequest,
      'project',
      'agent',
      undefined,
      'openai',
    );
    expect(upstream.request.systemInstruction?.parts[0]?.text).toBe('Rule S1.\nRule D1.');
    expect(upstream.request.contents.map((message) => message.parts[0]?.text)).toEqual([
      'Inspect the code.',
      'The inspection is complete.',
      '<system-reminder>\nRule S2.\n</system-reminder>',
      '<system-reminder>\nRule D2.\n</system-reminder>',
      'Continue.',
    ]);
  });

  it('does not merge distinct instructions after removing billing metadata', () => {
    const billingLine = 'x-anthropic-billing-header: cc_version=2.0; cc_entrypoint=cli;';
    const claudeRequest = convertOpenAIToClaude({
      model: 'gemini-3-flash',
      messages: [
        { role: 'system', content: `Current date: 2026-10-19\n\nRule A.` },
        { role: 'system', content: `${billingLine}\nCurrent date: 2026-10-20\n\nRule A.` },
        { role: 'user', content: 'Continue.' },
      ],
    });
    const upstream = transformClaudeRequestIn(
      claudeRequest,
      'project',
      'agent',
      undefined,
      'openai',
    );
    const instruction = upstream.request.systemInstruction?.parts[0]?.text ?? '';

    expect(instruction).toContain('Current date: 2026-10-19');
    expect(instruction).toContain('Current date: 2026-10-20');
    expect(instruction.split('Rule A.').length - 1).toBe(2);
    expect(instruction).not.toContain(billingLine);
  });

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
