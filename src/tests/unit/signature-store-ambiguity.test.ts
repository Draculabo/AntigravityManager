import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';

const scope = { model: 'claude-sonnet-4-6', sessionKey: 'ambiguous-signatures' };
const call = { ...scope, toolCallId: 'reused', toolName: 'read' };

afterEach(() => {
  SignatureStore.clear();
  vi.useRealTimers();
});

describe('SignatureStore ambiguous ownership', () => {
  it.each([undefined, 'request-local-signature'])(
    'maps an ambiguous cached call without overriding explicit input (%s)',
    (signature) => {
      SignatureStore.store({ ...call, signature: 'A'.repeat(60) });
      SignatureStore.store({ ...call, signature: 'B'.repeat(80) });
      const result = transformClaudeRequestIn(
        {
          model: scope.model,
          thinking: { type: 'disabled' },
          metadata: { signature_session_key: scope.sessionKey },
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: call.toolCallId, name: 'read', input: {}, signature },
              ],
            },
          ],
        },
        undefined,
        undefined,
        scope.model,
      );
      expect(result.request.contents[0].parts).toEqual([
        {
          functionCall: { id: call.toolCallId, name: 'read', args: {} },
          ...(signature ? { thoughtSignature: signature, thought_signature: signature } : {}),
        },
      ]);
    },
  );

  it.each([
    ['first', 'a longer independent signature'],
    ['a longer independent signature', 'second'],
    ['first', 'other'],
  ])('does not choose opaque values by length (%s / %s)', (first, second) => {
    SignatureStore.store({ ...call, signature: first, messageCount: 1 });
    SignatureStore.store({ ...call, signature: second, messageCount: 3 });
    expect(SignatureStore.getForToolCall(call)).toBeNull();
    expect(SignatureStore.getAt({ ...scope, messageCount: 1 })).toBe(first);
    expect(SignatureStore.getAt({ ...scope, messageCount: 3 })).toBe(second);
  });

  it('does not treat equal message counts as proof of one signed response', () => {
    SignatureStore.store({ ...scope, signature: 'A', messageCount: 1 });
    SignatureStore.store({ ...scope, signature: 'different', messageCount: 1 });
    expect(SignatureStore.getAt({ ...scope, messageCount: 1 })).toBeNull();
    expect(SignatureStore.get(scope)).toBeNull();
  });

  it('keeps incompatible models in separate message-count slots', () => {
    SignatureStore.store({ ...scope, signature: 'sonnet signature', messageCount: 1 });
    SignatureStore.store({
      ...scope,
      model: 'claude-opus-4-6-thinking',
      signature: 'opus signature',
      messageCount: 1,
    });
    expect(SignatureStore.getAt({ ...scope, messageCount: 1 })).toBe('sonnet signature');
    expect(
      SignatureStore.getAt({
        ...scope,
        model: 'claude-opus-4-6-thinking',
        messageCount: 1,
      }),
    ).toBe('opus signature');
    expect(SignatureStore.get(scope)).toBe('sonnet signature');
    expect(SignatureStore.get({ ...scope, model: 'claude-opus-4-6-thinking' })).toBe(
      'opus signature',
    );
  });

  it('does not fall back to an older signature when the latest compatible slot is ambiguous', () => {
    SignatureStore.store({ ...scope, signature: 'old', messageCount: 1 });
    SignatureStore.store({ ...scope, signature: 'new A', messageCount: 3 });
    SignatureStore.store({ ...scope, signature: 'new B longer', messageCount: 3 });
    expect(SignatureStore.get(scope)).toBeNull();
    expect(SignatureStore.getAt({ ...scope, messageCount: 1 })).toBe('old');
  });

  it('cannot revive an ambiguous tool entry by repeating one of its candidates', () => {
    SignatureStore.store({ ...call, signature: 'A' });
    SignatureStore.store({ ...call, signature: 'different B' });
    SignatureStore.store({ ...call, signature: 'A' });
    expect(SignatureStore.getForToolCall(call)).toBeNull();
  });

  it('does not reuse the old signature when an ID is captured under another tool name', () => {
    SignatureStore.store({ ...call, signature: 'same opaque' });
    SignatureStore.store({ ...call, toolName: 'write', signature: 'same opaque' });
    expect(SignatureStore.getForToolCall(call)).toBeNull();
    expect(SignatureStore.getForToolCall({ ...call, toolName: 'write' })).toBeNull();
  });

  it('retains independent physical-model tool entries instead of replacing one with another', () => {
    SignatureStore.store({ ...call, signature: 'sonnet' });
    SignatureStore.store({ ...call, model: 'claude-opus-4-6-thinking', signature: 'opus' });
    expect(SignatureStore.getForToolCall(call)).toBe('sonnet');
    expect(SignatureStore.getForToolCall({ ...call, model: 'claude-opus-4-6-thinking' })).toBe(
      'opus',
    );
  });

  it('recognizes one raw/wrapped signature without selecting the longer representation', () => {
    const raw = Buffer.from([0x08, 0x04, 0x12, ...Array<number>(80).fill(0x7f)]).toString('base64');
    const wrapped = Buffer.from(raw, 'utf8').toString('base64');
    SignatureStore.store({ ...call, signature: raw, messageCount: 1 });
    SignatureStore.store({ ...call, signature: wrapped, messageCount: 1 });
    expect(SignatureStore.getForToolCall(call)).toBe(raw);
    expect(SignatureStore.getAt({ ...scope, messageCount: 1 })).toBe(raw);
  });

  it('recovers normally after explicit scope clearing', () => {
    SignatureStore.store({ ...call, signature: 'A' });
    SignatureStore.store({ ...call, signature: 'different B' });
    SignatureStore.clear(scope.sessionKey);
    SignatureStore.store({ ...call, signature: 'fresh' });
    expect(SignatureStore.getForToolCall(call)).toBe('fresh');
  });

  it('expires a conflict marker at the ordinary TTL before admitting a fresh signature', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    SignatureStore.store({ ...call, signature: 'A' });
    SignatureStore.store({ ...call, signature: 'different B' });
    vi.setSystemTime(60 * 60 * 1000);
    expect(SignatureStore.getForToolCall(call)).toBeNull();
    SignatureStore.store({ ...call, signature: 'fresh' });
    expect(SignatureStore.getForToolCall(call)).toBe('fresh');
  });
});
