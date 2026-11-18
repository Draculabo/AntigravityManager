import { afterEach, describe, expect, it, vi } from 'vitest';
import { map, Observable } from 'rxjs';
import { z } from 'zod';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIResponsesSessionStore } from '@/server/gateway/modules/openai/responses/openai-responses-session.store';
import { createResponsesWebSocketOperations } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.operations';
import type {
  AnthropicChatRequest,
  OpenAIChatRequest,
} from '@/server/gateway/common/interfaces/request-interfaces';
import {
  collect,
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'signature-roundtrip-test/1.0',
}));

// Protobuf tags and an ASCII UUID remain valid UTF-8 despite being binary signature bytes.
const signature = Buffer.from('\x12\x26\x0a\x24' + '00000000-0000-4000-8000-000000000347').toString(
  'base64',
);
const response = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: { id: 'call_roundtrip', name: 'read', args: {} },
            thoughtSignature: signature,
          },
        ],
      },
      finishReason: 'STOP',
    },
  ],
};

describe('opaque signatures through the real gateway tool continuation', () => {
  afterEach(() => {
    SignatureStore.clear();
    OpenAIResponsesSessionStore.clear();
  });

  it.each([false, true])(
    'Anthropic retains Base64 through its cache, stream=%s',
    async (stream) => {
      const upstream = createUpstream({
        generate: response,
        streamFrames: [geminiStreamFrame(response)],
      });
      const { anthropicService } = createGateway(
        upstream,
        createLease([createAccount('roundtrip')]),
      );
      const request: AnthropicChatRequest = {
        model: 'gemini-3.1-pro-low',
        max_tokens: 128,
        stream,
        messages: [{ role: 'user', content: 'Read the synthetic fixture' }],
        tools: [{ name: 'read', input_schema: { type: 'object' } }],
      };
      const first = await anthropicService.handleAnthropicMessages(request);
      if (first instanceof Observable) {
        await collect(first);
      }
      const next = await anthropicService.handleAnthropicMessages({
        ...request,
        messages: [
          ...request.messages,
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_roundtrip', name: 'read', input: {} }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call_roundtrip', content: 'fixture result' },
            ],
          },
        ],
      });
      if (next instanceof Observable) {
        await collect(next);
      }
      expect(
        upstream.calls[1]?.body.request.contents
          .flatMap((item) => item.parts)
          .filter((part) => part.functionCall)
          .map((part) => part.thoughtSignature),
      ).toEqual([signature]);
    },
  );

  it.each([false, true])('OpenAI retains Base64 through its cache, stream=%s', async (stream) => {
    const upstream = createUpstream({
      generate: response,
      streamFrames: [geminiStreamFrame(response)],
    });
    const { openAIService } = createGateway(upstream, createLease([createAccount('roundtrip')]));
    const request: OpenAIChatRequest = {
      model: 'gemini-3.1-pro-low',
      stream,
      messages: [{ role: 'user', content: 'Read the synthetic fixture' }],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    };
    const first = await openAIService.handleChatCompletions(request);
    if (first instanceof Observable) {
      await collect(first);
    }
    const next = await openAIService.handleChatCompletions({
      ...request,
      messages: [
        ...request.messages,
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_roundtrip', type: 'function', function: { name: 'read', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_roundtrip', content: 'fixture result' },
      ],
    });
    if (next instanceof Observable) {
      await collect(next);
    }
    expect(
      upstream.calls[1]?.body.request.contents
        .flatMap((item) => item.parts)
        .filter((part) => part.functionCall)
        .map((part) => part.thoughtSignature),
    ).toEqual([signature]);
  });

  it.each([
    { stream: false, store: true },
    { stream: true, store: true },
    { stream: false, store: false },
    { stream: true, store: false },
  ])(
    'Responses retains Base64 through its parent lineage, stream=$stream, store=$store',
    async ({ stream, store }) => {
      const upstream = createUpstream({
        generate: response,
        streamFrames: [geminiStreamFrame(response)],
      });
      const { openAIService } = createGateway(upstream, createLease([createAccount('roundtrip')]));
      const operations = new OpenAIOperations(openAIService);
      const first = createReply();
      await operations.responses(
        {
          model: 'gemini-3.1-pro-low',
          input: 'Read the synthetic fixture',
          tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
          stream,
        },
        first as never,
      );
      let responseId: string;
      if (first.body instanceof Observable) {
        const terminal = z.object({
          type: z.literal('response.completed'),
          response: z.object({ id: z.string() }),
        });
        const completed = (await collect(first.body))
          .split('\n')
          .filter((line) => line.startsWith('data: {'))
          .map((line) => terminal.safeParse(JSON.parse(line.slice(6))))
          .find((event) => event.success);
        if (!completed?.success) {
          throw new Error('Expected a completed Responses stream');
        }
        responseId = completed.data.response.id;
      } else {
        responseId = z.object({ id: z.string() }).parse(first.body).id;
      }
      const next = createReply();
      await operations.responses(
        {
          model: 'gemini-3.1-pro-low',
          previous_response_id: responseId,
          store,
          input: [
            { type: 'function_call_output', call_id: 'call_roundtrip', output: 'fixture result' },
          ],
          stream,
        },
        next as never,
      );
      if (next.body instanceof Observable) {
        await collect(next.body);
      }
      expect(
        upstream.calls[1]?.body.request.contents
          .flatMap((item) => item.parts)
          .filter((part) => part.functionCall)
          .map((part) => part.thoughtSignature),
      ).toEqual([signature]);
    },
  );

  it.each([false, true])(
    'transient Responses restores signatures from complete history and isolates a different task, stream=%s',
    async (stream) => {
      const upstream = createUpstream({
        generate: response,
        streamFrames: [geminiStreamFrame(response)],
      });
      const { openAIService } = createGateway(upstream, createLease([createAccount('roundtrip')]));
      const operations = new OpenAIOperations(openAIService);
      const tools = [{ type: 'function', name: 'read', parameters: { type: 'object' } }];
      const first = createReply();
      await operations.responses(
        {
          model: 'gemini-3.1-pro-low',
          input: 'Read the synthetic fixture',
          tools,
          stream,
          store: false,
        },
        first as never,
      );
      if (first.body instanceof Observable) {
        await collect(first.body);
      }
      for (const task of ['Read the synthetic fixture', 'Read a different task']) {
        const next = createReply();
        await operations.responses(
          {
            model: 'gemini-3.1-pro-low',
            store: false,
            stream,
            tools,
            input: [
              { type: 'message', role: 'user', content: task },
              { type: 'function_call', call_id: 'call_roundtrip', name: 'read', arguments: '{}' },
              { type: 'function_call_output', call_id: 'call_roundtrip', output: 'fixture failed' },
            ],
          },
          next as never,
        );
        if (next.body instanceof Observable) {
          await collect(next.body);
        }
      }
      expect(
        upstream.calls.slice(1).map(({ body }) =>
          body.request.contents
            .flatMap((item) => item.parts)
            .filter((part) => part.functionCall)
            .map((part) => part.thoughtSignature),
        ),
      ).toEqual([[signature], [undefined]]);
    },
  );

  it('restores a transient full transcript through the WebSocket operations boundary', async () => {
    const upstream = createUpstream({ streamFrames: [geminiStreamFrame(response)] });
    const { openAIService } = createGateway(upstream, createLease([createAccount('roundtrip')]));
    const operations = createResponsesWebSocketOperations(
      new OpenAIOperations(openAIService),
      openAIService,
    );
    const validate = operations.validateRequest;
    if (!validate) {
      throw new Error('Responses operations must validate WebSocket requests');
    }
    const input = [{ type: 'message', role: 'user', content: 'Read the synthetic fixture' }];
    const first = {
      model: 'gemini-3.1-pro-low',
      store: false,
      stream: true,
      input,
      tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
    };
    const context = { headers: { 'x-session-id': 'transient-socket' }, url: '/v1/responses' };
    await validate(first, 'generate', context);
    await collect(
      (await operations.streamRequest(first)).pipe(map((event) => z.string().parse(event))),
    );
    const next = {
      ...first,
      input: [
        ...input,
        { type: 'function_call', call_id: 'call_roundtrip', name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_roundtrip', output: 'fixture failed' },
      ],
    };
    await validate(next, 'generate', context);
    await collect(
      (await operations.streamRequest(next)).pipe(map((event) => z.string().parse(event))),
    );
    expect(
      upstream.calls[1]?.body.request.contents
        .flatMap((item) => item.parts)
        .filter((part) => part.functionCall)
        .map((part) => part.thoughtSignature),
    ).toEqual([signature]);
  });
});
