// @vitest-environment node
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { OpenAIChatRequest } from '@/server/gateway/common/interfaces/request-interfaces';
import { OpenAIChatController } from '@/server/gateway/modules/openai/openai-chat.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiStreamFrame,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'hermes-prompt-fixture/0.0.0',
}));

describe('Hermes compact system prompt over OpenAI Chat', () => {
  it.each([false, true])('only replaces the opted-in system message (stream=%s)', async (stream) => {
    const result = geminiTextResponse('OK');
    const upstream = createUpstream({ generate: result, streamFrames: [geminiStreamFrame(result)] });
    const lease = createLease([createAccount('hermes-prompt-fixture')]);
    const gateway = createGateway(upstream, lease);
    const controller = new OpenAIChatController(new OpenAIOperations(gateway.openAIService));
    const app = Fastify();
    app.post<{ Body: OpenAIChatRequest }>('/v1/chat/completions', (req, res) =>
      controller.chatCompletions(req.body, res, req),
    );
    const messages = [
      {
        role: 'system',
        content: 'You are Hermes Agent, built by Nous Research. Verbose synthetic context.',
      },
      { role: 'developer', content: 'Retain this separate instruction.' },
      { role: 'user', content: 'Reply with only OK.' },
    ];
    const body: OpenAIChatRequest = {
      model: 'gemini-3-flash',
      stream,
      messages,
      tools: ['todo', 'search', 'read_file'].map((name) => ({
        type: 'function',
        function: {
          name,
          description: `Use the ${name} tool.`,
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      })),
    };
    const compactHeaders = { 'x-antigravity-hermes-prompt': 'compact' };
    try {
      for (const [headers, payload] of [
        [{}, body],
        [compactHeaders, body],
        [
          compactHeaders,
          {
            ...body,
            messages: [
              { role: 'system', content: 'Generate a title for the current session.' },
              ...messages.slice(1),
            ],
          },
        ],
      ] as const) {
        const reply = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers,
          payload,
        });
        expect(reply.statusCode).toBe(200);
        expect(reply.body).toContain('OK');
      }
      const [normal, compact, auxiliary] = upstream.calls.map((call) => call.body.request);
      expect(upstream.calls).toHaveLength(3);
      expect(normal?.systemInstruction?.parts.map((part) => part.text).join('\n')).toContain(
        'Verbose synthetic context.',
      );
      const compactSystem = compact?.systemInstruction?.parts.map((part) => part.text).join('\n');
      expect(compactSystem).toContain('Answer briefly.');
      expect(compactSystem).toContain('Retain this separate instruction.');
      expect(compactSystem).not.toContain('Verbose synthetic context.');
      expect(auxiliary?.systemInstruction?.parts.map((part) => part.text).join('\n')).toContain(
        'Generate a title for the current session.',
      );
      expect(compact?.contents).toEqual(normal?.contents);
      expect(compact?.tools).toEqual(normal?.tools);
      expect(
        new Set(compact?.tools?.flatMap((tool) => tool.functionDeclarations?.map((item) => item.name))),
      ).toEqual(new Set(['todo', 'search', 'read_file']));
    } finally {
      await app.close();
    }
  });
});
