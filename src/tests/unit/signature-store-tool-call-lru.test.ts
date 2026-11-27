import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

describe('SignatureStore tool-call eviction', () => {
  const model = 'gemini-3-flash';
  const sessionKey = 'tool-call-lru-session';
  afterEach(() => {
    SignatureStore.clear();
    vi.useRealTimers();
  });

  it('evicts the earliest tool-call capture when replay does not change its age', () => {
    vi.useFakeTimers();
    for (let index = 0; index < 5_000; index += 1) {
      vi.setSystemTime(index);
      SignatureStore.store({
        signature: `signature-${index}`,
        model,
        sessionKey,
        messageCount: index,
        toolCallId: `call-${index}`,
      });
    }

    expect(SignatureStore.getForToolCall({ model, sessionKey, toolCallId: 'call-0' })).toBe(
      'signature-0',
    );

    vi.setSystemTime(5_000);
    SignatureStore.store({
      signature: 'signature-5000',
      model,
      sessionKey,
      messageCount: 5_000,
      toolCallId: 'call-5000',
    });

    expect(SignatureStore.getForToolCall({ model, sessionKey, toolCallId: 'call-0' })).toBeNull();
    expect(SignatureStore.getForToolCall({ model, sessionKey, toolCallId: 'call-1' })).toBe(
      'signature-1',
    );
    expect(SignatureStore.getForToolCall({ model, sessionKey, toolCallId: 'call-5000' })).toBe(
      'signature-5000',
    );
  }, 30_000);
});
