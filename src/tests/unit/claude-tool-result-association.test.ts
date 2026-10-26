import { afterEach, describe, expect, it } from 'vitest';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { InvalidToolResultAssociationError } from '@/modules/proxy-gateway/antigravity/ClaudeToolResultAssociation';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import type {
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from '@/modules/proxy-gateway/antigravity/types';

const call = (id: string, name: string, path = 'fixture'): ToolUseBlock => ({
  type: 'tool_use',
  id,
  name,
  input: { path },
});
const result = (id: string, content = 'output'): ToolResultBlock => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
});
const imageResult = (id: string, data: string): ToolResultBlock => ({
  type: 'tool_result',
  tool_use_id: id,
  content: [
    { type: 'text', text: `${id} output` },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
  ],
});
const assistant = (...content: ToolUseBlock[]): Message => ({ role: 'assistant', content });
const user = (...content: ToolResultBlock[]): Message => ({ role: 'user', content });
const map = (messages: Message[]) =>
  transformClaudeRequestIn({
    model: 'gemini-3-flash',
    thinking: { type: 'disabled' },
    messages,
  }).request.contents;

describe('chronological Claude tool-result association', () => {
  afterEach(() => SignatureStore.clear());

  it('preserves each parallel same-name call and out-of-order result', () => {
    const messages = [
      assistant(call('a', 'read', 'A'), call('b', 'read', 'B')),
      user(result('b', 'B output'), result('a', 'A output')),
    ];
    const before = structuredClone(messages);
    expect(map(messages)).toEqual([
      {
        role: 'model',
        parts: [
          { functionCall: { id: 'a', name: 'read', args: { path: 'A' } } },
          { functionCall: { id: 'b', name: 'read', args: { path: 'B' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'b', name: 'read', response: { result: 'B output' } } },
          { functionResponse: { id: 'a', name: 'read', response: { result: 'A output' } } },
        ],
      },
    ]);
    expect(messages).toEqual(before);
  });

  it('allows an ID to be reused after consumption without changing the earlier name', () => {
    expect(
      map([
        assistant(call('t', 'read')),
        user(result('t', 'first')),
        assistant(call('t', 'write')),
        user(result('t', 'second')),
      ]).flatMap((message) => message.parts.map((part) => part.functionResponse).filter(Boolean)),
    ).toEqual([
      { id: 't', name: 'read', response: { result: 'first' } },
      { id: 't', name: 'write', response: { result: 'second' } },
    ]);
  });

  it('keeps parallel tool responses contiguous before their associated media', () => {
    const parts = map([
      assistant(call('a', 'read'), call('b', 'read')),
      user(imageResult('a', 'QQ=='), imageResult('b', 'Qg==')),
    ])[1]?.parts;

    expect(parts).toEqual([
      { functionResponse: { id: 'a', name: 'read', response: { result: 'a output' } } },
      { functionResponse: { id: 'b', name: 'read', response: { result: 'b output' } } },
      { inlineData: { mimeType: 'image/png', data: 'QQ==' } },
      { inlineData: { mimeType: 'image/png', data: 'Qg==' } },
    ]);
  });

  it.each([
    { name: 'orphan', messages: [user(result('private-id'))], reason: 'missing-pending-call' },
    {
      name: 'future call',
      messages: [user(result('private-id')), assistant(call('private-id', 'private-name'))],
      reason: 'missing-pending-call',
    },
    {
      name: 'duplicate result',
      messages: [assistant(call('t', 'read')), user(result('t'), result('t'))],
      reason: 'missing-pending-call',
    },
    {
      name: 'parallel duplicate ID',
      messages: [assistant(call('t', 'read'), call('t', 'write')), user(result('t'))],
      reason: 'duplicate-pending-id',
    },
    {
      name: 'pending ID reused in a later message',
      messages: [assistant(call('t', 'read')), assistant(call('t', 'write')), user(result('t'))],
      reason: 'duplicate-pending-id',
    },
    {
      name: 'call on user role',
      messages: [{ role: 'user' as const, content: [call('t', 'read')] }],
      reason: 'invalid-role',
    },
    {
      name: 'result on assistant role',
      messages: [
        assistant(call('t', 'read')),
        { role: 'assistant' as const, content: [result('t')] },
      ],
      reason: 'invalid-role',
    },
  ])('rejects $name without leaking tool data', ({ messages, reason }) => {
    let failure: unknown;
    try {
      map(messages);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(InvalidToolResultAssociationError);
    expect(failure).toMatchObject({ reason });
    if (!(failure instanceof InvalidToolResultAssociationError)) {
      throw new Error('Expected a typed association failure');
    }
    expect(failure.getStatus()).toBe(400);
    expect(failure.message).toMatch(/^Invalid tool history at messages\[\d+\].content\[\d+\]: /);
    expect(failure.message).not.toContain('private');
  });

  it('does not require a result for a final pending call', () => {
    expect(map([assistant(call('t', 'read'))])).toEqual([
      {
        role: 'model',
        parts: [{ functionCall: { id: 't', name: 'read', args: { path: 'fixture' } } }],
      },
    ]);
  });

  it('consumes failed results and permits the next round to reuse the ID', () => {
    const failed = { ...result('t', ''), is_error: true };
    expect(
      map([assistant(call('t', 'read')), user(failed), assistant(call('t', 'write'))])[1],
    ).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 't',
            name: 'read',
            response: { result: 'Tool execution failed with no output.' },
          },
        },
      ],
    });
  });
});
