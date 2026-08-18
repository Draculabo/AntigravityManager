import { afterEach, describe, expect, it } from 'vitest';

import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

describe('SignatureStore cross-session tool-call isolation', () => {
  afterEach(() => {
    SignatureStore.clear();
  });

  it('fails closed when the same tool-call id is reused by different sessions', () => {
    const toolCallId = 'call_reused';
    const sessionASignature = 'signature-from-session-a'.repeat(2);
    const sessionBSignature = 'signature-from-session-b'.repeat(3);

    SignatureStore.store(sessionASignature, 'session-a', 1, toolCallId);
    expect(SignatureStore.getForToolCall(toolCallId)).toBe(sessionASignature);

    SignatureStore.store(sessionBSignature, 'session-b', 1, toolCallId);

    expect(SignatureStore.getForToolCall(toolCallId)).toBeNull();
    expect(SignatureStore.getAt('session-a', 1)).toBe(sessionASignature);
    expect(SignatureStore.getAt('session-b', 1)).toBe(sessionBSignature);
  });

  it('keeps direct lookup when the same session updates the tool call', () => {
    const toolCallId = 'call_same_session';
    const shorterSignature = 'short-signature'.repeat(2);
    const longerSignature = 'longer-signature'.repeat(4);

    SignatureStore.store(shorterSignature, 'session-a', 1, toolCallId);
    SignatureStore.store(longerSignature, 'session-a', 1, toolCallId);

    expect(SignatureStore.getForToolCall(toolCallId)).toBe(longerSignature);
  });
});
