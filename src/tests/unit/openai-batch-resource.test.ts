import { describe, expect, it } from 'vitest';

import { OPENAI_SERVABLE_BATCH_ENDPOINT } from '@/server/gateway/modules/batch/batch-job.types';
import {
  normalizeBatchMetadata,
  openAIBatchErrorResponse,
  parseBatchInputJsonl,
} from '@/server/gateway/modules/batch/openai-batch-resource';

describe('OpenAI batch resource boundaries', () => {
  it('validates JSONL records while preserving the opaque request body', () => {
    const result = parseBatchInputJsonl(
      `${JSON.stringify({
        custom_id: ' request-1 ',
        url: OPENAI_SERVABLE_BATCH_ENDPOINT,
        body: { model: 'gpt-4.1', messages: [{ role: 'user', content: 'hello' }] },
      })}\n`,
      OPENAI_SERVABLE_BATCH_ENDPOINT,
    );

    expect(result).toEqual([
      {
        customId: 'request-1',
        model: 'gpt-4.1',
        body: { model: 'gpt-4.1', messages: [{ role: 'user', content: 'hello' }] },
      },
    ]);
  });

  it('rejects JSON values that are not batch request objects', () => {
    expect(() => parseBatchInputJsonl('null\n', OPENAI_SERVABLE_BATCH_ENDPOINT)).toThrow(
      expect.objectContaining({
        code: 'invalid_request',
        httpStatus: 400,
        message: expect.stringContaining('must be an object'),
      }),
    );
    expect(() =>
      parseBatchInputJsonl('{"custom_id":"request-1","body":[]}\n', OPENAI_SERVABLE_BATCH_ENDPOINT),
    ).toThrow(
      expect.objectContaining({
        code: 'invalid_request',
        httpStatus: 400,
        message: expect.stringContaining('has no body object'),
      }),
    );
  });

  it('validates all metadata values as strings', () => {
    expect(normalizeBatchMetadata({ customer: 'example', tier: 'gold' })).toEqual({
      customer: 'example',
      tier: 'gold',
    });
    expect(() => normalizeBatchMetadata({ customer: 42 })).toThrow(
      expect.objectContaining({
        code: 'invalid_request',
        param: 'metadata',
        message: 'metadata.customer must be a string',
      }),
    );
  });

  it('uses an HTTP status only from an Error instance', () => {
    const upstreamError = Object.assign(new Error('too many requests'), { httpStatus: 429 });

    expect(openAIBatchErrorResponse(upstreamError)).toMatchObject({
      statusCode: 429,
      body: { error: { message: 'too many requests', type: 'invalid_request_error' } },
    });
    expect(openAIBatchErrorResponse({ httpStatus: 429 })).toMatchObject({
      statusCode: 500,
      body: { error: { message: 'Batch request failed', type: 'server_error' } },
    });
  });
});
