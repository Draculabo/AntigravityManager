import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import type { RequestHeaders } from '@/server/gateway/guards/api-key-auth.util';
import {
  resolveAnthropicSessionScope,
  resolveOpenAISessionScope,
} from '@/server/gateway/common/signature-session-scope';
import type {
  AnthropicChatRequest,
  OpenAIChatRequest,
} from '@/server/gateway/common/interfaces/request-interfaces';

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
  afterEach(() => SignatureStore.clear());
  it('fingerprints large initial content without serializing a second complete copy', () => {
    const text = 'A'.repeat(3 * 1024 * 1024);
    const request = { ...openAI, messages: [{ role: 'user', content: text }] };
    const stringify = JSON.stringify;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
      if (
        value === text ||
        value === request ||
        (Array.isArray(value) && value.some((item) => item === text || item === request.messages))
      ) {
        throw new Error('Complete content serialization');
      }
      return stringify(value);
    });
    let result: ReturnType<typeof resolveOpenAISessionScope>;
    try {
      result = resolveOpenAISessionScope(request);
    } finally {
      spy.mockRestore();
    }
    expect(result.cacheKey).toMatch(/^[^:]+:scope:v\d+:[a-f0-9]{64}$/);
    expect(result.cacheKey).not.toContain(text.slice(0, 128));
  });
  it('keeps credential representations equivalent while separating the anonymous scope', () => {
    expect(resolveOpenAISessionScope(openAI, { authorization: 'Bearer synthetic-a' })).toEqual(
      resolveOpenAISessionScope(openAI, { 'x-api-key': 'synthetic-a' }),
    );
    const anonymous = resolveOpenAISessionScope(openAI);
    const named = resolveOpenAISessionScope(openAI, { authorization: 'Bearer anonymous' });
    expect(anonymous.cacheKey).not.toBe(named.cacheKey);
    expect(anonymous.affinityKey).not.toBe(named.affinityKey);
  });
  it('cold-misses legacy scoped signatures without deleting or reading through to them', () => {
    const current = resolveOpenAISessionScope(openAI);
    const legacyKey = current.cacheKey.replace(/^([^:]+):scope:v\d+:/, '$1:scope:');
    expect(legacyKey).not.toBe(current.cacheKey);
    const model = 'gemini-pro-agent';
    SignatureStore.store({
      model,
      sessionKey: legacyKey,
      signature: 'legacy-signature',
      toolCallId: 'call',
      toolName: 'read',
    });
    expect(
      SignatureStore.getForToolCall({
        model,
        sessionKey: current.cacheKey,
        toolCallId: 'call',
        toolName: 'read',
      }),
    ).toBeNull();
    SignatureStore.store({
      model,
      sessionKey: current.cacheKey,
      signature: 'current-signature',
      toolCallId: 'call',
      toolName: 'read',
    });
    expect(
      SignatureStore.getForToolCall({
        model,
        sessionKey: current.cacheKey,
        toolCallId: 'call',
        toolName: 'read',
      }),
    ).toBe('current-signature');
    expect(
      SignatureStore.getForToolCall({
        model,
        sessionKey: legacyKey,
        toolCallId: 'call',
        toolName: 'read',
      }),
    ).toBe('legacy-signature');
  });
  it('keeps all initial system/developer instructions but ignores later system additions in the anchor', () => {
    const initial: OpenAIChatRequest = {
      ...openAI,
      messages: [
        { role: 'system', content: 'Initial A' },
        { role: 'developer', content: 'Initial B' },
        { role: 'user', content: 'Task A' },
      ],
    };
    const baseline = resolveOpenAISessionScope(initial);
    expect(
      resolveOpenAISessionScope({
        ...initial,
        messages: [
          ...initial.messages,
          { role: 'assistant', content: 'ok' },
          { role: 'system', content: 'Later instruction' },
        ],
      }),
    ).toEqual(baseline);
    expect(
      resolveOpenAISessionScope({
        ...initial,
        messages: [
          initial.messages[0],
          { role: 'developer', content: 'Changed initial B' },
          initial.messages[2],
        ],
      }).cacheKey,
    ).not.toBe(baseline.cacheKey);
    const noPrefix = { ...initial, messages: [{ role: 'user', content: 'Task A' }] };
    expect(
      resolveOpenAISessionScope({
        ...noPrefix,
        messages: [...noPrefix.messages, { role: 'system', content: 'Not initial' }],
      }),
    ).toEqual(resolveOpenAISessionScope(noPrefix));
  });
  it('uses the bounded winner for both protocols without weakening tenant isolation', () => {
    for (const resolve of [
      (headers: RequestHeaders) => resolveOpenAISessionScope(openAI, headers),
      (headers: RequestHeaders) => resolveAnthropicSessionScope(anthropic, headers),
    ]) {
      const selected = resolve({
        'a-custom-session-id': 'loser',
        'x-claude-code-session-id': 'winner',
        authorization: 'Bearer synthetic-a',
      });
      expect(selected).toEqual(
        resolve({ 'x-claude-code-session-id': 'winner', authorization: 'Bearer synthetic-a' }),
      );
      const other = resolve({ 'x-claude-code-session-id': 'winner', 'x-api-key': 'synthetic-b' });
      expect(other.cacheKey).not.toBe(selected.cacheKey);
      expect(other.affinityKey).not.toBe(selected.affinityKey);
      expect(selected.hint).toEqual({
        source: 'header',
        field: 'x-claude-code-session-id',
        invalidCandidates: 0,
      });
      expect(JSON.stringify(selected)).not.toMatch(/winner|loser|synthetic-a/);
    }
  });
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
    expect(a).toEqual({
      ...resolveOpenAISessionScope({ ...openAI, extra: { session_id: 'query' } }),
      hint: { source: 'query', field: 'session_id', invalidCandidates: 0 },
    });
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
