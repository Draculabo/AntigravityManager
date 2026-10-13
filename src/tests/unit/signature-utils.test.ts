import { describe, it, expect } from 'vitest';
import { readThoughtSignature } from '@/modules/proxy-gateway/antigravity/signature-utils';

describe('opaque thought signatures', () => {
  it.each([
    [
      'ASCII protobuf bytes',
      Buffer.from('\x12\x26\x0a\x24' + '00000000-0000-4000-8000-000000000347'),
    ],
    ['non-text binary bytes', Buffer.from([0xff, 0x00, 0x80, 0x12, 0x26])],
    ['printable text bytes', Buffer.from('valid-thinking-signature-12345')],
  ])('preserves the Base64 encoding of %s', (_description, bytes) => {
    const signature = bytes.toString('base64');
    expect(readThoughtSignature(signature)).toBe(signature);
  });

  it.each([
    'plain-text-signature',
    'not!valid@base64#',
    'skip_thought_signature_validator',
    '  opaque  ',
  ])('preserves provider-specific opaque value %j', (signature) => {
    expect(readThoughtSignature(signature)).toBe(signature);
  });

  it.each([null, undefined, ''])('omits an absent signature %j', (signature) => {
    expect(readThoughtSignature(signature)).toBeUndefined();
  });
});
