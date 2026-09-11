import { afterEach, describe, expect, it } from 'vitest';

import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

describe('SignatureStore session eviction', () => {
  const model = 'gemini-3-flash';
  afterEach(() => {
    SignatureStore.clear();
  });

  it('preserves an active old session when the session cache exceeds capacity', () => {
    for (let index = 0; index < 500; index += 1) {
      SignatureStore.store({
        signature: `signature-${index}`,
        model,
        sessionKey: `session-${index}`,
        messageCount: 1,
      });
    }

    expect(SignatureStore.get({ model, sessionKey: 'session-0' })).toBe('signature-0');

    SignatureStore.store({
      signature: 'signature-500',
      model,
      sessionKey: 'session-500',
      messageCount: 1,
    });

    expect(SignatureStore.get({ model, sessionKey: 'session-0' })).toBe('signature-0');
    expect(SignatureStore.get({ model, sessionKey: 'session-1' })).toBeNull();
    expect(SignatureStore.get({ model, sessionKey: 'session-500' })).toBe('signature-500');
  });
});
