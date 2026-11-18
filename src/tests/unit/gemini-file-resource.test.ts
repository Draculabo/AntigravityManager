import { describe, expect, it } from 'vitest';

import {
  geminiFileErrorResponse,
  readGeminiUploadDisplayName,
} from '@/server/gateway/modules/files/gemini-file-resource';

describe('Gemini file resource boundaries', () => {
  it('preserves Gemini nested-file fallback semantics while validating metadata', () => {
    expect(
      readGeminiUploadDisplayName({
        metadata: JSON.stringify({ file: { display_name: '  Project notes  ' } }),
      }),
    ).toBe('Project notes');
    expect(
      readGeminiUploadDisplayName({
        metadata: JSON.stringify({
          file: { display_name: 42, displayName: 'Ignored nested fallback' },
        }),
      }),
    ).toBeUndefined();
    expect(
      readGeminiUploadDisplayName({
        metadata: JSON.stringify({ displayName: 'Flat name' }),
      }),
    ).toBe('Flat name');
    expect(
      readGeminiUploadDisplayName({
        metadata: JSON.stringify({ display_name: 42, displayName: 'Ignored flat fallback' }),
      }),
    ).toBeUndefined();
    expect(
      readGeminiUploadDisplayName({
        metadata: JSON.stringify({ display_name: null, displayName: 'Null alias fallback name' }),
      }),
    ).toBe('Null alias fallback name');
    expect(
      readGeminiUploadDisplayName({
        metadata: JSON.stringify({ file: null, displayName: 'Null fallback name' }),
      }),
    ).toBe('Null fallback name');
    expect(
      readGeminiUploadDisplayName({
        metadata: JSON.stringify({ file: ['not-an-object'], displayName: 'Ignored fallback name' }),
      }),
    ).toBeUndefined();
    expect(readGeminiUploadDisplayName({ metadata: 'null' })).toBeUndefined();
  });

  it('uses an HTTP status only from an Error instance', () => {
    const upstreamError = Object.assign(new Error('file too large'), { httpStatus: 413 });

    expect(geminiFileErrorResponse(upstreamError)).toMatchObject({
      statusCode: 413,
      body: { error: { code: 413, message: 'file too large', status: 'FAILED_PRECONDITION' } },
    });
    expect(geminiFileErrorResponse({ httpStatus: 413 })).toMatchObject({
      statusCode: 500,
      body: { error: { code: 500, message: 'File request failed', status: 'INTERNAL' } },
    });
  });
});
