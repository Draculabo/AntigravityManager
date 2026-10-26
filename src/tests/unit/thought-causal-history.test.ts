import { describe, expect, it } from 'vitest';
import { thoughtCausalHistory } from '@/modules/proxy-gateway/thought-store/thought-causal-history';
import type { GeminiContent } from '@/modules/proxy-gateway/antigravity/types';

describe('complete reasoning round candidates', () => {
  it('distinguishes repeated assistant rounds and retains prefix identity when appending history', () => {
    const content: GeminiContent[] = [
      { role: 'user', parts: [{ text: 'Proceed' }] },
      { role: 'model', parts: [{ text: 'OK' }] },
      { role: 'user', parts: [{ text: 'Proceed' }] },
      { role: 'model', parts: [{ text: 'OK' }] },
      { role: 'user', parts: [{ text: 'Proceed' }] },
      { role: 'model', parts: [{ text: 'OK' }] },
    ];
    const prefixes = thoughtCausalHistory(content);
    expect(new Set([prefixes.before[1], prefixes.before[3], prefixes.before[5]]).size).toBe(3);
    expect(thoughtCausalHistory(content.slice(0, 3)).after).toBe(prefixes.before[3]);
    expect(thoughtCausalHistory(content.slice(2)).before[1]).not.toBe(prefixes.before[3]);
  });

  it('excludes restored reasoning/signatures without changing exact business text or tool evidence', () => {
    const user: GeminiContent = { role: 'user', parts: [{ text: 'Read A' }] };
    const plain: GeminiContent = {
      role: 'model',
      parts: [
        { functionCall: { id: 'tool', name: 'read', args: { path: '/a', mode: 'raw' } } },
        { text: 'Done ' },
      ],
    };
    const signed: GeminiContent = {
      role: 'assistant',
      parts: [
        { thought: true, text: 'Private reasoning\n', thoughtSignature: 'opaque-reasoning' },
        {
          functionCall: { id: 'tool', name: 'read', args: { mode: 'raw', path: '/a' } },
          thoughtSignature: 'opaque-tool',
        },
        { text: 'Done ' },
      ],
    };
    expect(thoughtCausalHistory([user, signed]).after).toBe(
      thoughtCausalHistory([user, plain]).after,
    );
    expect(thoughtCausalHistory([user, { ...plain, parts: [{ text: 'Done' }] }]).after).not.toBe(
      thoughtCausalHistory([user, plain]).after,
    );
  });

  it('hashes the middle of complete long text, tool results and media without mutating inputs', () => {
    const repeated = 'same-end'.repeat(20_000);
    const make = (middle: string): GeminiContent[] => [
      { role: 'user', parts: [{ text: `${repeated}${middle}${repeated}` }] },
    ];
    expect(thoughtCausalHistory(make('A')).after).not.toBe(thoughtCausalHistory(make('B')).after);
    const makeResult = (value: string): GeminiContent[] => [
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'tool', name: 'read', response: { value } } },
          { inlineData: { mimeType: 'image/png', data: `${repeated}${value}${repeated}` } },
        ],
      },
    ];
    const original = makeResult('A');
    const snapshot = structuredClone(original);
    expect(thoughtCausalHistory(original).after).not.toBe(
      thoughtCausalHistory(makeResult('B')).after,
    );
    expect(original).toEqual(snapshot);
  });
});
