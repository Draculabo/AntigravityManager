import { describe, expect, it } from 'vitest';
import {
  imageAspectRatioFromSize,
  normalizeExplicitImageSize,
  resolveImageGenerationConfig,
  selectImageAspectRatioInput,
} from '@/modules/proxy-gateway/antigravity/ImageGenerationConfig';

describe('image generation configuration', () => {
  it.each([
    ['low', '1K'],
    ['standard', '1K'],
    ['1k', '1K'],
    ['medium', '2K'],
    ['2k', '2K'],
    ['high', '4K'],
    ['hd', '4K'],
    ['4k', '4K'],
  ])('maps quality %s to %s', (quality, expected) => {
    expect(resolveImageGenerationConfig('gemini-3-pro-image', { quality }).imageConfig).toEqual({
      aspectRatio: '1:1',
      imageSize: expected,
    });
  });

  it('applies explicit parameters before model suffix fallbacks', () => {
    expect(
      resolveImageGenerationConfig('gemini-3.1-flash-image-1x1-2k', {
        imageSize: '4k',
        quality: 'standard',
        size: '1280x720',
      }),
    ).toEqual({
      imageConfig: {
        aspectRatio: '16:9',
        imageSize: '4K',
      },
      parsedBaseModel: 'gemini-3.1-flash-image',
    });
  });

  it('uses deterministic suffix priority when a model contains conflicting ratios', () => {
    expect(resolveImageGenerationConfig('gemini-3-pro-image-9x16-4x3').imageConfig).toEqual({
      aspectRatio: '9:16',
    });
  });

  it('strips only known configuration suffixes from an unknown image model', () => {
    expect(resolveImageGenerationConfig('vendor-special-image-preview-16x9-4k')).toEqual({
      imageConfig: { aspectRatio: '16:9', imageSize: '4K' },
      parsedBaseModel: 'vendor-special-image-preview',
    });
  });

  it('falls back to model suffixes when explicit size values are auto or unrecognized', () => {
    expect(
      resolveImageGenerationConfig('gemini-3-pro-image-21x9-2k', {
        imageSize: 'auto',
        quality: 'auto',
        size: 'invalid',
      }).imageConfig,
    ).toEqual({
      aspectRatio: '21:9',
      imageSize: '2K',
    });
  });

  it.each([
    ['2560x1080', '21:9'],
    ['1920x1080', '16:9'],
    ['800x600', '4:3'],
    ['600x800', '3:4'],
    ['1080x1920', '9:16'],
    ['1500x1000', '3:2'],
    ['1000x1500', '2:3'],
    ['1250x1000', '5:4'],
    ['1000x1250', '4:5'],
    ['1024x1024', '1:1'],
  ])('maps dimensions %s to %s', (size, expected) => {
    expect(imageAspectRatioFromSize(size)).toBe(expected);
  });

  it('rejects unsupported explicit image_size values', () => {
    expect(() => normalizeExplicitImageSize('8K')).toThrow(
      'Invalid image_size: expected one of 1K, 2K, 4K, or auto',
    );
  });

  it('uses a valid size when the preferred aspect_ratio is invalid', () => {
    expect(selectImageAspectRatioInput('garbage', '1920x1080')).toBe('1920x1080');
    expect(selectImageAspectRatioInput('4:3', '1920x1080')).toBe('4:3');
    expect(selectImageAspectRatioInput('garbage', 'also-invalid')).toBeUndefined();
  });

  it('rejects whitespace inside width-by-height dimensions', () => {
    expect(imageAspectRatioFromSize('1920 x 1080')).toBeUndefined();
    expect(
      resolveImageGenerationConfig('gemini-3-pro-image-4x3', { size: '1920 x 1080' }).imageConfig
        .aspectRatio,
    ).toBe('4:3');
  });

  it('rejects non-string explicit image_size values with the public boundary error', () => {
    expect(() => normalizeExplicitImageSize(4)).toThrow(
      'Invalid image_size: expected one of 1K, 2K, 4K, or auto',
    );
  });
});
