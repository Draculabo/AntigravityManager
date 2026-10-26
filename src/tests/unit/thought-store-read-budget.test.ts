import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { unpackThought } from '@/modules/proxy-gateway/thought-store/thought-store.blob';
import { assertThoughtReplyBudget } from '@/modules/proxy-gateway/thought-store/thought-read-budget';
import type { ThoughtRecord } from '@/modules/proxy-gateway/thought-store/thought-store.types';

describe('Thought Store decode budget', () => {
  it('preserves structured-clone text without JSON expansion and bounds aggregate reply data', () => {
    const record: ThoughtRecord = {
      id: 1,
      createdAt: 1,
      fingerprint: 'f',
      model: null,
      sourceFamily: null,
      thought: '\u0000'.repeat(18 * 1024 * 1024),
      signature: null,
      partSignatures: [],
      toolIds: [],
      toolNames: [],
      visible: '',
      oversized: false,
      oversizedBytes: null,
      oversizedSha256: null,
    };
    expect(() => assertThoughtReplyBudget([record])).not.toThrow();
    const large = { ...record, thought: 'x'.repeat(51 * 1024 * 1024) };
    expect(() => assertThoughtReplyBudget([large, { ...large, id: 2 }])).toThrow(/read.*budget/u);
    expect(() => assertThoughtReplyBudget([{ ...record, thought: 'valid' }])).not.toThrow();
  });
  it('refuses gzip expansion above the selected record budget', () => {
    const value = Buffer.concat([Buffer.from('AGZ1'), gzipSync('x'.repeat(8192))]);
    expect(() => unpackThought(value, 7, 1024)).toThrow(/decode budget/u);
  });
  it('applies the same budget to raw and legacy blobs and preserves valid Unicode', () => {
    const text = 'reasoning 中文';
    for (const prefix of ['', 'RAW1', 'AGZ1']) {
      const bytes = Buffer.from(text);
      const value = Buffer.concat([
        Buffer.from(prefix),
        prefix === 'AGZ1' ? gzipSync(bytes) : bytes,
      ]);
      expect(unpackThought(value, 8, bytes.length)).toBe(text);
      expect(() => unpackThought(value, 8, bytes.length - 1)).toThrow(/decode budget/u);
    }
  });
});
