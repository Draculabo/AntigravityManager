import { afterEach, describe, expect, it } from 'vitest';

import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

describe('SignatureStore session eviction', () => {
  afterEach(() => {
    SignatureStore.clear();
  });

  it('preserves an active old session when the session cache exceeds capacity', () => {
    for (let index = 0; index < 500; index += 1) {
      SignatureStore.store(`signature-${index}`, `session-${index}`, 1);
    }

    expect(SignatureStore.get('session-0')).toBe('signature-0');

    SignatureStore.store('signature-500', 'session-500', 1);

    expect(SignatureStore.get('session-0')).toBe('signature-0');
    expect(SignatureStore.get('session-1')).toBeNull();
    expect(SignatureStore.get('session-500')).toBe('signature-500');
  });
});
