import fastifyMultipart from '@fastify/multipart';
import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PIXEL_PNG, PIXEL_GIF } from '../fixtures/image-content';
import { MAX_INPUT_IMAGES } from '@/server/gateway/modules/openai/media/image-input-validation';
import {
  isEditImageField,
  parseImageMultipartRequest,
} from '@/server/gateway/modules/openai/media/image-multipart-request';

const servers: Array<ReturnType<typeof Fastify>> = [];

function createFileOnlyRequest(files: Array<{ fieldname: string; value: Buffer }>): FastifyRequest {
  return {
    isMultipart: () => true,
    parts: async function* () {
      for (const file of files) {
        yield {
          type: 'file',
          fieldname: file.fieldname,
          filename: `${file.fieldname}.png`,
          mimetype: 'image/png',
          toBuffer: async () => Buffer.from(file.value),
        };
      }
    },
  } as unknown as FastifyRequest;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('parseImageMultipartRequest', () => {
  it.each(['image', 'mask'])('rejects header-only %s bytes', async (fieldname) => {
    await expect(
      parseImageMultipartRequest(
        createFileOnlyRequest([{ fieldname, value: PIXEL_PNG.subarray(0, 8) }]),
      ),
    ).rejects.toThrow(/incomplete image structure/);
  });

  it('parses real multipart fields and uses the image bytes to correct MIME types', async () => {
    const server = Fastify();
    servers.push(server);
    await server.register(fastifyMultipart);
    server.post('/images/edits', async (request) => parseImageMultipartRequest(request));

    const boundary = '----antigravity-multipart';
    const payload = Buffer.from(
      [
        `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nmake it brighter`,
        `--${boundary}\r\nContent-Disposition: form-data; name="aspect_ratio"\r\n\r\n16:9`,
        `--${boundary}\r\nContent-Disposition: form-data; name="image_size"\r\n\r\n4K`,
        `--${boundary}\r\nContent-Disposition: form-data; name="style"\r\n\r\nvivid`,
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="main.webp"\r\nContent-Type: image/webp\r\n\r\n${PIXEL_PNG.toString('latin1')}`,
        `--${boundary}\r\nContent-Disposition: form-data; name="image1"; filename="reference.jpg"\r\nContent-Type: image/jpeg\r\n\r\n${PIXEL_GIF.toString('latin1')}`,
        `--${boundary}--\r\n`,
      ].join('\r\n'),
      'latin1',
    );

    const response = await server.inject({
      method: 'POST',
      url: '/images/edits',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      prompt: 'make it brighter',
      image_size: '4K',
      aspect_ratio: '16:9',
      style: 'vivid',
      image: [
        {
          data: PIXEL_PNG.toString('base64'),
          filename: 'main.webp',
          mimeType: 'image/png',
        },
        {
          data: PIXEL_GIF.toString('base64'),
          filename: 'reference.jpg',
          mimeType: 'image/gif',
        },
      ],
    });
  });

  it('accepts only the supported edit image field forms', () => {
    expect(
      [
        'image',
        'image',
        'image[]',
        'image[]',
        'image1',
        'image2',
        'imageSize',
        'image_size',
        'imageReference',
      ].filter(isEditImageField),
    ).toEqual(['image', 'image', 'image[]', 'image[]', 'image1', 'image2']);
  });

  it('does not let style satisfy the required prompt field', async () => {
    const server = Fastify();
    servers.push(server);
    await server.register(fastifyMultipart);
    server.post('/images/edits', async (request) => parseImageMultipartRequest(request));

    const boundary = '----antigravity-style-only';
    const response = await server.inject({
      method: 'POST',
      url: '/images/edits',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="style"\r\n\r\nvivid\r\n--${boundary}--\r\n`,
      ),
    });

    expect(response.json()).toEqual({ style: 'vivid' });
  });

  it('allows sixteen edit images plus a mask without counting the mask as an image', async () => {
    const files = Array.from({ length: MAX_INPUT_IMAGES }, (_, index) => ({
      fieldname: index % 2 === 0 ? 'image[]' : `image${index + 1}`,
      value: PIXEL_PNG,
    }));
    files.splice(5, 0, { fieldname: 'mask', value: PIXEL_PNG });
    files.push({ fieldname: 'mask', value: PIXEL_GIF });

    const body = await parseImageMultipartRequest(createFileOnlyRequest(files));

    expect(Array.isArray(body.image)).toBe(true);
    expect(body.image).toHaveLength(MAX_INPUT_IMAGES);
    expect(body.mask).toEqual(expect.objectContaining({ data: PIXEL_GIF.toString('base64') }));
  });

  it('overrides the global multipart file limit for sixteen images plus repeated masks', async () => {
    const server = Fastify();
    servers.push(server);
    await server.register(fastifyMultipart, { limits: { files: MAX_INPUT_IMAGES } });
    server.post('/images/edits', async (request) => parseImageMultipartRequest(request));

    const boundary = '----antigravity-sixteen-images-and-mask';
    const imageParts = Array.from(
      { length: MAX_INPUT_IMAGES },
      (_, index) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${index}.png"\r\nContent-Type: image/png\r\n\r\n${PIXEL_PNG.toString('latin1')}`,
    );
    const maskParts = [PIXEL_PNG, PIXEL_GIF].map(
      (value, index) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="mask"; filename="mask-${index}.png"\r\nContent-Type: image/png\r\n\r\n${value.toString('latin1')}`,
    );
    const response = await server.inject({
      method: 'POST',
      url: '/images/edits',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(
        [...imageParts, ...maskParts, `--${boundary}--`, ''].join('\r\n'),
        'latin1',
      ),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().image).toHaveLength(MAX_INPUT_IMAGES);
    expect(response.json().mask.data).toBe(PIXEL_GIF.toString('base64'));
  });

  it('drains unsupported file fields without buffering them', async () => {
    const resume = vi.fn();
    const toBuffer = vi.fn(async () => Buffer.alloc(100 * 1024 * 1024));
    const request = {
      isMultipart: () => true,
      parts: async function* () {
        yield {
          type: 'file',
          fieldname: 'imageReference',
          filename: 'ignored.png',
          mimetype: 'image/png',
          file: { resume },
          toBuffer,
        };
      },
    } as unknown as FastifyRequest;

    await expect(parseImageMultipartRequest(request)).resolves.toEqual({});
    expect(resume).toHaveBeenCalledOnce();
    expect(toBuffer).not.toHaveBeenCalled();
  });

  it('lets the application reject a seventeenth image behind the production file limit', async () => {
    const server = Fastify();
    servers.push(server);
    await server.register(fastifyMultipart, { limits: { files: MAX_INPUT_IMAGES } });
    server.post('/images/edits', async (request, reply) => {
      try {
        return await parseImageMultipartRequest(request);
      } catch (error) {
        return reply
          .status(400)
          .send(error instanceof Error ? error.message : 'Invalid multipart request');
      }
    });

    const boundary = '----antigravity-seventeenth-image';
    const imageParts = Array.from(
      { length: MAX_INPUT_IMAGES + 1 },
      (_, index) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${index}.png"\r\nContent-Type: image/png\r\n\r\n${PIXEL_PNG.toString('latin1')}`,
    );
    const response = await server.inject({
      method: 'POST',
      url: '/images/edits',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from([...imageParts, `--${boundary}--`, ''].join('\r\n'), 'latin1'),
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe('Too many input images: maximum is 16');
  });

  it('rejects a seventeenth edit image', async () => {
    const files = Array.from({ length: MAX_INPUT_IMAGES + 1 }, () => ({
      fieldname: 'image',
      value: PIXEL_PNG,
    }));

    await expect(parseImageMultipartRequest(createFileOnlyRequest(files))).rejects.toThrow(
      'Too many input images: maximum is 16',
    );
  });
});
