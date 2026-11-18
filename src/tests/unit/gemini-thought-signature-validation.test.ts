import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { GeminiPart } from '@/modules/proxy-gateway/antigravity/types';
import { assertGeminiThoughtSignatureAliases } from '@/server/gateway/modules/gemini/gemini-thought-signature-validation';

describe('Gemini request thought signature aliases', () => {
  it.each([
    {},
    { thoughtSignature: '' },
    { thought_signature: 'opaque-snake' },
    { thoughtSignature: 'opaque-camel' },
    { thoughtSignature: 'opaque', thought_signature: 'opaque' },
    { thoughtSignature: '', thought_signature: '' },
    {
      thoughtSignature: 'skip_thought_signature_validator',
      thought_signature: 'skip_thought_signature_validator',
    },
  ] satisfies GeminiPart[])('accepts consistent supplied fields without rewriting %j', (part) => {
    const input = [{ role: 'model', parts: [part] }];
    const original = structuredClone(input);
    expect(() => assertGeminiThoughtSignatureAliases(input)).not.toThrow();
    expect(input).toEqual(original);
  });

  it('accepts recognized raw and wrapped equivalents without modifying either alias', () => {
    const raw = Buffer.from([0x08, 0x04, 0x12, ...Array<number>(80).fill(0x7f)]).toString('base64');
    const wrapped = Buffer.from(raw, 'utf8').toString('base64');
    for (const [thoughtSignature, thought_signature] of [
      [raw, wrapped],
      [wrapped, raw],
    ]) {
      const input = [{ parts: [{ thoughtSignature, thought_signature }] }];
      const original = structuredClone(input);
      expect(() => assertGeminiThoughtSignatureAliases(input)).not.toThrow();
      expect(input).toEqual(original);
    }
  });

  it.each([
    ['opaque-A', 'opaque-B'],
    ['', 'opaque'],
    ['opaque', ''],
    ['skip_thought_signature_validator', 'opaque'],
    [' opaque ', 'opaque'],
  ])('rejects disagreement without leaking supplied values: %j and %j', (camel, snake) => {
    const input = [
      { parts: [{ thoughtSignature: 'unrelated' }] },
      {
        parts: [{}, { thoughtSignature: camel, thought_signature: snake }],
      },
    ];
    const before = structuredClone(input);
    let failure: unknown;
    try {
      assertGeminiThoughtSignatureAliases(input);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(BadRequestException);
    if (!(failure instanceof BadRequestException)) {
      throw new Error('Expected the request boundary to reject conflicting aliases');
    }
    expect(failure.getStatus()).toBe(400);
    expect(failure.message).toBe(
      'Conflicting thoughtSignature and thought_signature at contents[1].parts[1]. Supply one signature value or equivalent aliases.',
    );
    expect(input).toEqual(before);
  });
});
