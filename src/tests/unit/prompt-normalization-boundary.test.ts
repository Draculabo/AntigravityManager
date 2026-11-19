import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';
import { buildAntigravityGenerationRequest } from '@/modules/proxy-gateway/antigravity/AntigravityRequestBuilder';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { toOpenAIGenerationInput } from '@/server/gateway/modules/openai/chat/openai-claude-conversion';
import { toInternalGeminiRequest } from '@/server/gateway/modules/gemini/gemini-request-envelope';
import { stripClaudeBillingMetadata } from '@/server/gateway/compatibility/client-billing-metadata';

const billing = 'x-anthropic-billing-header: cc_entrypoint=controlled;';
const attributed = 'You are Example, an AI assistant created by Example Labs.';
const neutral = 'You are an AI Agent.';
const sdk = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const code = "You are Claude Code, Anthropic's official CLI for Claude.";
const codingAssistant = 'You are a coding assistant.';

beforeEach(() => setServerConfig(DEFAULT_APP_CONFIG.proxy));
afterEach(() => setServerConfig(DEFAULT_APP_CONFIG.proxy));

function system(protocol: 'claude' | 'chat' | 'gemini', text: string): string {
  if (protocol === 'gemini') {
    return (
      toInternalGeminiRequest({
        contents: [{ role: 'user', parts: [{ text: 'controlled' }] }],
        systemInstruction: { parts: [{ text }] },
      })
        .systemInstruction?.parts.map((part) => part.text)
        .join('') ?? ''
    );
  }
  const body =
    protocol === 'chat'
      ? buildAntigravityGenerationRequest(
          toOpenAIGenerationInput({
            model: 'gemini-3-flash',
            messages: [
              { role: 'system', content: text },
              { role: 'user', content: 'controlled' },
            ],
          }),
        )
      : transformClaudeRequestIn({
          model: 'gemini-3-flash',
          system: text,
          messages: [{ role: 'user', content: 'controlled' }],
        });
  return body.request.systemInstruction?.parts.map((part) => part.text).join('') ?? '';
}

describe.each(['claude', 'chat', 'gemini'] as const)('%s system text ownership', (protocol) => {
  it.each([
    [sdk, codingAssistant],
    [code, codingAssistant],
    [attributed + '\r\nKeep this exact rule.  ', neutral + '\r\nKeep this exact rule.  '],
    ['You are an AI assistant created by Example Labs  ', neutral + '  '],
    [
      'You are Codex, a coding agent based on GPT-6.1, keep the task unchanged.',
      'You are an AI Agent, keep the task unchanged.',
    ],
    ['You are a helpful assistant.', 'You are a helpful assistant.'],
    [
      'You are a coding agent, and the config was created by Example.',
      'You are a coding agent, and the config was created by Example.',
    ],
    ['First. Second. Third. Fourth. ' + attributed, 'First. Second. Third. Fourth. ' + attributed],
    [
      '<example>\r\n' + attributed + '\r\n' + billing + '\r\n</example>',
      '<example>\r\n' + attributed + '\r\n' + billing + '\r\n</example>',
    ],
    [
      '````text\r\n```\r\n' + billing + '\r\n' + attributed + '\r\n````',
      '````text\r\n```\r\n' + billing + '\r\n' + attributed + '\r\n````',
    ],
    ['~~~text\n' + attributed + '\n' + billing, '~~~text\n' + attributed + '\n' + billing],
    [
      'Keep date 2026-10-31 and trace_deadbeef.\n' +
        billing +
        '\nKeep  C:/project/a  and [undefined].',
      'Keep date 2026-10-31 and trace_deadbeef.\nKeep  C:/project/a  and [undefined].',
    ],
  ])('normalizes only owned unquoted head/metadata: %j', (input, expected) => {
    expect(system(protocol, input)).toBe(expected);
    expect(system(protocol, expected)).toBe(expected);
  });
});

