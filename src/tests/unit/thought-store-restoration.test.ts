import { describe, expect, it } from 'vitest';

import type { GeminiContent } from '@/modules/proxy-gateway/antigravity/types';
import { hashSessionAnchor } from '@/server/gateway/common/session-anchor-hash';
import {
  findExistingThoughtRecordIndex,
  isStrongerThoughtRecord,
  thoughtSignaturesConflict,
} from '@/modules/proxy-gateway/thought-store/thought-store.matching';
import { mergeHydratedThoughtRecords } from '@/modules/proxy-gateway/thought-store/thought-session-memory';
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
    partSignatures: [
      {
        kind: 'thought',
        position: 0,
        start: 0,
        end: thought.length,
        signature:
          overrides.signature && overrides.signature !== 'skip_thought_signature_validator'
            ? overrides.signature
            : null,
      },
    ],
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
  it('does not revive a persisted placeholder as a real signature', () => {
    const functionCall = { id: 'legacy', name: 'read', args: {} };
    const contents: GeminiContent[] = [{ role: 'model', parts: [{ functionCall }] }];
    expect(
      restoreStoredThoughts(
        contents,
        [
          stored(1, '', 'retained reasoning', {
            signature: 'skip_thought_signature_validator',
            toolIds: ['legacy'],
          }),
        ],
        'gemini-pro-agent',
      ),
    ).toBe(1);
    expect(contents[0].parts).toEqual([
      { text: 'retained reasoning', thought: true },
      { functionCall },
    ]);
  });

  it('locates an earlier signed turn before a later turn reusing the same tool ID', () => {
    const first = stored(1, '', 'first reasoning', {
      signature: 'a'.repeat(60),
      toolIds: ['reused'],
    });
    const second = stored(2, '', 'second reasoning', {
      signature: 'b'.repeat(60),
      toolIds: ['reused'],
    });
    expect(findExistingThoughtRecordIndex(first, [first, second], new Set())).toBe(0);
    expect(findExistingThoughtRecordIndex(first, [first, second], new Set([0]))).toBeNull();
  });

  it('does not merge conflicting signatures through a shared ID or fingerprint', () => {
    const first = stored(1, 'same', 'first reasoning', {
      signature: 'a'.repeat(60),
      toolIds: ['reused'],
    });
    const second = { ...first, signature: 'b'.repeat(60) };
    expect(findExistingThoughtRecordIndex(second, [first], new Set())).toBeNull();
    expect(
      findExistingThoughtRecordIndex(
        { ...second, toolIds: [] },
        [{ ...first, toolIds: [] }],
        new Set(),
      ),
    ).toBeNull();
  });

  it('matches a raw Claude signature with its recognized Google wrapper', () => {
    const rawSignature = Buffer.from([0x08, 0x04, 0x12, ...Array<number>(80).fill(0x7f)]).toString(
      'base64',
    );
    const wrappedSignature = Buffer.from(rawSignature, 'utf8').toString('base64');
    const incoming = stored(1, '', 'reasoning', {
      signature: rawSignature,
      toolIds: ['call-1'],
    });
    const existing = stored(2, '', 'reasoning', {
      signature: wrappedSignature,
      toolIds: ['call-1'],
    });

    expect(thoughtSignaturesConflict(rawSignature, wrappedSignature)).toBe(false);
    expect(findExistingThoughtRecordIndex(incoming, [existing], new Set())).toBe(0);
  });

  it('restores a wrapped record for matching raw Claude history without replacing its signature', () => {
    const rawSignature = Buffer.from([0x08, 0x04, 0x12, ...Array<number>(80).fill(0x7f)]).toString(
      'base64',
    );
    const wrappedSignature = Buffer.from(rawSignature, 'utf8').toString('base64');
    const functionCall = { id: 'call-1', name: 'read', args: {} };
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [{ functionCall, thoughtSignature: rawSignature }],
      },
    ];

    expect(
      restoreStoredThoughts(
        contents,
        [
          stored(1, '', 'retained reasoning', {
            signature: wrappedSignature,
            toolIds: ['call-1'],
          }),
        ],
        'gemini-pro-agent',
      ),
    ).toBe(1);
    expect(contents[0].parts).toEqual([
      {
        text: 'retained reasoning',
        thought: true,
        thoughtSignature: wrappedSignature,
      },
      { functionCall, thoughtSignature: rawSignature },
    ]);
  });

  it('keeps distinct signed turns when a cold snapshot meets an in-flight capture', () => {
    const first = stored(1, '', 'first reasoning', {
      signature: 'a'.repeat(60),
      toolIds: ['reused'],
    });
    const second = stored(2, '', 'second reasoning', {
      signature: 'b'.repeat(60),
      toolIds: ['reused'],
    });
    expect(mergeHydratedThoughtRecords([first], [second])).toEqual([first, second]);
  });

  it('restores the thought belonging to an explicit signature despite a reused tool ID', () => {
    const signature = 'a'.repeat(60);
    const functionCall = { id: 'reused', name: 'read', args: { path: 'first.txt' } };
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [
          { thought: true, text: '...', thoughtSignature: signature },
          { functionCall, thoughtSignature: signature },
        ],
      },
    ];
    expect(
      restoreStoredThoughts(
        contents,
        [
          stored(1, '', 'first reasoning', { signature, toolIds: ['reused'] }),
          stored(2, '', 'second reasoning', {
            signature: 'b'.repeat(60),
            toolIds: ['reused'],
          }),
        ],
        'gemini-pro-agent',
      ),
    ).toBe(1);
    expect(contents[0].parts).toEqual([
      { thought: true, text: 'first reasoning', thoughtSignature: signature },
      { functionCall, thoughtSignature: signature },
    ]);
  });

  it('leaves a signed turn unchanged when only conflicting records are available', () => {
    const signature = 'a'.repeat(60);
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [
          { thought: true, text: '...', thoughtSignature: signature },
          {
            functionCall: { id: 'reused', name: 'read', args: {} },
            thoughtSignature: signature,
          },
        ],
      },
    ];
    const before = structuredClone(contents);
    expect(
      restoreStoredThoughts(
        contents,
        [stored(1, '', 'different turn', { signature: 'b'.repeat(60), toolIds: ['reused'] })],
        'gemini-pro-agent',
      ),
    ).toBe(0);
    expect(contents).toEqual(before);
  });

  it('upgrades sentinel tool history to a real signature without changing tool arguments', () => {
    const signature = 'provider-signature-'.repeat(8);
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [
          { text: '...', thought: true, thoughtSignature: 'skip_thought_signature_validator' },
          {
            functionCall: { id: 'read-1', name: 'read_fixture', args: { path: 'fixture.txt' } },
            thoughtSignature: 'skip_thought_signature_validator',
          },
        ],
      },
    ];
    expect(
      restoreStoredThoughts(
        contents,
        [
          stored(1, '', 'Inspecting the fixture.', {
            signature,
            toolIds: ['read-1'],
            toolNames: ['read_fixture'],
            partSignatures: [
              {
                kind: 'thought',
                position: 0,
                start: 0,
                end: 'Inspecting the fixture.'.length,
                signature,
              },
              {
                kind: 'tool',
                position: 1,
                callId: 'read-1',
                name: 'read_fixture',
                argsDigest: hashSessionAnchor({ path: 'fixture.txt' }),
                signature,
              },
            ],
          }),
        ],
        'gemini-pro-agent',
      ),
    ).toBe(1);
    expect(contents).toEqual([
      {
        role: 'model',
        parts: [
          { text: 'Inspecting the fixture.', thought: true, thoughtSignature: signature },
          {
            functionCall: { id: 'read-1', name: 'read_fixture', args: { path: 'fixture.txt' } },
            thoughtSignature: signature,
          },
        ],
      },
    ]);
    expect(
      restoreStoredThoughts(
        contents,
        [stored(1, '', 'Inspecting the fixture.', { signature, toolIds: ['read-1'] })],
        'gemini-pro-agent',
      ),
    ).toBe(0);
  });
  it('does not restore unrelated history through a category-only fallback', () => {
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

    expect(restored).toBe(0);
    expect(thoughtTexts(contents[0])).toEqual([]);
    expect(thoughtTexts(contents[2])).toEqual([]);
  });

  it('leaves repeated visible answers unchanged when their ownership is ambiguous', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ text: 'same answer' }] },
      { role: 'model', parts: [{ text: 'same answer' }] },
    ];
    const restored = restoreStoredThoughts(
      contents,
      [stored(1, 'same answer', 'first thought'), stored(2, 'same answer', 'second thought')],
      'gemini-pro-agent',
    );

    expect(restored).toBe(0);
    expect(thoughtTexts(contents[0])).toEqual([]);
    expect(thoughtTexts(contents[1])).toEqual([]);
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
    expect(contents[1].parts[0]).toEqual({ text: 'tool thought', thought: true });
    expect(contents[1].parts[1]).toEqual({
      functionCall: { args: {}, id: 'call-1', name: 'shell' },
    });
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
