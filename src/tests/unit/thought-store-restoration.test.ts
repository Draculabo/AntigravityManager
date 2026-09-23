import { describe, expect, it } from 'vitest';

import type { GeminiContent } from '@/modules/proxy-gateway/antigravity/types';
import {
  findExistingThoughtRecordIndex,
  isStrongerThoughtRecord,
} from '@/modules/proxy-gateway/thought-store/thought-store.matching';
import { restoreStoredThoughts } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import type {
  ThoughtRecord,
  ThoughtRecordInput,
} from '@/modules/proxy-gateway/thought-store/thought-store.types';

function stored(
  id: number,
  visible: string,
  thought: string,
  overrides: Partial<ThoughtRecordInput> = {},
): ThoughtRecord {
  return {
    createdAt: id,
    fingerprint: `fingerprint-${id}`,
    id,
    model: 'gemini-pro-agent',
    oversized: false,
    oversizedBytes: null,
    oversizedSha256: null,
    signature: null,
    sourceFamily: 'gemini-pro',
    thought,
    toolIds: [],
    toolNames: [],
    visible,
    ...overrides,
  };
}

function thoughtTexts(content: GeminiContent): string[] {
  return content.parts.filter((part) => part.thought).map((part) => part.text ?? '');
}

describe('Thought Store history matching', () => {
  it('reserves the category-only fallback for the final model turn', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ text: 'unrelated early answer' }] },
      { role: 'user', parts: [{ text: 'next' }] },
      { role: 'model', parts: [{ text: 'unrelated latest answer' }] },
    ];
    const restored = restoreStoredThoughts(
      contents,
      [stored(1, 'different stored answer', 'latest full thought')],
      'gemini-pro-agent',
    );

    expect(restored).toBe(1);
    expect(thoughtTexts(contents[0])).toEqual([]);
    expect(thoughtTexts(contents[2])).toEqual(['latest full thought']);
  });

  it('assigns repeated visible answers newest-first without reusing a record', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ text: 'same answer' }] },
      { role: 'model', parts: [{ text: 'same answer' }] },
    ];
    const restored = restoreStoredThoughts(
      contents,
      [stored(1, 'same answer', 'first thought'), stored(2, 'same answer', 'second thought')],
      'gemini-pro-agent',
    );

    expect(restored).toBe(2);
    expect(thoughtTexts(contents[0])).toEqual(['first thought']);
    expect(thoughtTexts(contents[1])).toEqual(['second thought']);
  });

  it('does not replace a complete thought or its signature', () => {
    const originalSignature = 'a'.repeat(60);
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [
          { text: 'complete thought', thought: true, thoughtSignature: originalSignature },
          { text: 'answer' },
        ],
      },
    ];
    const before = structuredClone(contents);
    const restored = restoreStoredThoughts(
      contents,
      [stored(1, 'answer', 'different stored thought', { signature: 'b'.repeat(60) })],
      'gemini-pro-agent',
    );

    expect(restored).toBe(0);
    expect(contents).toEqual(before);
  });

  it('keeps tool and text records separate even when their visible text matches', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ text: 'same' }] },
      {
        role: 'model',
        parts: [{ functionCall: { args: {}, id: 'call-1', name: 'shell' } }, { text: 'same' }],
      },
    ];
    const restored = restoreStoredThoughts(
      contents,
      [
        stored(1, 'same', 'text thought'),
        stored(2, 'same', 'tool thought', { toolIds: ['call-1'], toolNames: ['shell'] }),
      ],
      'gemini-pro-agent',
    );

    expect(restored).toBe(2);
    expect(thoughtTexts(contents[0])).toEqual(['text thought']);
    expect(thoughtTexts(contents[1])).toEqual(['tool thought']);
    expect(contents[1].parts[1].thoughtSignature).toBe('skip_thought_signature_validator');
  });

  it('matches repeated inbound history one-to-one and upgrades only stronger records', () => {
    const existing = [stored(1, 'same', 'short'), stored(2, 'same', 'longer thought')];
    const used = new Set<number>();
    const incoming = stored(3, 'same', 'longer thought', { fingerprint: existing[1].fingerprint });
    const first = findExistingThoughtRecordIndex(incoming, existing, used);
    expect(first).toBe(1);
    used.add(first!);
    expect(findExistingThoughtRecordIndex(incoming, existing, used)).toBeNull();
    expect(isStrongerThoughtRecord(incoming, existing[1])).toBe(false);
    expect(
      isStrongerThoughtRecord({ ...incoming, thought: 'expanded full thought' }, existing[1]),
    ).toBe(true);
  });
});
