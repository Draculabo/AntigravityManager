import type { FastifyReply } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

type RouteReply = FastifyReply & {
  body?: unknown;
  statusCode?: number;
};

function createRouteReply(): RouteReply {
  const reply: RouteReply = Object.create(null);
  reply.header = vi.fn(() => reply);
  reply.status = vi.fn((statusCode: number) => {
    reply.statusCode = statusCode;
    return reply;
  });
  reply.send = vi.fn((body: unknown) => {
    reply.body = body;
    return reply;
  });
  return reply;
}

function createSurface() {
  const upstream = createUpstream({ generate: geminiTextResponse('{"ok":true}') });
  const lease = createLease([createAccount('acc-1')]);
  return {
    controller: new OpenAIOperations(createGateway(upstream, lease).openAIService),
    lease,
    upstream,
  };
}

describe('OpenAI Responses preflight errors', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
  });

  it('returns the OpenAI error envelope for malformed Responses json_schema before calling upstream', async () => {
    const { controller, upstream } = createSurface();
    const reply = createRouteReply();

    await controller.responses(
      {
        input: 'answer',
        model: 'gemini-3-flash',
        text: {
          format: {
            name: 'answer',
            schema: [],
            type: 'json_schema',
          },
        },
      },
      reply,
    );

    expect(reply.statusCode).toBe(400);
    expect(reply.body).toMatchObject({
      error: {
        message: expect.stringMatching(/Invalid response_format/),
        type: 'server_error',
      },
    });
    expect(upstream.calls).toHaveLength(0);
  });

  it('returns the OpenAI error envelope for malformed Responses input_audio before calling upstream', async () => {
    const { controller, upstream } = createSurface();
    const reply = createRouteReply();

    await controller.responses(
      {
        input: [
          {
            content: [
              {
                input_audio: { data: 'AA==', format: false },
                type: 'input_audio',
              },
            ],
            role: 'user',
            type: 'message',
          },
        ],
        model: 'gemini-3-flash',
      },
      reply,
    );

    expect(reply.statusCode).toBe(400);
    expect(reply.body).toMatchObject({
      error: {
        message: expect.stringMatching(/input_audio must be an object/),
        type: 'server_error',
      },
    });
    expect(upstream.calls).toHaveLength(0);
  });

  it('rejects malformed inline image data before account selection or upstream work', async () => {
    const { controller, upstream } = createSurface();
    const reply = createRouteReply();

    await controller.responses(
      {
        input: [
          {
            role: 'user',
            type: 'message',
            content: [
              {
                type: 'input_image',
                image_url: 'data:image/png;base64,not-base64',
              },
            ],
          },
        ],
        model: 'gemini-3-flash',
      },
      reply,
    );

    expect(reply.statusCode).toBe(400);
    expect(reply.body).toMatchObject({
      error: {
        message: 'Input image contains invalid base64 data',
        type: 'server_error',
      },
    });
    expect(upstream.calls).toHaveLength(0);
  });

  it('keeps the previous_response_id not-found response outside the generic error envelope', async () => {
    const { controller, upstream } = createSurface();
    const reply = createRouteReply();

    await controller.responses(
      {
        input: 'continue',
        previous_response_id: 'resp_missing',
      },
      reply,
    );

    expect(reply.statusCode).toBe(404);
    expect(reply.body).toEqual({
      error: {
        code: 'previous_response_not_found',
        message: "Previous response with id 'resp_missing' not found.",
        param: 'previous_response_id',
        type: 'invalid_request_error',
      },
    });
    expect(upstream.calls).toHaveLength(0);
  });

  it('keeps missing previous_response_id ahead of malformed image validation', async () => {
    const { controller, lease, upstream } = createSurface();
    const reply = createRouteReply();

    await controller.responses(
      {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: 'data:image/png;base64,not-base64' }],
          },
        ],
        previous_response_id: 'resp_missing',
      },
      reply,
    );

    expect(reply.statusCode).toBe(404);
    expect(reply.body).toEqual({
      error: {
        code: 'previous_response_not_found',
        message: "Previous response with id 'resp_missing' not found.",
        param: 'previous_response_id',
        type: 'invalid_request_error',
      },
    });
    expect(lease.getNextToken).not.toHaveBeenCalled();
    expect(upstream.calls).toEqual([]);
  });

  it('continues to send valid Responses json_schema and input_audio requests upstream', async () => {
    const { controller, upstream } = createSurface();
    const jsonSchemaReply = createRouteReply();

    await controller.responses(
      {
        input: 'answer',
        model: 'gemini-3-flash',
        text: {
          format: {
            name: 'answer',
            schema: { properties: { ok: { type: 'boolean' } }, type: 'object' },
            type: 'json_schema',
          },
        },
      },
      jsonSchemaReply,
    );

    const audioReply = createRouteReply();
    await controller.responses(
      {
        input: [
          {
            content: [
              {
                input_audio: { data: 'UklGRjAwMDBXQVZFZm10IA==', format: 'wav' },
                type: 'input_audio',
              },
            ],
            role: 'user',
            type: 'message',
          },
        ],
        model: 'gemini-3-flash',
      },
      audioReply,
    );

    expect(jsonSchemaReply.statusCode).toBe(200);
    expect(audioReply.statusCode).toBe(200);
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls[0]?.body.request.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      responseSchema: { type: 'object' },
    });
  });
});
