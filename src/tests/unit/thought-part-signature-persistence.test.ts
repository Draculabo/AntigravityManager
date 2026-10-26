import { describe, expect, it } from 'vitest';

import type { GeminiContent } from '@/modules/proxy-gateway/antigravity/types';
import {
  extractThoughtRecord,
  restoreStoredThoughts,
} from '@/modules/proxy-gateway/thought-store/thought-content';
import { decodeThoughtPartSignatures } from '@/modules/proxy-gateway/thought-store/thought-part-signatures';
import { mergeHydratedThoughtRecords } from '@/modules/proxy-gateway/thought-store/thought-session-memory';
import { ThoughtStoreWorkerCommandSchema } from '@/modules/proxy-gateway/thought-store/thought-store.worker-protocol';
import type { ThoughtRecord } from '@/modules/proxy-gateway/thought-store/thought-store.types';

const model = 'gemini-pro-agent';
const first = {
  functionCall: { id: 'call-a', name: 'read', args: { path: '/a' } },
  thoughtSignature: 'A',
};
const second = {
  functionCall: { id: 'call-b', name: 'read', args: { path: '/b' } },
  thoughtSignature: 'B'.repeat(60),
};
function captured(parts: GeminiContent['parts']): ThoughtRecord {
  const input = extractThoughtRecord({ role: 'model', parts }, model, true);
  if (!input) {
    throw new Error('Expected captured thought record');
  }
  return {
    ...input,
    createdAt: 1,
    id: 1,
    oversized: false,
    oversizedBytes: null,
    oversizedSha256: null,
  };
}
function replay(parts: GeminiContent['parts'], records: ThoughtRecord[]): GeminiContent[] {
  const contents = [{ role: 'model', parts }];
  restoreStoredThoughts(contents, records, model);
  return contents;
}

