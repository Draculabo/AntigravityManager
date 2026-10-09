import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';
import { z } from 'zod';
import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { buildResponsesChatRequest } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-request';
import { OpenAIResponsesSessionStore } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.store';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import {
  collect,
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock(
  '@/modules/proxy-gateway/server/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/modules/proxy-gateway/server/common/utils/request-user-agent')
    >()),
    resolveRequestUserAgent: async () => 'controlled-namespace-fixture/0.0.0',
  }),
);

describe('Responses MCP namespace through the production request path', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
    OpenAIResponsesSessionStore.clear();
  });

  it.each(['unary', 'stream', 'stream fallback'])(
    'restores output and continuation via %s',
    async (mode) => {
      const generation = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { functionCall: { id: 'call_probe', name: 'mcp__probe__read_probe', args: {} } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      };
      const upstream = createUpstream({
        generate: generation,
        streamFrames: [geminiStreamFrame(generation)],
        ...(mode === 'stream fallback'
          ? { streamError: new Error('Controlled stream failure') }
          : {}),
      });
      const controller = new OpenAIOperations(
        createGateway(upstream, createLease([createAccount('acc-1')])).openAIService,
      );
      const reply = createReply();
      const tools = [
        {
          type: 'namespace',
          name: 'mcp__probe',
          tools: [
            {
              type: 'function',
              name: 'read_probe',
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
      ];
      await controller.responses(
        {
          model: 'gemini-3-flash',
          input: 'Read the controlled probe.',
          tools,
          stream: mode !== 'unary',
          store: false,
        },
        reply as never,
      );
      let response = reply.body;
      if (mode !== 'unary') {
        if (!(reply.body instanceof Observable)) {
          throw new Error('Expected the production Responses stream');
        }
        const events = (await collect(reply.body))
          .split('\n')
          .filter((line) => line.startsWith('data: {'))
          .map((line) =>
            z
              .object({ type: z.string(), response: z.unknown().optional() })
              .parse(JSON.parse(line.slice(6))),
          );
        expect(events.at(-1)?.type).toBe('response.completed');
        response = events.at(-1)?.response;
      }
      const output = z.object({ output: z.array(z.unknown()) }).parse(response).output;
      expect(upstream.calls.map((call) => call.kind)).toEqual(
        mode === 'unary' ? ['generate'] : mode === 'stream' ? ['stream'] : ['stream', 'generate'],
      );
      expect(output).toEqual([
        expect.objectContaining({
          type: 'function_call',
          name: 'read_probe',
          namespace: 'mcp__probe',
          arguments: '{}',
        }),
      ]);
      const call = z
        .object({
          type: z.literal('function_call'),
          name: z.string(),
          namespace: z.string(),
          call_id: z.string(),
          arguments: z.string(),
        })
        .parse(output[0]);
      expect(
        buildResponsesChatRequest({
          model: 'gemini-3-flash',
          tools,
          input: [
            { type: 'message', role: 'user', content: 'Read the controlled probe.' },
            call,
            { type: 'function_call_output', call_id: call.call_id, output: 'controlled result' },
          ],
        }).messages,
      ).toEqual([
        { role: 'user', content: 'Read the controlled probe.' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: call.call_id,
              type: 'function',
              function: { name: 'mcp__probe__read_probe', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: call.call_id,
          name: 'mcp__probe__read_probe',
          content: 'controlled result',
        },
      ]);
    },
  );
});
