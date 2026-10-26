import { describe, expect, it } from 'vitest';

import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import {
  areThoughtSignaturesEquivalent,
  classifyThoughtSignature,
  normalizeThoughtSignatureForComparison,
  prepareGeminiRequestThoughtSignatures,
  toClaudeClientThoughtSignature,
  toGoogleClaudeThoughtSignature,
} from '@/modules/proxy-gateway/antigravity/thought-signature-format';

function rawClaudeSignature(): string {
  return Buffer.from([0x08, 0x04, 0x12, ...Array<number>(80).fill(0x7f)]).toString('base64');
}

function googleWrappedSignature(signature: string): string {
  return Buffer.from(signature, 'utf8').toString('base64');
}

describe('known thought signature formats', () => {
  it('wraps a recognized raw Claude protobuf signature once for Google', () => {
    const raw = rawClaudeSignature();
    const wrapped = googleWrappedSignature(raw);

    expect(classifyThoughtSignature(raw)).toBe('claude-raw');
    expect(toGoogleClaudeThoughtSignature(raw)).toBe(wrapped);
    expect(toGoogleClaudeThoughtSignature(wrapped)).toBe(wrapped);
  });

  it('recognizes the known ASCII Claude marker without decoding arbitrary text', () => {
    const raw = Buffer.from('opaque Claude proof payload', 'utf8').toString('base64');
    const wrapped = googleWrappedSignature(raw);

    expect(classifyThoughtSignature(raw)).toBe('claude-raw');
    expect(toClaudeClientThoughtSignature(wrapped)).toBe(raw);
  });

  it('uses an unwrapped comparison form while leaving the input value intact', () => {
    const raw = rawClaudeSignature();
    const wrapped = googleWrappedSignature(raw);

    expect(normalizeThoughtSignatureForComparison(wrapped)).toBe(raw);
    expect(areThoughtSignaturesEquivalent(raw, wrapped)).toBe(true);
    expect(wrapped).toBe(googleWrappedSignature(raw));
  });

  it.each([
    Buffer.from([0x12, 0x26, 0x0a, 0x24, 0x30, 0x30, 0x30]).toString('base64'),
    Buffer.from('provider-specific opaque bytes', 'utf8').toString('base64'),
    Buffer.from('CAQS!invalid-inner', 'utf8').toString('base64'),
    'not!valid@base64#',
    'skip_thought_signature_validator',
  ])('preserves unknown or non-Claude signatures exactly: %s', (signature) => {
    expect(toGoogleClaudeThoughtSignature(signature)).toBe(signature);
    expect(toClaudeClientThoughtSignature(signature)).toBe(signature);
    expect(classifyThoughtSignature(signature)).toBe('opaque');
  });

  it('does not unwrap signatures wrapped more than once', () => {
    const raw = rawClaudeSignature();
    const wrappedTwice = googleWrappedSignature(googleWrappedSignature(raw));

    expect(toClaudeClientThoughtSignature(wrappedTwice)).toBe(wrappedTwice);
    expect(toGoogleClaudeThoughtSignature(wrappedTwice)).toBe(wrappedTwice);
    expect(areThoughtSignaturesEquivalent(wrappedTwice, raw)).toBe(false);
  });

  it.each([
    (raw: string) => ` ${raw} `,
    (raw: string) => raw.replace(/=+$/u, ''),
    (raw: string) => `${raw.slice(0, 2)}\n${raw.slice(2)}`,
    (raw: string) => `${raw}!`,
  ])('preserves non-canonical Base64 instead of repairing it', (alter) => {
    const signature = alter(rawClaudeSignature());
    expect(toGoogleClaudeThoughtSignature(signature)).toBe(signature);
    expect(toClaudeClientThoughtSignature(signature)).toBe(signature);
  });

  it('leaves oversized signatures opaque without decoding them', () => {
    const signature = Buffer.from(`claude${'x'.repeat(1024 * 1024)}`, 'utf8').toString('base64');
    expect(classifyThoughtSignature(signature)).toBe('opaque');
    expect(toGoogleClaudeThoughtSignature(signature)).toBe(signature);
  });

  it('normalizes Google-bound aliases after history restoration without mutating the source', () => {
    const raw = rawClaudeSignature();
    const wrapped = googleWrappedSignature(raw);
    const body: GeminiInternalRequest = {
      model: 'gemini-3-flash',
      project: 'synthetic-project',
      requestId: 'synthetic-request',
      userAgent: 'synthetic-test',
      request: {
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: { id: 'call-1', name: 'read', args: {} },
                thoughtSignature: raw,
                thought_signature: raw,
              },
            ],
          },
        ],
      },
    };

    const prepared = prepareGeminiRequestThoughtSignatures(body);
    expect(prepared).not.toBe(body);
    expect(prepared.request.contents[0].parts[0]).toMatchObject({
      thoughtSignature: wrapped,
      thought_signature: wrapped,
    });
    expect(body.request.contents[0].parts[0]).toMatchObject({
      thoughtSignature: raw,
      thought_signature: raw,
    });
  });

  it('returns the same request object when no recognized signature needs conversion', () => {
    const body: GeminiInternalRequest = {
      model: 'gemini-3-flash',
      project: 'synthetic-project',
      requestId: 'synthetic-request',
      userAgent: 'synthetic-test',
      request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    };

    expect(prepareGeminiRequestThoughtSignatures(body)).toBe(body);
  });

  it('maps only supplied aliases while preserving disagreements and unchanged part references', () => {
    const raw = rawClaudeSignature();
    const body: GeminiInternalRequest = {
      model: 'claude-sonnet-4-6',
      project: 'synthetic-project',
      requestId: 'synthetic-request',
      userAgent: 'synthetic-test',
      request: {
        contents: [
          { role: 'user', parts: [{ text: 'hello' }] },
          {
            role: 'model',
            parts: [
              { text: 'reason', thought: true, thought_signature: raw },
              { text: 'answer', thoughtSignature: raw, thought_signature: 'other-signature' },
              { text: 'unchanged' },
            ],
          },
        ],
      },
    };
    const original = structuredClone(body);
    const prepared = prepareGeminiRequestThoughtSignatures(body);

    expect(prepared.request.contents[0]).toBe(body.request.contents[0]);
    expect(prepared.request.contents[1].parts[2]).toBe(body.request.contents[1].parts[2]);
    expect(prepared.request.contents[1].parts.slice(0, 2)).toEqual([
      {
        text: 'reason',
        thought: true,
        thought_signature: googleWrappedSignature(raw),
      },
      {
        text: 'answer',
        thoughtSignature: googleWrappedSignature(raw),
        thought_signature: 'other-signature',
      },
    ]);
    expect(body).toEqual(original);
  });
});
