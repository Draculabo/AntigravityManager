import { describe, expect, it } from 'vitest';
import {
  MAX_INPUT_IMAGES,
  MAX_INPUT_IMAGE_BYTES,
  MAX_TOTAL_INPUT_IMAGE_BYTES,
  parseGenerationInputImages,
  validateInputImageLimits,
} from '@/modules/proxy-gateway/server/modules/openai/media/image-input-validation';

describe('image input validation', () => {
  it('preserves valid generation images in request order', () => {
    expect(
      parseGenerationInputImages([
        'data:image/png;base64,AQ==',
        'data:image/webp;name=source;base64,Ag==',
      ]),
    ).toEqual([
      { data: 'AQ==', mimeType: 'image/png' },
      { data: 'Ag==', mimeType: 'image/webp' },
    ]);
  });

  it.each([
    ['remote URL', 'https://example.invalid/image.png'],
    ['non-image MIME', 'data:text/plain;base64,AQ=='],
    ['non-base64 data URL', 'data:image/png,AQ=='],
    ['empty data', 'data:image/png;base64,'],
    ['invalid base64', 'data:image/png;base64,not-base64'],
    ['null input', null],
    ['object input', { url: 'data:image/png;base64,AQ==' }],
  ])('rejects %s', (_case, input) => {
    expect(() => parseGenerationInputImages(input)).toThrow();
  });

  it('rejects empty, mixed-type, and over-count arrays', () => {
    expect(() => parseGenerationInputImages([])).toThrow('Input image array must not be empty');
    expect(() => parseGenerationInputImages(['data:image/png;base64,AQ==', 2])).toThrow(
      'Every input image must be a base64 data:image URL',
    );
    expect(() =>
      parseGenerationInputImages(
        Array.from({ length: MAX_INPUT_IMAGES + 1 }, () => 'data:image/png;base64,AQ=='),
      ),
    ).toThrow(`Too many input images: maximum is ${MAX_INPUT_IMAGES}`);
  });

  it('enforces per-image and aggregate decoded byte ceilings', () => {
    expect(() =>
      validateInputImageLimits(16, MAX_INPUT_IMAGE_BYTES, 32 * 1024 * 1024),
    ).not.toThrow();
    expect(() => validateInputImageLimits(1, MAX_INPUT_IMAGE_BYTES + 1, 0)).toThrow(
      `Input image is too large: maximum decoded size is ${MAX_INPUT_IMAGE_BYTES} bytes`,
    );
    expect(() => validateInputImageLimits(1, 1, MAX_TOTAL_INPUT_IMAGE_BYTES + 1)).toThrow(
      `Total input image data is too large: maximum decoded size is ${MAX_TOTAL_INPUT_IMAGE_BYTES} bytes`,
    );
  });
});
