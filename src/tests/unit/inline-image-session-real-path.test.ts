import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  OpenAIChatRequest,
  AnthropicChatRequest,
  GeminiRequest,
} from '@/server/gateway/common/interfaces/request-interfaces';
import { buildResponsesChatRequest } from '@/server/gateway/modules/openai/responses/openai-responses-request';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import {
  collect,
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'inline-image-anchor-test/1.0',
}));
afterEach(() => {
  proxyModelAvailabilityStore.clearAccount('acc-1');
});
const data =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2Z8AAAAASUVORK5CYII=';
const url = `data:image/png;base64,${data}`;
const context = {
  headers: { authorization: 'Bearer synthetic-tenant', 'x-session-id': 'synthetic-session' },
};
describe('equivalent inline images at the generated protocol boundary', () => {
  it.each([false, true])(
    'preserves input and shares scoped upstream identity, stream=%s',
    async (stream) => {
      const upstream = createUpstream({
        generate: geminiTextResponse('ok'),
        streamFrames: [geminiStreamFrame(geminiTextResponse('ok'))],
      });
      const lease = createLease([createAccount('acc-1')]);
      const gateway = createGateway(upstream, lease);
      const chat: OpenAIChatRequest = {
        model: 'gemini-3-flash',
        stream,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe the image.' },
              { type: 'image_url', image_url: url },
            ],
          },
        ],
      };
      const messages: AnthropicChatRequest = {
        model: chat.model,
        stream,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe the image.' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
            ],
          },
        ],
      };
      const gemini: GeminiRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Describe the image.' },
              { inlineData: { mimeType: 'image/png', data } },
            ],
          },
        ],
      };
      const responseBody = buildResponsesChatRequest({
        model: chat.model,
        stream,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'Describe the image.' },
              { type: 'input_image', image_url: url },
            ],
          },
        ],
      });
      const before = structuredClone({ chat, messages, gemini, responseBody });
      for (const execute of [
        () =>
          gateway.openAIService.handleChatCompletions(
            chat,
            'chat-completions',
            undefined,
            undefined,
            undefined,
            context,
          ),
        () => gateway.anthropicService.handleAnthropicMessages(messages, context),
        () =>
          stream
            ? gateway.geminiService.handleGeminiStreamGenerateContent(
                chat.model,
                gemini,
                undefined,
                context,
              )
            : gateway.geminiService.handleGeminiGenerateContent(
                chat.model,
                gemini,
                'generate-content',
                undefined,
                'gemini',
                context,
              ),
        () =>
          gateway.openAIService.handleChatCompletions(
            responseBody,
            'responses',
            undefined,
            {
              requestSessionId: 'root',
              routingSessionId: 'synthetic-session',
              responseId: 'response-synthetic',
            },
            undefined,
            context,
          ),
      ]) {
        const result = await execute();
        if (result && 'subscribe' in result) {
          await collect(result);
        }
      }
      expect(upstream.calls).toHaveLength(4);
      expect(upstream.calls.map((x) => x.options?.upstreamSession)).toEqual(
        Array.from({ length: 4 }, () => upstream.calls[0].options?.upstreamSession),
      );
      expect(upstream.calls[0].options?.upstreamSession).toBeDefined();
      expect(
        upstream.calls.map((x) =>
          x.body.request.contents
            .flatMap((c) => c.parts)
            .flatMap((p) => (p.inlineData ? [p.inlineData] : [])),
        ),
      ).toEqual(Array.from({ length: 4 }, () => [{ mimeType: 'image/png', data }]));
      expect({ chat, messages, gemini, responseBody }).toEqual(before);
      expect(lease.penalties).toEqual([]);
    },
  );
});
