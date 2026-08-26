import { afterEach, describe, expect, it } from 'vitest';

import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

describe('SignatureStore tool-call eviction', () => {
  afterEach(() => {
    SignatureStore.clear();
  });

  it('preserves a recently replayed tool-call signature when capacity is exceeded', () => {
    for (let index = 0; index < 500; index += 1) {
      SignatureStore.store(`signature-${index}`, undefined, undefined, `call-${index}`);
    }

    expect(SignatureStore.getForToolCall('call-0')).toBe('signature-0');

    SignatureStore.store('signature-500', undefined, undefined, 'call-500');

    expect(SignatureStore.getForToolCall('call-0')).toBe('signature-0');
    expect(SignatureStore.getForToolCall('call-1')).toBeNull();
    expect(SignatureStore.getForToolCall('call-500')).toBe('signature-500');
  });
});
