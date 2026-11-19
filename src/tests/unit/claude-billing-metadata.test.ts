import { describe, expect, it } from 'vitest';
import { stripClaudeBillingMetadata } from '@/server/gateway/compatibility/client-billing-metadata';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type { ClaudeRequest } from '@/modules/proxy-gateway/antigravity/types';

const billing = 'x-anthropic-billing-header: cc_version=2.1.288.test; cc_entrypoint=cli; cch=test;';
const request: ClaudeRequest = {
  model: 'claude-sonnet-4-6-thinking',
  messages: [{ role: 'user', content: 'Create todo.html.' }],
  thinking: { type: 'adaptive' },
  max_tokens: 32000,
  tools: [
    {
      name: 'Write',
      input_schema: { type: 'object', properties: { content: { type: 'string' } } },
    },
  ],
};

describe('Claude Code billing metadata at the system boundary', () => {
  it.each([
    'x-anthropic-billing-header: cc_entrypoint=desktop;',
    '  X-Anthropic-Billing-Header: cch=test; \r\n',
  ])('removes standalone metadata without cc_version (%j)', (metadata) => {
    expect(stripClaudeBillingMetadata(metadata)).toBe('');
    const system = [{ type: 'text', text: 'Keep coding instructions.' }];
    const expected = transformClaudeRequestIn({ ...request, system }, 'test-project');
    const actual = transformClaudeRequestIn(
      { ...request, system: [{ type: 'text', text: metadata }, ...system] },
      'test-project',
    );
    expect(actual.request).toEqual(expected.request);
  });

  it('preserves entrypoint-only metadata in quoted examples and user/tool history', () => {
    const metadata = 'x-anthropic-billing-header: cc_entrypoint=desktop;';
    for (const text of [
      `\`\`\`text\n${metadata}\n\`\`\``,
      `~~~text\n${metadata}`,
      `Example: \`${metadata}\``,
      `> ${metadata}`,
      `Explain ${metadata}`,
    ]) {
      expect(stripClaudeBillingMetadata(text)).toBe(text);
    }
    const messages: ClaudeRequest['messages'] = [
      { role: 'user', content: metadata },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'Write', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: metadata }] },
    ];
    const expected = transformClaudeRequestIn({ ...request, messages }, 'test-project');
    const actual = transformClaudeRequestIn(
      { ...request, messages, system: metadata },
      'test-project',
    );
    expect(actual.request).toEqual(expected.request);
  });

  it('makes the complete outgoing request equal to the same tools and thinking without metadata', () => {
    const system = [{ type: 'text', text: 'Keep all coding instructions and tool descriptions.' }];
    const expected = transformClaudeRequestIn({ ...request, system }, 'test-project');
    const actual = transformClaudeRequestIn(
      { ...request, system: [{ type: 'text', text: billing }, ...system] },
      'test-project',
    );
    expect(actual.request).toEqual(expected.request);
    expect(actual.model).toEqual(expected.model);
    expect(actual.requestType).toEqual(expected.requestType);
  });

  it('removes complete lines while retaining adjacent instructions and session metadata', () => {
    const instructions =
      'Keep session: test-session.\r\n<environment>Use the workspace.</environment>';
    expect(stripClaudeBillingMetadata(`${billing}\r\n${instructions}`)).toBe(instructions);
    expect(stripClaudeBillingMetadata(`First instruction.\n${billing}\nLast instruction.`)).toBe(
      'First instruction.\nLast instruction.',
    );
    expect(stripClaudeBillingMetadata('x-session-id: cc_version=test;')).toBe(
      'x-session-id: cc_version=test;',
    );
  });

  it('preserves code, quoted mentions, and incomplete fenced code byte for byte', () => {
    for (const text of [
      `\`\`\`text\n${billing}\n\`\`\``,
      `~~~text\n${billing}\n~~~`,
      `\`\`\`text\n${billing}`,
      `Example: \`${billing}\``,
      `> ${billing}`,
      `> Quoted example:\n> ${billing}\n> More quoted context.`,
      `Explain the x-anthropic-billing-header: cc_version=example field.`,
    ]) {
      expect(stripClaudeBillingMetadata(text)).toBe(text);
    }
  });

  it('still removes a complete metadata line outside protected quoting', () => {
    expect(stripClaudeBillingMetadata(`> Quoted example.\n${billing}\nKeep this.`)).toBe(
      '> Quoted example.\nKeep this.',
    );
    expect(stripClaudeBillingMetadata(`Before.\n\`\`\`text\n${billing}\n\`\`\`\nAfter.`)).toBe(
      `Before.\n\`\`\`text\n${billing}\n\`\`\`\nAfter.`,
    );
  });

  it('does not filter user messages or signed tool history', () => {
    const history: ClaudeRequest['messages'] = [
      { role: 'user', content: billing },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-test',
            name: 'Write',
            input: {},
            signature: 'test-real-signature',
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-test', content: billing }],
      },
    ];
    const expected = transformClaudeRequestIn({ ...request, messages: history }, 'test-project');
    const actual = transformClaudeRequestIn(
      { ...request, messages: history, system: billing },
      'test-project',
    );
    expect(actual.request).toEqual(expected.request);
    expect(history[0]).toEqual({ role: 'user', content: billing });
  });
});
