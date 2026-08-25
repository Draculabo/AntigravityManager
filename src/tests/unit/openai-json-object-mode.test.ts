import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
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
  '@/modules/proxy-gateway/server/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRequestUserAgent: async () => 'antigravity-parity-harness/0.0.0',
  }),
);

function chatRequest(responseFormat?: { type?: string }) {
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
  });

  it('leaves the response type alone when the client asks for nothing', async () => {
    const body = await upstreamBodyFor(chatRequest());

    expect(body.request.generationConfig?.responseMimeType).toBeUndefined();
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
});
