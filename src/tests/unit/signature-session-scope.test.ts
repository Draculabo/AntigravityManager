import { describe, expect, it } from 'vitest';
import {
  resolveAnthropicSessionScope,
  resolveOpenAISessionScope,
} from '@/modules/proxy-gateway/server/common/signature-session-scope';
import type {
  AnthropicChatRequest,
  OpenAIChatRequest,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';

const openAI: OpenAIChatRequest = {
  model: 'gemini-pro-agent',
  messages: [
    { role: 'system', content: 'Read only.' },
    { role: 'user', content: 'Task A' },
  ],
  tools: [{ type: 'function', function: { name: 'read' } }],
};
const anthropic: AnthropicChatRequest = {
  model: 'gemini-pro-agent',
  system: 'Read only.',
  messages: [{ role: 'user', content: 'Task A' }],
  tools: [{ name: 'read' }],
};

const resolveOpenAISignatureScope = (...args: Parameters<typeof resolveOpenAISessionScope>) =>
  resolveOpenAISessionScope(...args).cacheKey;
const resolveAnthropicSignatureScope = (...args: Parameters<typeof resolveAnthropicSessionScope>) =>
  resolveAnthropicSessionScope(...args).cacheKey;

describe('signature conversation scope', () => {
  it('skips empty user preambles instead of merging later distinct tasks', () => {
    const empty = { role: 'user', content: '' };
    expect(resolveOpenAISignatureScope({ ...openAI, messages: [empty, ...openAI.messages] })).toBe(
      resolveOpenAISignatureScope(openAI),
    );
    expect(
      resolveAnthropicSignatureScope({ ...anthropic, messages: [empty, ...anthropic.messages] }),
    ).toBe(resolveAnthropicSignatureScope(anthropic));
  });

  it('uses the complete available history when no meaningful user anchor exists', () => {
    const a: OpenAIChatRequest = {
      ...openAI,
      messages: [
        { role: 'system', content: 'Same system' },
        { role: 'assistant', content: 'Task A history' },
      ],
    };
    expect(
      resolveOpenAISignatureScope({
        ...a,
        messages: [a.messages[0], { role: 'assistant', content: 'Task B history' }],
      }),
    ).not.toBe(resolveOpenAISignatureScope(a));
    expect(resolveOpenAISignatureScope({ ...a, messages: [] })).not.toBe(
      resolveOpenAISignatureScope({ ...a, messages: [] }),
    );
  });
  it('keeps explicit account affinity stable while isolating distinct content anchors', () => {
    const a = resolveOpenAISessionScope({ ...openAI, extra: { session_id: 'shared' } });
    const b = resolveOpenAISessionScope({
      ...openAI,
      extra: { session_id: 'shared' },
      messages: [{ role: 'user', content: 'Task B' }],
    });
    expect(a.affinityKey).toBe(b.affinityKey);
    expect(a.cacheKey).not.toBe(b.cacheKey);
  });

  it('recognizes query session IDs after headers and before body hints', () => {
    const a = resolveOpenAISessionScope(openAI, {}, '/v1/chat/completions?session_id=query');
    expect(a).toEqual(resolveOpenAISessionScope({ ...openAI, extra: { session_id: 'query' } }));
    expect(
      resolveOpenAISessionScope(openAI, { 'x-session-id': 'header' }, '/?session_id=query'),
    ).toEqual(resolveOpenAISessionScope(openAI, { 'x-session-id': 'header' }));
  });
  it('keeps appended turns in the same anonymous conversation', () => {
    expect(
      resolveOpenAISignatureScope({
        ...openAI,
        messages: [
          ...openAI.messages,
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'Continue' },
        ],
      }),
    ).toBe(resolveOpenAISignatureScope(openAI));
    expect(
      resolveAnthropicSignatureScope({
        ...anthropic,
        messages: [
          ...anthropic.messages,
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'Continue' },
        ],
      }),
    ).toBe(resolveAnthropicSignatureScope(anthropic));
  });

  it('separates tasks even when the client reuses a user or session ID', () => {
    for (const extra of [undefined, { user_id: 'same-client' }, { session_id: 'same-session' }]) {
      const a = { ...openAI, extra };
      expect(
        resolveOpenAISignatureScope({ ...a, messages: [{ role: 'user', content: 'Task B' }] }),
      ).not.toBe(resolveOpenAISignatureScope(a));
    }
    for (const metadata of [
      undefined,
      { user_id: 'same-client' },
      { session_id: 'same-session' },
    ]) {
      const a = { ...anthropic, metadata };
      expect(
        resolveAnthropicSignatureScope({ ...a, messages: [{ role: 'user', content: 'Task B' }] }),
      ).not.toBe(resolveAnthropicSignatureScope(a));
    }
  });

  it('includes tenant, header session, system and tool names in the scope', () => {
    const baseline = resolveOpenAISignatureScope(openAI, { authorization: 'Bearer synthetic-a' });
    for (const headers of [
      { authorization: 'Bearer synthetic-b' },
      { authorization: 'Bearer synthetic-a', 'x-session-id': 'other' },
    ]) {
      expect(resolveOpenAISignatureScope(openAI, headers)).not.toBe(baseline);
    }
    expect(resolveOpenAISignatureScope({ ...openAI, tools: [] })).not.toBe(
      resolveOpenAISignatureScope(openAI),
    );
    expect(resolveAnthropicSignatureScope({ ...anthropic, system: 'Different system' })).not.toBe(
      resolveAnthropicSignatureScope(anthropic),
    );
    expect(baseline).not.toContain('synthetic-a');
    expect(baseline).not.toContain('Task A');
  });

  it('uses a specialized header before a generic header or body hint', () => {
    const headers = { 'x-client-session-id': 'stable', 'x-session-id': 'ignored' };
    expect(
      resolveOpenAISignatureScope({ ...openAI, extra: { session_id: 'ignored-body' } }, headers),
    ).toBe(resolveOpenAISignatureScope(openAI, { 'x-client-session-id': 'stable' }));
  });
});