describe('per-part Thought Store ownership', () => {
  it('restores parallel tool signatures independently, including short opaque signatures', () => {
    const record = captured([first, second]);
    const actual = replay(
      [{ functionCall: first.functionCall }, { functionCall: second.functionCall }],
      [record],
    );
    expect(record.signature).toBeNull();
    expect(actual).toEqual([{ role: 'model', parts: [first, second] }]);
  });

  it('preserves separate reasoning ranges, empty text, Unicode and trailing whitespace', () => {
    const parts = [
      { thought: true, text: '', thoughtSignature: 'empty' },
      { thought: true, text: '中😀  ', thoughtSignature: 'reasoning' },
      first,
      second,
    ];
    const record = captured(parts);
    expect(record.signature).toBeNull();
    expect(record.thought).toBe('中😀  ');
    expect(decodeThoughtPartSignatures(record.partSignatures, record.thought)).toEqual(
      record.partSignatures,
    );
    expect(
      replay(
        [
          { thought: true, text: '...' },
          { functionCall: first.functionCall },
          { functionCall: second.functionCall },
        ],
        [record],
      ),
    ).toEqual([{ role: 'model', parts }]);
  });

  it('uses canonical arguments and never borrows a reasoning signature for an unsigned tool', () => {
    const call = { functionCall: { name: 'read', args: { path: '/a', options: { b: 2, a: 1 } } } };
    const record = captured([
      { thought: true, text: 'inspect', thoughtSignature: 'thought-only' },
      call,
    ]);
    const reordered = {
      functionCall: { name: 'read', args: { options: { a: 1, b: 2 }, path: '/a' } },
    };
    expect(replay([reordered], [record])).toEqual([
      {
        role: 'model',
        parts: [{ thought: true, text: 'inspect', thoughtSignature: 'thought-only' }, reordered],
      },
    ]);
    expect(reordered).not.toHaveProperty('thoughtSignature');
  });

  it.each([undefined, 'duplicate'])('does not guess identical parallel calls with ID %s', (id) => {
    const functionCall = { name: 'read', args: {}, ...(id ? { id } : {}) };
    const record = captured([
      { functionCall, thoughtSignature: 'first' },
      { functionCall, thoughtSignature: 'second' },
    ]);
    const parts = [{ functionCall }, { functionCall }];
    expect(replay(structuredClone(parts), [record])).toEqual([{ role: 'model', parts }]);
  });

  it('restores uniquely identified calls without IDs and preserves existing tool signatures', () => {
    const parts = [first, { ...second, functionCall: { name: 'read', args: { path: '/b' } } }];
    const record = captured(parts);
    const supplied = { functionCall: first.functionCall, thought_signature: 'A' };
    expect(replay([supplied, { functionCall: parts[1].functionCall }], [record])).toEqual([
      { role: 'model', parts: [supplied, parts[1]] },
    ]);
  });

  it('does not recover a signature for a reused ID whose arguments changed', () => {
    const record = captured([first]);
    const parts = [{ functionCall: { ...first.functionCall, args: { path: '/changed' } } }];
    expect(replay(structuredClone(parts), [record])).toEqual([{ role: 'model', parts }]);
  });

  it('does not merge reused-ID rounds with conflicting per-tool signatures and no scalar signature', () => {
    const a = captured([first, second]);
    const b = captured([{ ...first, thoughtSignature: 'different' }, second]);
    expect(mergeHydratedThoughtRecords([a], [b])).toEqual([a, b]);
  });

  it('keeps independently signed reasoning ranges separate when only one signature changes', () => {
    const a = captured([
      { thought: true, text: 'first', thoughtSignature: 'A' },
      { thought: true, text: 'second', thoughtSignature: 'B' },
      first,
    ]);
    const b = captured([
      { thought: true, text: 'first', thoughtSignature: 'A' },
      { thought: true, text: 'second', thoughtSignature: 'C' },
      first,
    ]);
    expect(mergeHydratedThoughtRecords([a], [b])).toEqual([a, b]);
  });

  it('does not duplicate one supplied signed block across identical stored ranges', () => {
    const record = captured([
      { thought: true, text: 'same', thoughtSignature: 'A' },
      { thought: true, text: 'same', thoughtSignature: 'A' },
      first,
    ]);
    const parts = [
      { thought: true, text: 'same', thoughtSignature: 'A' },
      { thought: true, text: 'same' },
      first,
    ];
    expect(replay(structuredClone(parts), [record])).toEqual([{ role: 'model', parts }]);
  });

  it('keeps reasoning ranges and signatures together during partial unsigned hydration', () => {
    const a = captured([
      { thought: true, text: 'source  ', thoughtSignature: 'reasoning' },
      first,
      second,
    ]);
    const b = {
      ...captured([
        { functionCall: first.functionCall },
        { functionCall: second.functionCall },
        { thought: true, text: '...' },
      ]),
      id: 'hot',
    };
    const [merged] = mergeHydratedThoughtRecords([a], [b]);
    expect(merged.thought).toBe('source  ');
    expect(
      replay(
        [{ functionCall: first.functionCall }, { functionCall: second.functionCall }],
        [merged],
      ),
    ).toEqual([
      {
        role: 'model',
        parts: [{ thought: true, text: 'source  ', thoughtSignature: 'reasoning' }, first, second],
      },
    ]);
  });

  it('does not rewrite supplied meaningful signed reasoning when the cache contains longer text', () => {
    const record = captured([
      { thought: true, text: 'original longer reasoning', thoughtSignature: 'same' },
      first,
    ]);
    const parts = [
      { thought: true, text: ' short ', thoughtSignature: 'same' },
      { functionCall: first.functionCall },
    ];
    expect(replay(structuredClone(parts), [record])).toEqual([
      { role: 'model', parts: [parts[0], first] },
    ]);
  });

  it.each(['', '  ', '...'])(
    'preserves explicitly signed text %j when its stored range differs',
    (text) => {
      const record = captured([
        { thought: true, text: 'cached reasoning', thoughtSignature: 'cached' },
        first,
      ]);
      const parts = [
        { thought: true, text, thoughtSignature: 'client-owned' },
        { functionCall: first.functionCall },
      ];
      expect(replay(structuredClone(parts), [record])).toEqual([{ role: 'model', parts }]);
    },
  );

  it('keeps captured reasoning when a later signed replay contains a longer placeholder', () => {
    const original = captured([
      { thought: true, text: 'source', thoughtSignature: 'reasoning' },
      first,
    ]);
    const placeholder = captured([
      {
        thought: true,
        text: 'applying tool decisions and generating response...',
        thoughtSignature: 'reasoning',
      },
      first,
    ]);
    const [record] = mergeHydratedThoughtRecords([original], [placeholder]);
    expect(record.thought).toBe('source');
    expect(record.partSignatures).toEqual(original.partSignatures);
  });

  it('rejects malformed persisted ranges without echoing signature contents', () => {
    const record = captured([
      { thought: true, text: 'text', thoughtSignature: 'secret-signature' },
    ]);
    const malformed = record.partSignatures.map((part) => ({ ...part, end: 100 }));
    expect(() => decodeThoughtPartSignatures(malformed, record.thought)).toThrow(
      'Thought Store contains invalid part signature metadata',
    );
  });

  it('rejects scalar-only worker saves rather than silently accepting the old format', () => {
    expect(
      ThoughtStoreWorkerCommandSchema.safeParse({
        operation: 'save',
        payload: {
          ...captured([first]),
          partSignatures: undefined,
          sessionKey: 'test',
          createdAt: 1,
          maxSessionBytes: 1024,
          maxSessions: 10,
          maxTurns: 10,
          meaningful: true,
        },
      }).success,
    ).toBe(false);
  });
});
