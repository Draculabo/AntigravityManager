import { describe, expect, it } from 'vitest';

import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { classifyInvalidThoughtSignatureError } from '@/server/gateway/modules/anthropic/invalid-thought-signature-error';

describe('invalid thought signature classifier', () => {
  it.each([
    ['Invalid thought signature.', 'message'],
    ['INVALID THOUGHT SIGNATURE', 'message'],
    ['thinking.signature: field required', 'message'],
    ['thoughtSignature is corrupted', 'message'],
    ['messages.1.content.0: Invalid `signature` in `thinking` block', 'message'],
  ])('classifies narrow 400 text %s', (message, source) => {
    expect(
      classifyInvalidThoughtSignatureError(new UpstreamRequestError({ message, status: 400 })),
    ).toEqual({ source });
  });

  it('prefers explicit structured detail over message and body', () => {
    const error = new UpstreamRequestError({
      status: 400,
      message: 'Invalid thought signature.',
      body: '{"error":{"message":"thought_signature missing"}}',
      details: [{ reason: 'THOUGHT_SIGNATURE_INVALID' }],
    });
    expect(classifyInvalidThoughtSignatureError(error)).toEqual({ source: 'structured_detail' });
  });

  it('classifies parsed bodies before the narrow text fallback', () => {
    const error = new UpstreamRequestError({
      status: 400,
      message: 'Bad request',
      body: '{"error":{"field":"thinking.signature","reason":"required"}}',
    });
    expect(classifyInvalidThoughtSignatureError(error)).toEqual({ source: 'parsed_body' });
  });

  it('recognizes a provider error nested as JSON text in the Google response', () => {
    const error = new UpstreamRequestError({
      status: 400,
      message: 'Bad request',
      body: JSON.stringify({
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'messages.1.content.0: Invalid `signature` in `thinking` block',
            },
          }),
        },
      }),
    });
    expect(classifyInvalidThoughtSignatureError(error)).toEqual({ source: 'parsed_body' });
  });

  it.each([
    'invalid signature',
    'failed to deserialise',
    'thinking block',
    'found `text`',
    'must be `thinking`',
    'thinking.thinking: field required',
    'INVALID_ARGUMENT',
    'Invalid signature in authorization block',
    'Invalid thinking block',
  ])('rejects broad false positive %s', (message) => {
    expect(
      classifyInvalidThoughtSignatureError(new UpstreamRequestError({ message, status: 400 })),
    ).toBeNull();
  });

  it('rejects matching text for every non-400 status and non-upstream error', () => {
    expect(
      classifyInvalidThoughtSignatureError(
        new UpstreamRequestError({ message: 'Invalid thought signature.', status: 500 }),
      ),
    ).toBeNull();
    expect(
      classifyInvalidThoughtSignatureError(new Error('Invalid thought signature.')),
    ).toBeNull();
  });
});
