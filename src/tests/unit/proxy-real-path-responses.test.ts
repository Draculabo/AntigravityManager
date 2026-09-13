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

  it.each([false, true])(
    'preserves tool-result text and image through the real Responses path with stream=%s',
    async (stream) => {
      const upstream = createUpstream({
        generate: geminiTextResponse('ok'),
        streamFrames: [geminiStreamFrame(geminiTextResponse('ok'))],
      });
      const lease = createLease([createAccount('acc-1')]);
      const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
      const reply = createReply();

      await controller.responses(
        {
          model: 'gemini-3-flash',
          stream,
          store: false,
          input: [
            { role: 'user', content: 'Generate an image.' },
            {
              type: 'function_call',
              call_id: 'call_image',
              name: 'view_image',
              arguments: '{}',
            },
            {
              type: 'function_call_output',
              call_id: 'call_image',
              output: [
                { type: 'input_text', text: 'image generated' },
                {
                  type: 'input_image',
                  image_url: 'data:image/webp;name=source;BASE64,AQ==',
                },
              ],
            },
          ],
        },
        reply as never,
      );
      if (stream) {
        if (!(reply.body instanceof Observable)) {
          throw new Error('Expected a Responses stream');
        }
        await collect(reply.body);
      }

      const toolParts = upstream.calls[0]?.body.request.contents[2]?.parts;
      expect(toolParts).toEqual([
        expect.objectContaining({
          functionResponse: {
            name: 'view_image',
            response: { result: 'image generated' },
            id: 'call_image',
          },
        }),
        { inlineData: { mimeType: 'image/webp', data: 'AQ==' } },
      ]);
      expect(JSON.stringify(toolParts?.[0])).not.toContain('data:image/');
    },
  );

  it('maps Responses message audio_url to provider-readable media', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();

    await controller.responses(
      {
        model: 'gemini-3-flash',
        stream: false,
        store: false,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'audio_url',
                audio_url: { url: 'https://example.com/sample.wav', mimeType: 'audio/wav' },
              },
            ],
          },
        ],
      },
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(upstream.calls[0]?.body.request.contents).toEqual([
      {
        role: 'user',
        parts: [
          {
            fileData: { fileUri: 'https://example.com/sample.wav', mimeType: 'audio/wav' },
          },
        ],
      },
    ]);
  });

  it('uses the Responses tool audio_url fallback for an unreadable source', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();

    await controller.responses(
      {
        model: 'gemini-3-flash',
        stream: false,
        store: false,
        input: [
          { role: 'user', content: 'Inspect the audio.' },
          {
            type: 'function_call',
            call_id: 'call_audio',
            name: 'inspect_audio',
            arguments: '{}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_audio',
            output: [{ type: 'audio_url', audio_url: { url: 'unresolvable-audio' } }],
          },
        ],
      },
      reply as never,
    );

    expect(upstream.calls[0]?.body.request.contents[2]?.parts).toEqual([
      expect.objectContaining({
        functionResponse: {
          name: 'inspect_audio',
          response: { result: '[audio]' },
          id: 'call_audio',
        },
      }),
    ]);
  });

  it.each([false, true])(
    'restores a stored parent for store:false without retaining the transient response, stream=%s',
    async (stream) => {
      let generateCount = 0;
      const upstream = createUpstream({
        generate: () => geminiTextResponse(generateCount++ === 0 ? 'root answer' : 'next answer'),
        streamFrames: [geminiStreamFrame(geminiTextResponse('next answer'))],
      });
      const lease = createLease([createAccount('acc-1')]);
      const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
      const rootReply = createReply();

      await controller.responses(
        {
          model: 'gemini-3-flash',
          input: 'root request',
          instructions: 'Stay concise.',
          tools: [
            {
              type: 'function',
              function: { name: 'lookup', parameters: { type: 'object' } },
            },
          ],
        },
        rootReply as never,
      );
      const rootResponseId = z.object({ id: z.string().min(1) }).parse(rootReply.body).id;
      const replayWithoutIds = (
        OpenAIResponsesSessionStore.get(rootResponseId)?.inputItems ?? []
      ).map((item) => {
        const copy = structuredClone(item);
        if (typeof copy === 'object' && copy !== null && !Array.isArray(copy)) {
          Reflect.deleteProperty(copy, 'id');
        }
        return copy;
      });
      const transientReply = createReply();
      await controller.responses(
        {
          input: [...replayWithoutIds, { type: 'message', role: 'user', content: 'next request' }],
          previous_response_id: rootResponseId,
          store: false,
          stream,
        },
        transientReply as never,
      );

      let transientResponseId: string;
      if (stream) {
        if (!(transientReply.body instanceof Observable)) {
          throw new Error('Expected a Responses stream');
        }
        const events = (await collect(transientReply.body))
          .split('\n')
          .filter((line) => line.startsWith('data: {'))
          .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
        const completed = events.find((event) => event.type === 'response.completed');
        transientResponseId = z
          .object({ response: z.object({ id: z.string().min(1) }) })
          .parse(completed).response.id;
      } else {
        transientResponseId = z.object({ id: z.string().min(1) }).parse(transientReply.body).id;
      }

      expect(upstream.calls[1]?.body.request.contents).toEqual([
        { role: 'user', parts: [{ text: 'root request' }] },
        { role: 'model', parts: [{ text: 'root answer' }] },
        { role: 'user', parts: [{ text: 'next request' }] },
      ]);
      expect(upstream.calls[1]?.body.request.systemInstruction).toMatchObject({
        parts: [{ text: expect.stringContaining('Stay concise.') }],
      });
      expect(JSON.stringify(upstream.calls[1]?.body.request.tools)).toContain('lookup');
      expect(OpenAIResponsesSessionStore.get(transientResponseId)).toBeNull();
      expect(lease.getNextToken).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ sessionKey: `openai:${rootResponseId}` }),
      );
    },
  );
});
