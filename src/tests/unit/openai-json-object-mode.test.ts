import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import { buildResponsesChatRequest } from '@/server/gateway/modules/openai/responses/openai-responses-request';
import { toResponsesOpenAIResponseFormat } from '@/server/gateway/modules/openai/chat/openai-response-format';
import {
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

/**
 * `response_format: {"type": "json_object"}` over the real chain. The field is part of the
 * OpenAI chat contract and a client that asks for it parses the answer with `JSON.parse`.
 */

vi.mock(
  '@/server/gateway/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRequestUserAgent: async () => 'antigravity-parity-harness/0.0.0',
  }),
);

function chatRequest(responseFormat?: Record<string, unknown>) {
  return {
    messages: [{ content: 'give me json', role: 'user' }],
    model: 'gemini-3-flash',
    ...(responseFormat ? { response_format: responseFormat } : {}),
    stream: false,
  };
}

async function upstreamBodyFor(request: Record<string, unknown>) {
  const upstream = createUpstream({ generate: geminiTextResponse('{"ok":true}') });
  const lease = createLease([createAccount('acc-1')]);
  const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);

  await controller.chatCompletions(request as never, createReply() as never);

  return upstream.calls[0]?.body as {
    request: { generationConfig?: Record<string, unknown> };
  };
}

describe('OpenAI json_object response format', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
  });

  it('tells upstream to answer in JSON when the client asks for json_object', async () => {
    const body = await upstreamBodyFor(chatRequest({ type: 'json_object' }));

    expect(body.request.generationConfig?.responseMimeType).toBe('application/json');
  });

  it('leaves the response type alone when the client asks for text', async () => {
    const body = await upstreamBodyFor(chatRequest({ type: 'text' }));

    expect(body.request.generationConfig?.responseMimeType).toBeUndefined();
    expect(body.request.generationConfig?.responseSchema).toBeUndefined();
  });

  it('leaves the response type alone when the client asks for nothing', async () => {
    const body = await upstreamBodyFor(chatRequest());

    expect(body.request.generationConfig?.responseMimeType).toBeUndefined();
    expect(body.request.generationConfig?.responseSchema).toBeUndefined();
  });

  it('maps json_schema to a cleaned upstream response schema without mutating the request', async () => {
    const responseFormat = {
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        description: 'Structured answer',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            answer: { type: 'string', format: 'email' },
          },
          required: ['answer'],
        },
      },
    };
    const original = structuredClone(responseFormat);

    const body = await upstreamBodyFor(chatRequest(responseFormat));

    expect(body.request.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
    });
    expect(body.request.generationConfig?.responseSchema).not.toHaveProperty(
      'additionalProperties',
    );
    expect(responseFormat).toEqual(original);
  });

  it('still answers the client normally in JSON mode', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('{"ok":true}') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();

    await controller.chatCompletions(chatRequest({ type: 'json_object' }) as never, reply as never);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.body).toMatchObject({
      choices: [{ message: { content: '{"ok":true}' } }],
    });
  });

  it('returns 400 before any upstream call for a malformed json_schema envelope', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('{"ok":true}') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();

    await controller.chatCompletions(
      chatRequest({ type: 'json_schema', json_schema: { name: 'broken' } }) as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(upstream.calls).toHaveLength(0);
  });

  it('maps Responses text.format json_schema into the same chat contract', () => {
    const request = buildResponsesChatRequest({
      model: 'gemini-3-flash',
      input: 'answer',
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          strict: true,
          schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
      },
    });

    expect(request.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        description: undefined,
        strict: true,
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    });
  });

  it('rejects malformed Responses json_schema format objects at the conversion boundary', () => {
    expect(() =>
      toResponsesOpenAIResponseFormat({
        type: 'json_schema',
        name: 'answer',
        schema: [],
      }),
    ).toThrow(/Invalid response_format/);
    expect(() =>
      toResponsesOpenAIResponseFormat({
        type: 'json_schema',
        name: 7,
        schema: { type: 'object' },
      }),
    ).toThrow(/Invalid response_format/);
  });
});