it.each([
  '<quote>\n' + billing + '\n</quote>',
  '<example><code>\n' + billing + '\n</code></example>',
  '````text\n```\n' + billing + '\n````',
  '`inline` ' + billing,
  '``inline ` quote`` ' + billing,
  '~~~text\n~~~```\n' + billing + '\n~~~',
])('preserves protected or mid-line metadata byte for byte: %j', (text) => {
  expect(stripClaudeBillingMetadata(text)).toBe(text);
});

it('never normalizes ordinary user, tool, signed text or literal undefined payloads', () => {
  const request = {
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'user', content: attributed + '\n' + billing },
      {
        role: 'assistant',
        content: [
          { type: 'thinking' as const, thinking: attributed, signature: '[undefined]' },
          {
            type: 'tool_use' as const,
            id: 'controlled-call',
            name: 'read',
            input: { literal: '[undefined]', example: attributed, absent: undefined },
            signature: '[undefined]',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: 'controlled-call',
            content: attributed + '\n' + billing,
          },
        ],
      },
    ],
  };
  const before = structuredClone(request);
  const body = transformClaudeRequestIn(request, undefined, undefined, 'claude-sonnet-4-6');
  expect(body.request.contents[0].parts).toEqual([{ text: attributed + '\n' + billing }]);
  expect(body.request.contents[1].parts).toEqual([
    {
      text: attributed,
      thought: true,
      thoughtSignature: '[undefined]',
      thought_signature: '[undefined]',
    },
    {
      functionCall: {
        id: 'controlled-call',
        name: 'read',
        args: { literal: '[undefined]', example: attributed },
      },
      thoughtSignature: '[undefined]',
      thought_signature: '[undefined]',
    },
  ]);
  expect(body.request.contents[2].parts).toEqual([
    {
      functionResponse: {
        id: 'controlled-call',
        name: 'read',
        response: { result: attributed + '\n' + billing },
      },
    },
  ]);
  expect(request).toStrictEqual(before);
});

it('omits a system instruction whose only owned metadata was removed', () => {
  expect(
    toInternalGeminiRequest({
      contents: [{ role: 'user', parts: [{ text: 'controlled' }] }],
      systemInstruction: { parts: [{ text: billing }] },
    }).systemInstruction,
  ).toBeUndefined();
  expect(
    transformClaudeRequestIn({
      model: 'claude-sonnet-4-6',
      system: billing,
      messages: [{ role: 'user', content: 'controlled' }],
    }).request.systemInstruction,
  ).toBeUndefined();
});

it.each([
  { thought: true },
  { thoughtSignature: 'controlled-signature' },
  { thought_signature: 'controlled-signature' },
])('does not clean a protected native system part: %j', (protection) => {
  const part = { text: sdk + '\n' + billing, ...protection };
  const result = toInternalGeminiRequest({
    contents: [{ role: 'user', parts: [{ text: 'controlled' }] }],
    systemInstruction: { parts: [part] },
  });
  expect(result.systemInstruction?.parts).toStrictEqual([part]);
});

it.each(['claude', 'chat'] as const)(
  'keeps initial block order and later reminder timing through %s mapping',
  (protocol) => {
    const messages = [
      { role: 'system', content: 'Initial rule.  ' },
      { role: 'developer', content: 'Initial rule.  ' },
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first answer' },
      { role: 'system', content: '  ' + attributed + '\nLater rule.  ' },
      { role: 'user', content: 'next request' },
    ];
    const before = structuredClone(messages);
    const body =
      protocol === 'chat'
        ? buildAntigravityGenerationRequest(
            toOpenAIGenerationInput({ model: 'claude-sonnet-4-6', messages }),
          )
        : transformClaudeRequestIn({ model: 'claude-sonnet-4-6', messages });
    expect(body.request.systemInstruction).toEqual({
      parts: [{ text: 'Initial rule.  \nInitial rule.  ' }],
    });
    expect(body.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'first request' }] },
      { role: 'model', parts: [{ text: 'first answer' }] },
      {
        role: 'user',
        parts: [
          { text: '<system-reminder>\n  ' + attributed + '\nLater rule.  \n</system-reminder>' },
        ],
      },
      { role: 'user', parts: [{ text: 'next request' }] },
    ]);
    expect(messages).toStrictEqual(before);
  },
);
