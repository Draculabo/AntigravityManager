import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hash } from 'node:crypto';
import { hashSessionAnchor } from '@/server/gateway/common/session-anchor-hash';

const writes = vi.hoisted(() => ({ largest: 0, count: 0 }));
beforeEach(() => {
  writes.largest = 0;
  writes.count = 0;
});
describe('incremental session anchor fingerprint', () => {
  it('canonicalizes object key order without changing array order or primitive identity', () => {
    expect(hashSessionAnchor({ a: 1, b: ['x', false, null] })).toBe(
      hashSessionAnchor({ b: ['x', false, null], a: 1 }),
    );
    for (const [a, b] of [
      [
        ['a', 'b'],
        ['b', 'a'],
      ],
      [1, '1'],
      [false, 'false'],
      [null, undefined],
      ['ab', ['a', 'b']],
      [{ a: 'b' }, { ab: '' }],
    ] as const) {
      expect(hashSessionAnchor(a)).not.toBe(hashSessionAnchor(b));
    }
    expect(hashSessionAnchor({ a: 1, optional: undefined })).toBe(hashSessionAnchor({ a: 1 }));
  });
  it('hashes a large media field in bounded pieces without a full JSON serialization', () => {
    const update = Hash.prototype.update;
    const updateSpy = vi.spyOn(Hash.prototype, 'update').mockImplementation(function (
      this: Hash,
      data,
      encoding,
    ) {
      if (typeof data === 'string') {
        writes.largest = Math.max(writes.largest, data.length);
        writes.count += 1;
      }
      return update.call(this, data, encoding);
    });
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new Error('Full serialization is forbidden');
    });
    let digest: string;
    try {
      digest = hashSessionAnchor({
        inlineData: { mimeType: 'image/png', data: 'A'.repeat(3 * 1024 * 1024) },
      });
    } finally {
      stringify.mockRestore();
      updateSpy.mockRestore();
    }
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(writes.largest).toBeLessThanOrEqual(32768);
    expect(writes.count).toBeGreaterThan(96);
  });
  it('preserves Unicode code units across write boundaries and does not merge malformed surrogates', () => {
    const text = 'x'.repeat(32767) + '😀';
    expect(hashSessionAnchor({ text })).toBe(
      hashSessionAnchor({ text: 'x'.repeat(32767) + '\ud83d\ude00' }),
    );
    expect(hashSessionAnchor('\ud800')).not.toBe(hashSessionAnchor('\ufffd'));
    expect(hashSessionAnchor(text)).not.toBe(hashSessionAnchor(text.slice(0, -1)));
  });
  it('handles deep valid data iteratively and permits repeated acyclic references', () => {
    let value: unknown = 'leaf';
    for (let depth = 0; depth < 20000; depth += 1) {
      value = [value];
    }
    expect(hashSessionAnchor(value)).toMatch(/^[a-f0-9]{64}$/);
    const shared = { text: 'same' };
    expect(hashSessionAnchor([shared, shared])).toBe(
      hashSessionAnchor([{ text: 'same' }, { text: 'same' }]),
    );
  });
  it('rejects cycles and non-JSON values without spinning or coalescing them into empty objects', () => {
    const cyclic: { self?: object } = {};
    cyclic.self = cyclic;
    for (const value of [cyclic, NaN, Infinity, () => {}, new Date()]) {
      expect(() => hashSessionAnchor(value)).toThrow();
    }
  });
});
