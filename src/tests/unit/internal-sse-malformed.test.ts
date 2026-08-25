import { describe, expect, it } from 'vitest';
import { decodeInternalSseData } from '@/modules/proxy-gateway/antigravity/internal-sse';

/**
 * A malformed frame must not take the stream down with it. The decoder documents that it never
 * throws, but a comment is not coverage: this pins the behavior so a later change to the parser
 * cannot quietly turn a bad frame back into a thrown error.
 */
describe('internal SSE decoding of malformed frames', () => {
  const malformed = [
    '{"response":',
    'not json at all',
    '',
    '   ',
    '{"response":{"candidates":[}}',
    '\u0000\u0001',
  ];

  it('never throws on a malformed payload', () => {
    for (const payload of malformed) {
      expect(() => decodeInternalSseData(payload)).not.toThrow();
    }
  });

  it('still decodes a well-formed payload after a malformed one', () => {
    decodeInternalSseData('{"response":');
    const decoded = decodeInternalSseData('{"response":{"candidates":[{"finishReason":"STOP"}]}}');

    expect(decoded).not.toBeNull();
  });
});
