import { afterEach, describe, expect, it } from 'vitest';

import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

describe('SignatureStore cross-session tool-call isolation', () => {
  const model = 'gemini-3-flash';
  afterEach(() => {
    SignatureStore.clear();
  });

  it('fails closed when the same tool-call id is reused by different sessions', () => {
    const toolCallId = 'call_reused';
    const sessionASignature = 'signature-from-session-a'.repeat(2);
    const sessionBSignature = 'signature-from-session-b'.repeat(3);

    SignatureStore.store({
      signature: sessionASignature,
      model,
      sessionKey: 'session-a',
      messageCount: 1,
      toolCallId,
    });
    expect(SignatureStore.getForToolCall({ model, toolCallId, sessionKey: 'session-a' })).toBe(
      sessionASignature,
    );

    SignatureStore.store({
      signature: sessionBSignature,
      model,
      sessionKey: 'session-b',
      messageCount: 1,
      toolCallId,
    });

    expect(SignatureStore.getForToolCall({ model, toolCallId })).toBeNull();
    expect(SignatureStore.getForToolCall({ model, toolCallId, sessionKey: 'session-a' })).toBe(
      sessionASignature,
    );
    expect(SignatureStore.getForToolCall({ model, toolCallId, sessionKey: 'session-b' })).toBe(
      sessionBSignature,
    );
    expect(SignatureStore.getAt({ model, sessionKey: 'session-a', messageCount: 1 })).toBe(
      sessionASignature,
    );
    expect(SignatureStore.getAt({ model, sessionKey: 'session-b', messageCount: 1 })).toBe(
      sessionBSignature,
    );
  });

  it('keeps direct lookup when the same session updates the tool call', () => {
    const toolCallId = 'call_same_session';
    const shorterSignature = 'short-signature'.repeat(2);
    const longerSignature = 'longer-signature'.repeat(4);

    SignatureStore.store({
      signature: shorterSignature,
      model,
      sessionKey: 'session-a',
      messageCount: 1,
      toolCallId,
    });
    SignatureStore.store({
      signature: longerSignature,
      model,
      sessionKey: 'session-a',
      messageCount: 1,
      toolCallId,
    });

    expect(SignatureStore.getForToolCall({ model, toolCallId, sessionKey: 'session-a' })).toBe(
      longerSignature,
    );
  });
});
