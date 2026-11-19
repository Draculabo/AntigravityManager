import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import type { ClaudeRequest, GeminiContent } from '@/modules/proxy-gateway/antigravity/types';
import { restoreStoredThoughts } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import type { ThoughtRecord } from '@/modules/proxy-gateway/thought-store/thought-store.types';

const firstSignature = 'a'.repeat(60);
const secondSignature = 'b'.repeat(80);

function toolHistory(): ClaudeRequest {
  return {
    model: 'gemini-3-flash',
    thinking: { type: 'disabled' },
    messages: [
      { role: 'user', content: 'Read A.' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Inspect A.', signature: firstSignature },
          { type: 'tool_use', id: 'call-A', name: 'read', input: { path: 'A' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-A', content: 'A contents' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-B', name: 'read', input: { path: 'B' } }],
      },
    ],
  };
}

function stored(): ThoughtRecord {
  return {
    createdAt: 1,
    fingerprint: 'parallel-turn',
    id: 1,
    model: 'gemini-pro-agent',
    oversized: false,
    oversizedBytes: null,
    oversizedSha256: null,
    signature: secondSignature,
    partSignatures: [
      {
        kind: 'thought',
        position: 0,
        start: 0,
        end: 'Original reasoning.'.length,
        signature: secondSignature,
      },
    ],
    sourceFamily: 'gemini-pro',
    thought: 'Original reasoning.',
    toolIds: ['call-A', 'call-B'],
    toolNames: ['read'],
    visible: '',
  };
}

describe('Thought signature part ownership', () => {
  it('leaves tool responses unsigned', () => {
    const result = transformClaudeRequestIn(toolHistory(), undefined, undefined, undefined);
    expect(result.request.contents[2].parts).toEqual([
      {
        functionResponse: {
          name: 'read',
          id: 'call-A',
          response: { result: 'A contents' },
        },
      },
    ]);
    expect(result.request.contents[1].parts[1]).toEqual({
      functionCall: { id: 'call-A', name: 'read', args: { path: 'A' } },
      thoughtSignature: firstSignature,
      thought_signature: firstSignature,
    });
  });

  it('does not borrow the preceding assistant message signature', () => {
    const result = transformClaudeRequestIn(toolHistory(), undefined, undefined, undefined);
    expect(result.request.contents[3].parts).toEqual([
      { functionCall: { id: 'call-B', name: 'read', args: { path: 'B' } } },
    ]);
  });

  it.each([
    { alias: 'thoughtSignature' as const, signature: firstSignature },
    { alias: 'thought_signature' as const, signature: firstSignature },
    { alias: 'thoughtSignature' as const, signature: 'opaque-short' },
    { alias: 'thought_signature' as const, signature: 'opaque-short' },
  ])(
    'preserves independent parallel $alias ($signature) when restoring placeholder reasoning',
    ({ alias, signature }) => {
      const first = {
        functionCall: { id: 'call-A', name: 'read', args: { path: 'A' } },
        [alias]: signature,
      };
      const second = {
        functionCall: { id: 'call-B', name: 'read', args: { path: 'B' } },
        thoughtSignature: secondSignature,
      };
      const originalCalls = structuredClone([first, second]);
      const contents: GeminiContent[] = [
        {
          role: 'model',
          parts: [{ thought: true, text: '...' }, first, second],
        },
      ];
      expect(restoreStoredThoughts(contents, [stored()], 'gemini-pro-agent')).toBe(1);
      expect(contents[0].parts).toEqual([
        {
          thought: true,
          text: 'Original reasoning.',
          thoughtSignature: secondSignature,
        },
        ...originalCalls,
      ]);
      expect(contents[0].parts[1][alias]).toBe(signature);
    },
  );
});
