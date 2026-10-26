import { describe, expect, it } from 'vitest';
import type { GeminiContent } from '@/modules/proxy-gateway/antigravity/types';
import type { ThoughtRecord } from '@/modules/proxy-gateway/thought-store/thought-store.types';
import { restoreStoredThoughts } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import { findExistingThoughtRecordIndex } from '@/modules/proxy-gateway/thought-store/thought-store.matching';

function record(id: number, signature: string, fingerprint = 'same'): ThoughtRecord {
  return {
    createdAt: id,
    fingerprint,
    id,
    model: 'gemini-pro-agent',
    oversized: false,
    oversizedBytes: null,
    oversizedSha256: null,
    signature,
    partSignatures: [
      {
        kind: 'thought',
        position: 0,
        start: 0,
        end: `reasoning-${id}`.length,
        signature: signature || null,
      },
    ],
    sourceFamily: 'gemini-pro',
    thought: `reasoning-${id}`,
    toolIds: ['reused'],
    toolNames: ['read'],
    visible: '',
  };
}

describe('Thought recovery requires unambiguous evidence', () => {
  it('cannot use an unsigned record to reconstruct a turn carrying a real signature', () => {
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: { id: 'reused', name: 'read', args: {} },
            thoughtSignature: 'A'.repeat(60),
          },
        ],
      },
    ];
    const before = structuredClone(contents);
    const unsigned = { ...record(1, ''), signature: null };
    expect(restoreStoredThoughts(contents, [unsigned], 'gemini-pro-agent')).toBe(0);
    expect(contents).toEqual(before);
  });

  it('does not resolve a reused ID merely because one candidate was consumed', () => {
    const incoming = { ...record(3, ''), signature: null, thought: '' };
    expect(
      findExistingThoughtRecordIndex(
        incoming,
        [record(1, 'A'.repeat(60)), record(2, 'B'.repeat(60))],
        new Set([1]),
      ),
    ).toBeNull();
  });

  it('does not choose which identical unsigned turn owns a single stored record', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ text: 'same answer' }] },
      { role: 'model', parts: [{ text: 'same answer' }] },
    ];
    const before = structuredClone(contents);
    const stored = {
      ...record(1, 'A'.repeat(60)),
      toolIds: [],
      toolNames: [],
      visible: 'same answer',
    };
    expect(restoreStoredThoughts(contents, [stored], 'gemini-pro-agent')).toBe(0);
    expect(contents).toEqual(before);
  });

  it('reserves explicit signatures before earlier unsigned ID-only claims', () => {
    const functionCall = { id: 'reused', name: 'read', args: {} };
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall }] },
      {
        role: 'model',
        parts: [{ functionCall, thoughtSignature: 'A'.repeat(60) }],
      },
    ];
    expect(restoreStoredThoughts(contents, [record(1, 'A'.repeat(60))], 'gemini-pro-agent')).toBe(
      1,
    );
    expect(contents[0].parts).toEqual([{ functionCall }]);
    expect(contents[1].parts[0]).toEqual({
      text: 'reasoning-1',
      thought: true,
      thoughtSignature: 'A'.repeat(60),
    });
  });

  it('does not merge an unsigned probe into the newest of two reused-ID records', () => {
    const incoming = { ...record(3, ''), signature: null, thought: '' };
    expect(
      findExistingThoughtRecordIndex(
        incoming,
        [record(1, 'A'.repeat(60)), record(2, 'B'.repeat(60))],
        new Set(),
      ),
    ).toBeNull();
  });

  it('uses the unique matching fingerprint before a later reused-ID candidate', () => {
    const incoming = { ...record(3, '', 'first'), signature: null, thought: '' };
    expect(
      findExistingThoughtRecordIndex(
        incoming,
        [record(1, 'A'.repeat(60), 'first'), record(2, 'B'.repeat(60), 'second')],
        new Set(),
      ),
    ).toBe(0);
  });

  it('leaves reused-ID history unsigned when its original round cannot be determined', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { id: 'reused', name: 'read', args: {} } }] },
    ];
    const before = structuredClone(contents);
    expect(
      restoreStoredThoughts(
        contents,
        [record(1, 'A'.repeat(60)), record(2, 'B'.repeat(60))],
        'gemini-pro-agent',
      ),
    ).toBe(0);
    expect(contents).toEqual(before);
  });

  it('does not restore a thought merely because it is the last record of the same category', () => {
    const contents: GeminiContent[] = [{ role: 'model', parts: [{ text: 'new answer' }] }];
    const before = structuredClone(contents);
    const unrelated = {
      ...record(1, 'A'.repeat(60)),
      toolIds: [],
      toolNames: [],
      visible: 'unrelated stored answer',
    };
    expect(restoreStoredThoughts(contents, [unrelated], 'gemini-pro-agent')).toBe(0);
    expect(contents).toEqual(before);
  });

  it('does not assign repeated visible answers to different thoughts by reverse array order', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ text: 'same answer' }] },
      { role: 'model', parts: [{ text: 'same answer' }] },
    ];
    const before = structuredClone(contents);
    const records = [record(1, 'A'.repeat(60)), record(2, 'B'.repeat(60))].map((item) => ({
      ...item,
      toolIds: [],
      toolNames: [],
      visible: 'same answer',
    }));
    expect(restoreStoredThoughts(contents, records, 'gemini-pro-agent')).toBe(0);
    expect(contents).toEqual(before);
  });

  it('does not treat an arbitrary visible-text prefix as proof of signed-body ownership', () => {
    const contents: GeminiContent[] = [{ role: 'model', parts: [{ text: 'answer' }] }];
    const before = structuredClone(contents);
    const unrelated = {
      ...record(1, 'A'.repeat(60)),
      toolIds: [],
      toolNames: [],
      visible: 'answer from a different turn',
    };
    expect(restoreStoredThoughts(contents, [unrelated], 'gemini-pro-agent')).toBe(0);
    expect(contents).toEqual(before);
  });

  it('still restores a uniquely identified signature despite a reused ID', () => {
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: { id: 'reused', name: 'read', args: {} },
            thoughtSignature: 'A'.repeat(60),
          },
        ],
      },
    ];
    expect(
      restoreStoredThoughts(
        contents,
        [record(1, 'A'.repeat(60)), record(2, 'B'.repeat(60))],
        'gemini-pro-agent',
      ),
    ).toBe(1);
    expect(contents[0]?.parts[0]).toEqual({
      text: 'reasoning-1',
      thought: true,
      thoughtSignature: 'A'.repeat(60),
    });
  });
});
