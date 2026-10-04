import { describe, expect, it } from 'vitest';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import {
  DEFAULT_PROXY_JSON_BODY_LIMIT_BYTES,
  isModelPayloadRoute,
} from '@/modules/proxy-gateway/server/proxy.constants';
import { createFastifyAdapter } from '@/server/main';
import { MAX_IMAGE_GENERATION_BODY_BYTES } from '@/modules/proxy-gateway/server/modules/openai/media/image-input-validation';

describe('gateway JSON body limits', () => {
  it('correctly classifies model payload routes and excludes administrative routes', () => {
    // Model conversation, completion, batch, and diagnostic routes
    expect(isModelPayloadRoute('/v1/chat/completions')).toBe(true);
    expect(isModelPayloadRoute('/v1/completions')).toBe(true);
    expect(isModelPayloadRoute('/v1/complete')).toBe(true);
    expect(isModelPayloadRoute('/v1/messages')).toBe(true);
    expect(isModelPayloadRoute('/v1/messages/count_tokens')).toBe(true);
    expect(isModelPayloadRoute('/v1/responses')).toBe(true);
    expect(isModelPayloadRoute('/v1/batches')).toBe(true);
    expect(isModelPayloadRoute('/v1/messages/batches')).toBe(true);
    expect(isModelPayloadRoute('/v1beta/models/:modelAction')).toBe(true);
    expect(isModelPayloadRoute('/v1beta/models/:model/countTokens')).toBe(true);
    expect(isModelPayloadRoute('/v1internal/countTokens')).toBe(true);
    expect(isModelPayloadRoute('/v1internal/embedContent')).toBe(true);
    expect(isModelPayloadRoute('/v1internal/generateChat')).toBe(true);

    // Administrative, cancel, and non-model routes must keep Fastify safe default (1 MiB)
    expect(isModelPayloadRoute('/v1/thinking/end')).toBe(false);
    expect(isModelPayloadRoute('/internal/audit/repair')).toBe(false);
    expect(isModelPayloadRoute('/internal/thinking/repair')).toBe(false);
    expect(isModelPayloadRoute('/v1/batches/:id/cancel')).toBe(false);
    expect(isModelPayloadRoute('/v1/messages/batches/:id/cancel')).toBe(false);
    expect(isModelPayloadRoute('/v1/images/generations')).toBe(false);
    expect(DEFAULT_PROXY_JSON_BODY_LIMIT_BYTES).toBe(64 * 1024 * 1024);
  });

  it('accepts JSON request payloads exceeding 1 MiB on model routes without 413', async () => {
    const adapter = createFastifyAdapter();
    expect(adapter).toBeInstanceOf(FastifyAdapter);
    const server = adapter.getInstance();

    server.post('/v1/chat/completions', (request, reply) => {
      reply.send({ receivedBytes: (request.body as { content: string }).content.length });
    });
    server.post('/v1/messages', (request, reply) => {
      reply.send({ receivedBytes: (request.body as { content: string }).content.length });
    });
    server.post('/v1beta/models/:modelAction', (request, reply) => {
      reply.send({ receivedBytes: (request.body as { content: string }).content.length });
    });

    await server.ready();

    // 2 MiB payload (> Fastify's default 1 MiB limit)
    const payload = JSON.stringify({ content: 'x'.repeat(2 * 1024 * 1024) });

    const chatRes = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(chatRes.statusCode).toBe(200);
    expect(JSON.parse(chatRes.body)).toEqual({ receivedBytes: 2 * 1024 * 1024 });

    const msgRes = await server.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(msgRes.statusCode).toBe(200);

    const geminiRes = await server.inject({
      method: 'POST',
      url: '/v1beta/models/gemini-2.5-flash:generateContent',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(geminiRes.statusCode).toBe(200);
  });

  it('rejects JSON payloads genuinely exceeding the 64 MiB ceiling on model routes with 413', async () => {
    const adapter = createFastifyAdapter();
    const server = adapter.getInstance();

    server.post('/v1/chat/completions', (_request, reply) => {
      reply.send({ ok: true });
    });

    await server.ready();

    // 65 MiB payload (> 64 MiB limit)
    const payload = JSON.stringify({ content: 'x'.repeat(65 * 1024 * 1024) });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(response.statusCode).toBe(413);
    const body = JSON.parse(response.body);
    expect(body.statusCode).toBe(413);
    expect(body.error).toBe('Payload Too Large');
  });

  it('keeps Fastify safe 1 MiB default on non-model administrative routes to mitigate DoS', async () => {
    const adapter = createFastifyAdapter();
    const server = adapter.getInstance();

    server.post('/v1/thinking/end', (_request, reply) => {
      reply.send({ ok: true });
    });
    server.post('/internal/audit/repair', (_request, reply) => {
      reply.send({ ok: true });
    });

    await server.ready();

    // 2 MiB payload (> Fastify's default 1 MiB limit)
    const payload = JSON.stringify({ content: 'x'.repeat(2 * 1024 * 1024) });

    const thinkingRes = await server.inject({
      method: 'POST',
      url: '/v1/thinking/end',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(thinkingRes.statusCode).toBe(413);

    const auditRes = await server.inject({
      method: 'POST',
      url: '/internal/audit/repair',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(auditRes.statusCode).toBe(413);
  });

  it('preserves dedicated route-specific body limit on /v1/images/generations', async () => {
    const adapter = createFastifyAdapter();
    const server = adapter.getInstance();

    server.post('/v1/images/generations', (_request, reply) => {
      reply.send({ ok: true });
    });

    await server.ready();

    // 2 MiB payload -> accepted
    const res2Mb = await server.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ content: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res2Mb.statusCode).toBe(200);

    // Payload exceeding MAX_IMAGE_GENERATION_BODY_BYTES (~45.7 MiB) -> rejected with 413
    const resOver = await server.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        content: 'x'.repeat(MAX_IMAGE_GENERATION_BODY_BYTES + 1024),
      }),
    });
    expect(resOver.statusCode).toBe(413);
  });
});
