import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFastifyAdapter } from '@/server/main';
import { MAX_IMAGE_GENERATION_BODY_BYTES } from '@/modules/proxy-gateway/server/modules/openai/media/image-input-validation';

let server: FastifyInstance;

function jsonPayload(bytes: number): string {
  const empty = JSON.stringify({ text: '' });
  return JSON.stringify({ text: 'x'.repeat(bytes - Buffer.byteLength(empty)) });
}

beforeEach(() => {
  server = createFastifyAdapter().getInstance<FastifyInstance>();
});

afterEach(async () => {
  await server.close();
});

describe('gateway JSON body limits', () => {
  it.each([
    '/v1/chat/completions',
    '/v1/completions',
    '/v1/complete',
    '/v1/messages',
    '/v1/messages/count_tokens',
    '/v1/responses',
    '/v1/batches',
    '/v1/messages/batches',
    '/v1beta/models/:modelAction',
    '/v1beta/models/:model/countTokens',
    '/v1internal/countTokens',
    '/v1internal/embedContent',
    '/v1internal/generateChat',
  ])('parses a 2 MiB JSON request on %s', async (route) => {
    server.post(route, async () => ({ parsed: true }));
    const response = await server.inject({
      method: 'POST',
      url: route.replace(':modelAction', 'test:generateContent').replace(':model', 'test'),
      headers: { 'content-type': 'application/json' },
      payload: jsonPayload(2 * 1024 * 1024),
    });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 200,
      body: { parsed: true },
    });
  });

  it.each([
    '/v1/thinking/end',
    '/internal/audit/repair',
    '/internal/thinking/repair',
    '/v1/batches/:id/cancel',
    '/v1/messages/batches/:id/cancel',
  ])('rejects a 2 MiB JSON request on control route %s', async (route) => {
    server.post(route, async () => ({ parsed: true }));
    const response = await server.inject({
      method: 'POST',
      url: route.replace(':id', 'synthetic'),
      headers: { 'content-type': 'application/json' },
      payload: jsonPayload(2 * 1024 * 1024),
    });
    expect(response.statusCode).toBe(413);
  });

  it.each([
    { bytes: 64 * 1024 * 1024, status: 200 },
    { bytes: 64 * 1024 * 1024 + 1, status: 413 },
  ])('returns $status for a $bytes-byte model request', async ({ bytes, status }) => {
    server.post('/v1/chat/completions', async () => ({ parsed: true }));
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: jsonPayload(bytes),
    });
    expect(response.statusCode).toBe(status);
    if (status === 200) {
      expect(response.json()).toEqual({ parsed: true });
    }
  });

  it.each([
    { bytes: MAX_IMAGE_GENERATION_BODY_BYTES, status: 200 },
    { bytes: MAX_IMAGE_GENERATION_BODY_BYTES + 1, status: 413 },
  ])('returns $status at the $bytes-byte image boundary', async ({ bytes, status }) => {
    server.post('/v1/images/generations', async () => ({ parsed: true }));
    const response = await server.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: { 'content-type': 'application/json' },
      payload: jsonPayload(bytes),
    });
    expect(response.statusCode).toBe(status);
    if (status === 200) {
      expect(response.json()).toEqual({ parsed: true });
    }
  });
});
