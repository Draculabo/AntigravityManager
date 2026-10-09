import { afterEach, describe, expect, it } from 'vitest';

import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

describe('SignatureStore tool-call eviction', () => {
  const model = 'gemini-3-flash';
  const sessionKey = 'tool-call-lru-session';
  afterEach(() => {
    SignatureStore.clear();
  });

  it('preserves a recently replayed tool-call signature when capacity is exceeded', () => {
    for (let index = 0; index < 500; index += 1) {
      SignatureStore.store({
        signature: `signature-${index}`,
        model,
        sessionKey,
        toolCallId: `call-${index}`,
      });
    }

    expect(SignatureStore.getForToolCall({ model, sessionKey, toolCallId: 'call-0' })).toBe(
      'signature-0',
    );

    SignatureStore.store({ signature: 'signature-500', model, sessionKey, toolCallId: 'call-500' });

    expect(SignatureStore.getForToolCall({ model, sessionKey, toolCallId: 'call-0' })).toBe(
      'signature-0',
    );
    expect(SignatureStore.getForToolCall({ model, sessionKey, toolCallId: 'call-1' })).toBeNull();
    expect(SignatureStore.getForToolCall({ model, sessionKey, toolCallId: 'call-500' })).toBe(
      'signature-500',
    );
  });
});
