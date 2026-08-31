import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';
import { z } from 'zod';

import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
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
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock(
  '@/modules/proxy-gateway/server/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRequestUserAgent: async () => 'antigravity-parity-harness/0.0.0',
  }),
);

describe('real request path, Responses input compatibility', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
    OpenAIResponsesSessionStore.clear();
  });

  it.each(['direct', 'stream aggregation'])(
    'normalizes candidates, text blocks and absent usage via %s',
    async (path) => {
      const response = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: 'First ' },
                { text: 'Fixture reasoning.', thought: true },
                { text: 'answer.' },
              ],
            },
            finishReason: 'STOP',
          },
          {
            content: { role: 'model', parts: [{ text: 'Second candidate.' }] },
            finishReason: 'STOP',
          },
        ],
        modelVersion: 'gemini-3-flash',
      };
      const upstream = createUpstream({
        generate: path === 'direct' ? response : { candidates: [] },
        streamFrames: [geminiStreamFrame(response)],
      });
      const lease = createLease([createAccount('acc-1')]);
      const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
      const reply = createReply();

      await controller.responses(
        { model: 'gemini-3-flash', input: 'Answer once.', stream: false, store: false },
        reply as never,
      );

      const metadata = z
        .object({ id: z.string().min(1), created_at: z.number().int() })
        .parse(reply.body);
      expect(reply.statusCode).toBe(200);
      expect(upstream.calls.map((call) => call.kind)).toEqual(
        path === 'direct' ? ['generate'] : ['generate', 'stream'],
      );
      expect(reply.body).toEqual({
        id: metadata.id,
        created_at: metadata.created_at,
        model: 'gemini-3-flash',
        object: 'response',
        type: 'response',
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [
          {
            id: `reasoning_${metadata.id}`,
            type: 'reasoning',
            status: 'completed',
            summary: [{ type: 'summary_text', text: 'Fixture reasoning.' }],
          },
          {
            id: `msg_${metadata.id}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'First answer.', annotations: [] }],
          },
        ],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      });
    },
  );

  it.each([false, true])(
    'sends only image data upstream with an empty text block present=%s',
    async (includeEmptyText) => {
      const upstream = createUpstream({ generate: geminiTextResponse('ok') });
      const lease = createLease([createAccount('acc-1')]);
      const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
      const reply = createReply();
      const image = { type: 'input_image', image_url: 'data:image/png;base64,AA==' };

      await controller.responses(
        {
          model: 'gemini-3-flash',
          input: [{ role: 'user', content: includeEmptyText ? [{ text: '' }, image] : [image] }],
          stream: false,
          store: false,
        },
        reply as never,
      );

      expect(reply.statusCode).toBe(200);
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]?.body.request.contents).toEqual([
        { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] },
      ]);
    },
  );

  it.each([
    {
      label: 'empty-type item',
      item: {
        type: '',
        role: 'user',
        content: [{ type: 'input_image', file_id: 'file_missing' }],
      },
      param: 'body.input.0.content.0',
    },
    {
      label: 'object content',
      item: {
        type: 'message',
        role: 'user',
        content: { type: 'input_image', file_id: 'file_missing' },
      },
      param: 'body.input.0.content',
    },
  ])('preserves attachment preflight errors in $label', async ({ item, param }) => {
    const upstream = createUpstream({});
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();
    const input = [item, { role: 'user', content: 'Keep this text.' }];
    const before = structuredClone(input);

    await controller.responses({ model: 'gemini-3-flash', input }, reply as never);

    expect(reply.statusCode).toBe(404);
    expect(reply.body).toEqual({
      error: {
        code: 'file_not_found',
        message: `${param} references 'file_missing', but the file store is not available on this proxy`,
        param,
        type: 'invalid_request_error',
      },
    });
    expect(lease.getNextToken).not.toHaveBeenCalled();
    expect(upstream.calls).toEqual([]);
    expect(input).toEqual(before);
  });

  it.each([false, true])('excludes ignored input from upstream with stream=%s', async (stream) => {
    const upstream = createUpstream({
      generate: geminiTextResponse('ok'),
      streamFrames: [geminiStreamFrame(geminiTextResponse('ok'))],
    });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();
    const input = [
      { type: '', role: 'user', content: 'Ignored empty-type text.' },
      { type: 'message', role: 'user', content: { legacy: 'Ignored object text.' } },
      { role: 'user', content: 'Keep only this.' },
    ];
    const before = structuredClone(input);

    await controller.responses(
      { model: 'gemini-3-flash', input, stream, store: false },
      reply as never,
    );
    if (stream) {
      if (!(reply.body instanceof Observable)) {
        throw new Error('Expected a Responses stream');
      }
      expect(await collect(reply.body)).toContain('"type":"response.completed"');
    } else {
      expect(reply.statusCode).toBe(200);
    }

    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.body.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'Keep only this.' }] },
    ]);
    expect(input).toEqual(before);
  });
});
