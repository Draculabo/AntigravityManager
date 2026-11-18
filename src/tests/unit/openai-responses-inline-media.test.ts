import { describe, expect, it } from 'vitest';
import { PIXEL_PNG, pngWithBytes } from '../fixtures/image-content';

import {
  boundResponsesInputItems,
  omitMediaBeforeLatestUserTurn,
  validateResponsesInputImageLimits,
} from '@/server/gateway/modules/openai/responses/openai-responses-inline-media';

function imageDataUrl(decodedBytes: number): string {
  return `data:image/png;base64,${pngWithBytes(decodedBytes).toString('base64')}`;
}

function imageParts(count: number): unknown[] {
  return Array.from({ length: count }, () => ({
    type: 'input_image',
    image_url: `data:image/png;base64,${PIXEL_PNG.toString('base64')}`,
  }));
}

describe('Responses inline media boundaries', () => {
  it('accepts 16 current images and rejects the 17th', () => {
    expect(() => validateResponsesInputImageLimits(imageParts(16))).not.toThrow();
    expect(() => validateResponsesInputImageLimits(imageParts(17))).toThrow(
      'Too many input images: maximum is 16',
    );
  });

  it('accepts uppercase BASE64 metadata and rejects malformed payloads', () => {
    expect(() =>
      validateResponsesInputImageLimits({
        type: 'input_image',
        image_url: `data:image/png;BASE64,${PIXEL_PNG.toString('base64')}`,
      }),
    ).not.toThrow();
    expect(() =>
      validateResponsesInputImageLimits({
        type: 'input_image',
        image_url: 'data:image/png;base64,not-base64',
      }),
    ).toThrow('Input image contains invalid base64 data');
  });

  it('does not count remote image URLs as inline payloads', () => {
    expect(() =>
      validateResponsesInputImageLimits(
        Array.from({ length: 20 }, () => ({
          type: 'input_image',
          image_url: 'https://example.com/image.png',
        })),
      ),
    ).not.toThrow();
  });

  it('enforces the exact per-image byte boundary', () => {
    expect(() =>
      validateResponsesInputImageLimits({
        type: 'input_image',
        image_url: imageDataUrl(20 * 1024 * 1024),
      }),
    ).not.toThrow();
    expect(() =>
      validateResponsesInputImageLimits({
        type: 'input_image',
        image_url: imageDataUrl(20 * 1024 * 1024 + 1),
      }),
    ).toThrow('Input image is too large: maximum decoded size is 20971520 bytes');
  });

  it('enforces the exact total decoded byte boundary', () => {
    const first = imageDataUrl(16 * 1024 * 1024);
    const exactSecond = imageDataUrl(16 * 1024 * 1024);
    const oversizedSecond = imageDataUrl(16 * 1024 * 1024 + 1);
    const wrap = (second: string) => [
      { type: 'input_image', image_url: first },
      { type: 'image_url', image_url: { url: second } },
    ];

    expect(() => validateResponsesInputImageLimits(wrap(exactSecond))).not.toThrow();
    expect(() => validateResponsesInputImageLimits(wrap(oversizedSecond))).toThrow(
      'Total input image data is too large: maximum decoded size is 33554432 bytes',
    );
  });

  it('preserves historical media before validation and keeps caller input untouched', () => {
    const input = [
      { type: 'message', role: 'user', content: imageParts(1) },
      { type: 'message', role: 'assistant', content: 'done' },
      { type: 'message', role: 'user', content: imageParts(1) },
    ];
    const before = structuredClone(input);
    const bounded = omitMediaBeforeLatestUserTurn(input);

    expect(JSON.stringify(bounded[0])).toContain('data:image/');
    expect(JSON.stringify(bounded[2])).toContain('data:image/');
    expect(() => validateResponsesInputImageLimits(bounded)).not.toThrow();
    expect(input).toEqual(before);

    const currentContent = (bounded[2] as { content: unknown[] }).content;
    for (const part of imageParts(15)) {
      currentContent.push(part);
    }
    expect(() => validateResponsesInputImageLimits(bounded)).toThrow(
      'Too many input images: maximum is 16',
    );
  });

  it('retains protocol media and tool arguments without modifying the source', () => {
    const input = [
      {
        type: 'function_call_output',
        output: [
          { type: 'input_image', image_url: 'data:image/png;base64,AQ==' },
          { type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,AQ==' } },
          'data:image/png;base64,AQ==',
          'retained',
        ],
      },
    ];
    const before = structuredClone(input);
    const bounded = boundResponsesInputItems(input);

    expect(bounded).toEqual(input);
    expect(input).toEqual(before);
  });
});
