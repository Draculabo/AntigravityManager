import { describe, expect, it } from 'vitest';

import type { GeminiContent } from '@/modules/proxy-gateway/antigravity/types';
import { findExistingThoughtRecordIndex } from '@/modules/proxy-gateway/thought-store/thought-store.matching';
import { mergeHydratedThoughtRecords } from '@/modules/proxy-gateway/thought-store/thought-session-memory';
import { restoreStoredThoughts } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import type { ThoughtRecord } from '@/modules/proxy-gateway/thought-store/thought-store.types';

function record(model: string | null, sourceFamily: string | null): ThoughtRecord {
  return {
    createdAt: 1,
    fingerprint: 'same-fingerprint',
    id: 1,
    model,
    oversized: false,
    oversizedBytes: null,
    oversizedSha256: null,
    signature: 'opaque-provider-signature-'.repeat(3),
    partSignatures: [
      {
        kind: 'thought',
        position: 0,
        start: 0,
        end: 'source reasoning'.length,
        signature: 'opaque-provider-signature-'.repeat(3),
      },
    ],
    sourceFamily,
    thought: 'source reasoning',
    toolIds: ['shared-call'],
    toolNames: ['read'],
    visible: '',
  };
}

function history(): GeminiContent[] {
  return [
    {
      role: 'model',
      parts: [{ functionCall: { id: 'shared-call', name: 'read', args: { path: 'A' } } }],
    },
  ];
}

describe('Thought Store model ownership', () => {
  it.each([
    ['claude-sonnet-4-6', 'claude', 'claude-opus-4-6-thinking'],
    ['gemini-3.1-pro-high', 'gemini-3', 'gemini-3.7-flash-high'],
    ['claude-sonnet-4-6', 'claude', 'gemini-3.7-flash-high'],
    ['unknown-source', null, 'unknown-target'],
    [null, 'claude', 'claude-sonnet-4-6'],
    [null, null, 'gemini-3.7-flash-high'],
    ['gemini-3.7-flash-high', 'gemini-3', ''],
    [null, null, ''],
    ['unknown-source', 'gemini-3.7-flash', 'gemini-3.7-flash-high'],
  ])('does not restore %s (%s) into %s', (source, sourceFamily, target) => {
    const contents = history();
    const original = structuredClone(contents);
    expect(restoreStoredThoughts(contents, [record(source, sourceFamily)], target!)).toBe(0);
    expect(contents).toEqual(original);
  });

  it.each([
    ['gemini-3.7-flash-low', 'gemini-3', 'gemini-3.7-flash-high'],
    ['gemini-3.6-flash-high', 'gemini-3', 'gemini-3.7-flash-medium'],
    ['claude-opus-4-6', 'claude', 'claude-opus-4-6-thinking'],
    ['claude-sonnet-4-6', null, 'claude-sonnet-4-6-thinking'],
    ['unknown-exact-model', null, 'unknown-exact-model'],
    [' MODELS/Gemini-3.7-Flash-Low ', 'gemini-3', 'models/gemini-3.7-flash-high'],
  ])('restores compatible %s (%s) into %s', (source, sourceFamily, target) => {
    const contents = history();
    const stored = record(source, sourceFamily);
    expect(restoreStoredThoughts(contents, [stored], target)).toBe(1);
    expect(contents[0].parts).toEqual([
      { thought: true, text: stored.thought, thoughtSignature: stored.signature },
      history()[0].parts[0],
    ]);
  });

  it.each([null, 'opaque-provider-signature-'.repeat(3)])(
    'keeps incompatible models separate during matching and cold merging with signature %s',
    (signature) => {
      const source = { ...record('claude-sonnet-4-6', 'claude'), signature };
      const target = {
        ...record('claude-opus-4-6-thinking', 'claude'),
        id: 'captured',
        signature,
        thought: 'target reasoning',
      };
      expect(findExistingThoughtRecordIndex(target, [source], new Set())).toBeNull();
      expect(mergeHydratedThoughtRecords([source], [target])).toEqual([source, target]);
    },
  );

  it('still merges known compatible variants and does not trust the broad legacy family', () => {
    const source = record('gemini-3.7-flash-low', 'gemini-3');
    const target = {
      ...source,
      model: 'gemini-3.7-flash-high',
      thought: 'expanded and longer source reasoning',
    };
    expect(findExistingThoughtRecordIndex(target, [source], new Set())).toBe(0);
    expect(mergeHydratedThoughtRecords([source], [target])).toEqual([{ ...source, ...target }]);
  });
});
