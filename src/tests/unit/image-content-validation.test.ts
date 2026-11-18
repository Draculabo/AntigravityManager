import { describe, expect, it } from 'vitest';
import { validatedImageMimeType } from '@/server/gateway/common/image-content-validation';
import { PIXEL_PNG, PIXEL_GIF, PIXEL_JPEG, PIXEL_BMP } from '../fixtures/image-content';

describe('image signature and minimum container completeness', () => {
  it.each([
    ['image/png', PIXEL_PNG],
    ['image/gif', PIXEL_GIF],
    ['image/jpeg', PIXEL_JPEG],
    ['image/bmp', PIXEL_BMP],
  ] as const)('accepts independent %s bytes and rejects truncation', (mime, bytes) => {
    expect(validatedImageMimeType(bytes)).toBe(mime);
    expect(() => validatedImageMimeType(bytes.subarray(0, 8))).toThrow(/image/i);
    expect(() => validatedImageMimeType(bytes.subarray(0, -1))).toThrow(/image/i);
  });

  it('checks WebP RIFF chunk extents before accepting a codec payload', () => {
    const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
    expect(validatedImageMimeType(webp)).toBe('image/webp');
    expect(() => validatedImageMimeType(webp.subarray(0, -1))).toThrow(/image/i);
    const broken = Buffer.from(webp);
    broken.writeUInt32LE(0xffff, 16);
    expect(() => validatedImageMimeType(broken)).toThrow(/image/i);
  });

  it('does not accept a JPEG start/end marker without any image frame or scan', () => {
    expect(() => validatedImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toThrow(/image/i);
  });

  it('rejects a BMP whose declared header extends into or beyond its pixel bytes', () => {
    const broken = Buffer.from(PIXEL_BMP);
    broken.writeUInt32LE(0xffff, 14);
    expect(() => validatedImageMimeType(broken)).toThrow(/image/i);
  });
});
