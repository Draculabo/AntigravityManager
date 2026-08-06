import { describe, expect, it } from 'vitest';
import {
  summarizeImageRequest,
  summarizeImageResponse,
} from '@/modules/proxy-gateway/server/modules/openai/media/image-monitoring-summary';

describe('image monitoring summaries', () => {
  it('summarizes image-edit fields and files without retaining base64 data', () => {
    const base64 = 'QUJDRA==';
    const summary = summarizeImageRequest('/v1/images/edits', {
      model: 'gemini-3.1-flash-image',
      prompt: 'x'.repeat(501),
      image: {
        data: `data:image/png;base64,${base64}`,
        filename: 'source.png',
        mimeType: 'image/png',
      },
      reference_images: [{ data: base64, mimeType: 'image/jpeg' }],
    });

    expect(summary).toEqual({
      content_type: 'multipart/form-data',
      path: '/v1/images/edits',
      fields: {
        model: 'gemini-3.1-flash-image',
        prompt: `${'x'.repeat(500)}...`,
        quality: undefined,
        size: undefined,
      },
      files: [
        {
          field: 'image',
          filename: 'source.png',
          content_type: 'image/png',
          bytes: 4,
        },
        {
          field: 'reference_images',
          filename: undefined,
          content_type: 'image/jpeg',
          bytes: 4,
        },
      ],
      raw_bytes: 531,
    });
    expect(JSON.stringify(summary)).not.toContain(base64);
  });

  it('replaces response base64 with PNG metadata and dimensions', () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    const base64 = png.toString('base64');

    const summary = summarizeImageResponse({
      created: 1_777_000_000,
      data: [{ b64_json: base64, revised_prompt: 'draw a fox' }],
    });

    expect(summary).toEqual({
      created: 1_777_000_000,
      data: [
        {
          revised_prompt: 'draw a fox',
          image: {
            encoding: 'base64',
            redacted: true,
            mime_type: 'image/png',
            bytes: 24,
            dimensions: {
              width: 640,
              height: 480,
            },
          },
        },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain(base64);
  });

  it('redacts image data URLs while preserving ordinary URLs', () => {
    const dataUrl = 'data:image/png;base64,QUJDRA==';

    expect(
      summarizeImageResponse({
        created: 1,
        data: [{ url: dataUrl }, { url: 'https://example.com/image.png' }],
      }),
    ).toEqual({
      created: 1,
      data: [
        {
          revised_prompt: undefined,
          url: `[data URL redacted: ${dataUrl.length} chars]`,
        },
        {
          revised_prompt: undefined,
          url: 'https://example.com/image.png',
        },
      ],
    });
  });
});
