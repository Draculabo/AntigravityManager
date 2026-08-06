import fastifyMultipart from '@fastify/multipart';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { parseImageMultipartRequest } from '@/modules/proxy-gateway/server/modules/openai/media/image-multipart-request';

const servers: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('parseImageMultipartRequest', () => {
  it('parses real multipart fields and preserves uploaded MIME types', async () => {
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
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="main.webp"\r\nContent-Type: image/webp\r\n\r\nMAIN`,
        `--${boundary}\r\nContent-Disposition: form-data; name="image1"; filename="reference.jpg"\r\nContent-Type: image/jpeg\r\n\r\nREFERENCE`,
        `--${boundary}--\r\n`,
      ].join('\r\n'),
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
      prompt: 'make it brighter, style: vivid',
      quality: 'hd',
      size: '16:9',
      image: {
        data: Buffer.from('MAIN').toString('base64'),
        filename: 'main.webp',
        mimeType: 'image/webp',
      },
      reference_images: [
        {
          data: Buffer.from('REFERENCE').toString('base64'),
          filename: 'reference.jpg',
          mimeType: 'image/jpeg',
        },
      ],
    });
  });
});
