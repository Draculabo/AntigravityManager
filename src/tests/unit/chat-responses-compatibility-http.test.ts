// @vitest-environment node

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIChatController } from '@/server/gateway/modules/openai/openai-chat.controller';
import { OpenAIResponsesController } from '@/server/gateway/modules/openai/responses/openai-responses.controller';
import { createResponsesWebSocketOperations } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.operations';
import { OpenAIResponsesSessionService } from '@/server/gateway/modules/openai/responses/openai-responses-session.service';
import { OpenAIChatCompletionStoreImpl } from '@/server/gateway/modules/openai/chat/openai-chat-completion.store';
import { PIXEL_PNG } from '../fixtures/image-content';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: (token: string) => token === 'synthetic-chat-other' },
}));
vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'chat-compatibility-test/1.0',
}));

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const apps: NestFastifyApplication[] = [];
const ownerKey = 'synthetic-chat-owner';
const resultId = z.object({ id: z.string() });
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  setServerConfig(previous);
});

async function fixture(
  generate: unknown = geminiTextResponse('Character A is ready.'),
  streamResponse: Parameters<typeof geminiStreamFrame>[0] = geminiTextResponse(
    'Character A is ready.',
  ),
) {
  const store = new OpenAIResponsesSessionService({});
  const completions = new OpenAIChatCompletionStoreImpl({});
  const upstream = createUpstream({
    generate,
    streamFrames: [geminiStreamFrame(streamResponse)],
  });
  const lease = createLease([createAccount('chat-compatibility')]);
  const gateway = createGateway(upstream, lease);
  const operations = new OpenAIOperations(
    gateway.openAIService,
    undefined,
    undefined,
    store,
    completions,
  );
  @Module({
    controllers: [OpenAIChatController, OpenAIResponsesController],
    providers: [ProxyGuard, { provide: OpenAIOperations, useValue: operations }],
  })
  class ChatCompatibilityModule {}
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: ownerKey });
  const app = await NestFactory.create<NestFastifyApplication>(
    ChatCompatibilityModule,
    new FastifyAdapter(),
    { logger: false },
  );
  apps.push(app);
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const send = (payload: object, route = '/v1/chat/completions', key = ownerKey) =>
    fetch(`${origin}${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
  const socketOperations = createResponsesWebSocketOperations(operations, gateway.openAIService);
  return { app, origin, send, upstream, lease, store, completions, socketOperations };
}

const conversation = {
  model: 'gemini-3-flash',
  instructions: 'Stay in character.',
  input: [
    { role: 'user', content: 'Who are you?' },
    { role: 'assistant', content: 'I am Character A.' },
    { role: 'user', content: 'What color is the window?' },
  ],
};

const structuredFormat = {
  type: 'json_schema',
  name: 'answer',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
};
const structuredTool = {
  type: 'function',
  name: 'lookup',
  parameters: { type: 'object', properties: {} },
};
const structuredRequest = {
  model: 'gemini-3-flash',
  text: { format: structuredFormat },
  tools: [structuredTool],
  store: false,
};

it('keeps visible Responses text when an upstream tool name is empty', async () => {
  const streamResponse = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: 'Visible answer', functionCall: { name: '', args: {} } }],
        },
        finishReason: 'STOP',
      },
    ],
  };
  const { send } = await fixture(undefined, streamResponse);
  const response = await send(
    { model: 'gemini-3-flash', input: 'Answer', stream: true },
    '/v1/responses',
  );
  const events = await response.text();
  expect(response.status).toBe(200);
  expect(events).toContain('"delta":"Visible answer"');
  expect(events).toContain('event: response.completed');
  expect(events).not.toContain('response.function_call_arguments');
});

it('uses the schema admitted by Responses WebSocket in the upstream generation request', async () => {
  const { socketOperations, upstream } = await fixture();
  const request = { ...structuredRequest, stream: true, input: 'Produce an answer' };
  await socketOperations.validateRequest?.(request, 'generate');

  const stream = await socketOperations.streamRequest(request, AbortSignal.timeout(5_000));
  const events = await lastValueFrom(stream.pipe(toArray()));

  expect(events.join('')).toContain('response.completed');
  expect(upstream.calls).toHaveLength(1);
  const body = upstream.calls[0]?.body;
  expect(body?.request.generationConfig).toMatchObject({
    temperature: 1,
    topP: 0.95,
    responseMimeType: 'application/json',
    responseSchema: structuredFormat.schema,
  });
  expect(body?.request).not.toHaveProperty('tools');
});

it.each([false, true])(
  'omits optional tools from the Responses JSON Schema send (stream=%s)',
  async (stream) => {
    const { send, upstream } = await fixture();
    const response = await send(
      {
        ...structuredRequest,
        stream,
        tool_choice: 'auto',
        input: [
          { role: 'user', content: 'Look up the answer' },
          { type: 'function_call', call_id: 'call_lookup', name: 'lookup', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call_lookup', output: '{"ok":true}' },
        ],
      },
      '/v1/responses',
    );
    expect(response.status, await response.text()).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    const request = upstream.calls[0]?.body.request;
    expect(request?.generationConfig).toMatchObject({
      temperature: 1,
      topP: 0.95,
      responseMimeType: 'application/json',
      responseSchema: structuredFormat.schema,
    });
    expect(request).not.toHaveProperty('tools');
    expect(request).not.toHaveProperty('toolConfig');
    expect(request).not.toHaveProperty('tool_config');
    expect(JSON.stringify(request?.contents)).toContain('functionResponse');
  },
);

it.each([
  'required',
  { type: 'function', name: 'lookup' },
  { type: 'function', function: { name: 'lookup' } },
])(
  'rejects a forced tool choice with Responses JSON Schema before dispatch',
  async (tool_choice) => {
    const { send, upstream } = await fixture();
    const response = await send(
      { ...structuredRequest, input: 'Look it up', tool_choice },
      '/v1/responses',
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        type: 'invalid_request_error',
        param: 'tool_choice',
        message: expect.stringContaining('json_schema'),
      },
    });
    expect(upstream.calls).toHaveLength(0);
  },
);

it('preserves tools for Responses JSON object mode', async () => {
  const { send, upstream } = await fixture();
  const response = await send(
    {
      ...structuredRequest,
      text: { format: { type: 'json_object' } },
      input: 'Look it up',
      tool_choice: { type: 'function', name: 'lookup' },
    },
    '/v1/responses',
  );
  expect(response.status, await response.text()).toBe(200);
  expect(upstream.calls[0]?.body.request).toMatchObject({
    tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] } },
  });
});

it('keeps structured Responses stream deltas byte-for-byte', async () => {
  const fenced = '```json\n{"ok":true}\n```';
  const { send } = await fixture(undefined, geminiTextResponse(fenced));
  const response = await send(
    {
      ...structuredRequest,
      stream: true,
      input: 'Answer',
    },
    '/v1/responses',
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(JSON.stringify({ delta: fenced }).slice(1, -1));
});

it.each([
  [structuredFormat, '```json\n{"ok":true}\n```', '{"ok":true}'],
  [{ type: 'json_object' }, '```\n{"ok":true}\n```', '{"ok":true}'],
  [{ type: 'text' }, '```json\n{"ok":true}\n```', '```json\n{"ok":true}\n```'],
  [structuredFormat, '```json\n{"ok":}\n```', '```json\n{"ok":}\n```'],
  [structuredFormat, 'Example:\n```json\n{"ok":true}\n```', 'Example:\n```json\n{"ok":true}\n```'],
])(
  'handles outer JSON fences for %j without changing other text',
  async (format, text, expected) => {
    const { send } = await fixture(geminiTextResponse(text));
    const response = await send(
      { model: 'gemini-3-flash', input: 'Answer', text: { format }, store: false },
      '/v1/responses',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      output: [{ type: 'message', content: [{ type: 'output_text', text: expected }] }],
    });
  },
);

it.each([false, true])(
  'preserves Responses roles and returns Chat output with stream=%s',
  async (stream) => {
    const { send, upstream } = await fixture();
    const response = await send({
      ...conversation,
      stream,
      stream_options: { include_usage: true },
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(upstream.calls[0]?.body.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'Who are you?' }] },
      { role: 'model', parts: [{ text: 'I am Character A.' }] },
      { role: 'user', parts: [{ text: 'What color is the window?' }] },
    ]);
    expect(upstream.calls[0]?.body.request.systemInstruction?.parts).toContainEqual({
      text: 'Stay in character.',
    });
    if (stream) {
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(body).toContain('chat.completion.chunk');
      expect(body).toContain('data: [DONE]');
      expect(body).not.toContain('response.completed');
      const events = body
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)));
      expect(
        events.some((event) => event.choices.length === 0 && event.usage?.total_tokens > 0),
      ).toBe(true);
    } else {
      expect(JSON.parse(body)).toMatchObject({
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: 'Character A is ready.' } }],
      });
    }
  },
);

it('accepts string input and gives existing Chat messages precedence', async () => {
  const { send, upstream } = await fixture();
  for (const payload of [
    { model: 'gemini-3-flash', input: 'Continue the task.' },
    {
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'Continue the task.' }],
      input: 7,
    },
  ]) {
    const response = await send(payload);
    expect(response.status, await response.text()).toBe(200);
  }
  expect(upstream.calls.map((call) => call.body.request.contents)).toEqual([
    [{ role: 'user', parts: [{ text: 'Continue the task.' }] }],
    [{ role: 'user', parts: [{ text: 'Continue the task.' }] }],
  ]);
});

it.each([false, true])(
  'restores owned previous Responses history with stream=%s and rejects another caller',
  async (stream) => {
    const { send, upstream } = await fixture();
    const seed = await send(
      {
        model: 'gemini-3-flash',
        input: 'Remember Character A.',
        instructions: 'Stay in character.',
      },
      '/v1/responses',
    );
    expect(seed.status).toBe(200);
    const id = resultId.parse(await seed.json()).id;
    for (const previous_response_id of [id, 'resp_missing']) {
      const denied = await send(
        { previous_response_id, input: 'Continue', stream },
        '/v1/chat/completions',
        'synthetic-chat-other',
      );
      expect(denied.status, await denied.text()).toBe(404);
    }
    expect(upstream.calls).toHaveLength(1);
    const continued = await send({ previous_response_id: id, input: 'What did you say?', stream });
    expect(continued.status, await continued.text()).toBe(200);
    expect(upstream.calls[1]?.body.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'Remember Character A.' }] },
      { role: 'model', parts: [{ text: 'Character A is ready.' }] },
      { role: 'user', parts: [{ text: 'What did you say?' }] },
    ]);
  },
);

it('restores a previous Responses tool call before accepting its result on Chat', async () => {
  const { send, upstream } = await fixture({
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_previous',
                name: 'read_file',
                args: { path: 'example.txt' },
              },
            },
          ],
        },
        finishReason: 'STOP',
      },
    ],
  });
  const seed = await send(
    {
      model: 'gemini-3-flash',
      input: 'Read example.txt.',
      tools: [
        {
          type: 'function',
          name: 'read_file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    },
    '/v1/responses',
  );
  const seedBody = await seed.json();
  expect(seed.status, JSON.stringify(seedBody)).toBe(200);
  const seedResponse = z
    .object({
      id: z.string(),
      output: z.array(
        z
          .object({
            type: z.string(),
            call_id: z.string().optional(),
          })
          .passthrough(),
      ),
    })
    .parse(seedBody);
  const callId = seedResponse.output.find((item) => item.type === 'function_call')?.call_id;
  expect(callId).toBeTruthy();
  const continued = await send({
    previous_response_id: seedResponse.id,
    input: [
      {
        type: 'function_call_output',
        call_id: callId,
        output: 'file contents',
      },
    ],
  });
  expect(continued.status, await continued.text()).toBe(200);
  const parts = upstream.calls[1]?.body.request.contents.flatMap((turn) => turn.parts);
  const call = parts?.find((part) => part.functionCall)?.functionCall;
  const result = parts?.find((part) => part.functionResponse)?.functionResponse;
  expect(call).toMatchObject({ name: 'read_file', args: { path: 'example.txt' } });
  expect(result).toMatchObject({ id: call?.id, name: 'read_file' });
});

it('preserves Responses tool calls, arguments and paired outputs', async () => {
  const { send, upstream } = await fixture();
  const response = await send({
    model: 'gemini-3-flash',
    tools: [
      {
        type: 'function',
        name: 'read_file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    input: [
      { role: 'user', content: 'Read example.txt.' },
      {
        type: 'function_call',
        call_id: 'call_read',
        name: 'read_file',
        arguments: '{"path":"example.txt"}',
      },
      { type: 'function_call_output', call_id: 'call_read', output: 'file contents' },
      { role: 'user', content: 'Summarize.' },
    ],
  });
  expect(response.status, await response.text()).toBe(200);
  const parts = upstream.calls[0]?.body.request.contents.flatMap((turn) => turn.parts);
  expect(parts).toContainEqual(
    expect.objectContaining({
      functionCall: expect.objectContaining({ name: 'read_file', args: { path: 'example.txt' } }),
    }),
  );
  expect(parts).toContainEqual(
    expect.objectContaining({ functionResponse: expect.objectContaining({ name: 'read_file' }) }),
  );
  const call = parts?.find((part) => part.functionCall)?.functionCall;
  const output = parts?.find((part) => part.functionResponse)?.functionResponse;
  expect(call?.id).toBe('call_read');
  expect(output?.id).toBe(call?.id);
});

it('keeps the current input image in the request sent upstream', async () => {
  const { send, upstream } = await fixture();
  const data = PIXEL_PNG.toString('base64');
  const response = await send({
    model: 'gemini-3-flash',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe this image.' },
          { type: 'input_image', image_url: `data:image/png;base64,${data}` },
        ],
      },
    ],
  });
  expect(response.status, await response.text()).toBe(200);
  expect(upstream.calls[0]?.body.request.contents[0]?.parts).toContainEqual({
    inlineData: { mimeType: 'image/png', data },
  });
});

it('retains the Chat rejection of streamed completion storage', async () => {
  const { send, lease, upstream } = await fixture();
  const response = await send({
    model: 'gemini-3-flash',
    input: 'Task',
    stream: true,
    store: true,
  });
  expect(response.status, await response.text()).toBe(400);
  expect(lease.getNextToken).not.toHaveBeenCalled();
  expect(upstream.calls).toEqual([]);
});

it('maps a Responses output limit once before Chat execution', async () => {
  const { send, upstream } = await fixture();
  const response = await send({ model: 'gemini-3-flash', input: 'Task', max_output_tokens: 256 });
  expect(response.status, await response.text()).toBe(200);
  expect(upstream.calls[0]?.body.request.generationConfig?.maxOutputTokens).toBe(256);
});

it('uses the existing Chat completion store when explicitly requested', async () => {
  const { send, origin, store } = await fixture();
  const created = await send({ model: 'gemini-3-flash', input: 'A stored answer', store: true });
  expect(created.status).toBe(200);
  const body = await created.json();
  const id = resultId.parse(body).id;
  const replayed = await fetch(`${origin}/v1/chat/completions/${id}`, {
    headers: { authorization: `Bearer ${ownerKey}` },
    signal: AbortSignal.timeout(5_000),
  });
  expect(replayed.status).toBe(200);
  expect(await replayed.json()).toEqual(body);
  expect(store.get(id)).toBeNull();
});

it.each([
  { input: 7 },
  { input: [{ role: 7, content: 'invalid' }] },
  { input: 'text', instructions: 7 },
  { input: 'text', model: 7 },
  { input: 'text', stream: 'yes' },
  { input: 'text', stream_options: { include_usage: 'yes' } },
  { input: 'text', max_output_tokens: 0 },
  { input: 'text', max_output_tokens: 256, max_tokens: 128 },
  { input: [{ type: 'function_call_output', call_id: 'missing', output: 'orphan' }] },
])('rejects malformed compatibility input before account execution %j', async (payload) => {
  const { send, lease, upstream } = await fixture();
  const response = await send({ model: 'gemini-3-flash', ...payload });
  expect(response.status, await response.text()).toBe(400);
  expect(lease.getNextToken).not.toHaveBeenCalled();
  expect(upstream.calls).toEqual([]);
});
