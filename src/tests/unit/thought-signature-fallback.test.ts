import { describe, expect, it } from 'vitest';
import { injectPlaceholderSignaturesForModel } from '@/modules/proxy-gateway/antigravity/ThoughtSignatureCompat';
import type { GeminiContent } from '@/modules/proxy-gateway/antigravity/types';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';

describe('native Gemini signature fallback contract', () => {
  it('does not inject a Claude fallback for a resource-style project model', () => {
    const result = transformClaudeRequestIn({
      model: 'projects/fixture/locations/global/publishers/google/models/gemini-3-flash',
      max_tokens: 1024,
      thinking: { type: 'enabled', budget_tokens: 256 },
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'resource-unsigned-call', name: 'lookup', input: {} }],
        },
      ],
    });
    expect(
      result.request.contents
        .flatMap((content) => content.parts)
        .filter((part) => part.functionCall),
    ).toEqual([{ functionCall: { name: 'lookup', args: {}, id: 'resource-unsigned-call' } }]);
  });
  it.each(['thoughtSignature', 'thought_signature'] as const)(
    'completes the alias for %s without replacing the signature',
    (key) => {
      const contents: GeminiContent[] = [
        {
          role: 'model',
          parts: [{ functionCall: { name: 'lookup', args: {} }, [key]: 'provider-signature' }],
        },
      ];
      expect(injectPlaceholderSignaturesForModel(contents, 'gemini-3.7-flash-high')).toEqual([
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'lookup', args: {} },
              thoughtSignature: 'provider-signature',
              thought_signature: 'provider-signature',
            },
          ],
        },
      ]);
      expect(contents[0].parts[0]).toEqual({
        functionCall: { name: 'lookup', args: {} },
        [key]: 'provider-signature',
      });
    },
  );

  it('does not extend native Flash fallback to pro-agent', () => {
    const contents: GeminiContent[] = [
      { role: 'model', parts: [{ functionCall: { name: 'lookup', args: {} } }] },
    ];
    expect(injectPlaceholderSignaturesForModel(contents, 'gemini-pro-agent')).toEqual(contents);
  });

  it('preserves supplied empty and conflicting aliases instead of replacing them with a sentinel', () => {
    const contents: GeminiContent[] = [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'empty', args: {} }, thoughtSignature: '' },
          {
            functionCall: { name: 'conflict', args: {} },
            thoughtSignature: 'camel',
            thought_signature: 'snake',
          },
        ],
      },
    ];
    expect(injectPlaceholderSignaturesForModel(contents, 'gemini-3-flash')).toEqual([
      {
        role: 'model',
        parts: [
          {
            functionCall: { name: 'empty', args: {} },
            thoughtSignature: '',
            thought_signature: '',
          },
          {
            functionCall: { name: 'conflict', args: {} },
            thoughtSignature: 'camel',
            thought_signature: 'snake',
          },
        ],
      },
    ]);
  });
});
