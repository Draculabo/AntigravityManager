import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { setServerConfig } from '@/server/server-config';
import WebSocket from 'ws';
import { of } from 'rxjs';

import { OpenAIResponsesWebSocketProtocol } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.protocol';
import { attachOpenAIResponsesWebSocketServer } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.server';
import { createResponsesWebSocketOperations } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.operations';
import { buildResponsesChatRequest } from '@/server/gateway/modules/openai/responses/openai-responses-request';
import { SchemaInputError } from '@/modules/proxy-gateway/antigravity/schema/SchemaConversion';
import { ToolConfigurationError } from '@/modules/proxy-gateway/antigravity/ToolChoiceCompat';

describe('OpenAIResponsesWebSocketProtocol', () => {
  it('times out socket preparation without publishing the late transcript', async () => {
    const server = createServer();
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const streamRequest = vi.fn(async () => of());
    const validateRequest = vi.fn().mockReturnValueOnce(blocked);
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      streamRequest,
      validateRequest,
    });
    setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, generation_timeout: 1 });
    let socket: WebSocket | undefined;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected loopback WebSocket listener');
      }
      socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
      await once(socket, 'open');
      const timeout = once(socket, 'message', { signal: AbortSignal.timeout(4000) });
      socket.send(
        JSON.stringify({ type: 'response.create', model: 'fixture', input: 'controlled' }),
      );
      const [expired] = await timeout;
      expect(JSON.parse(String(expired))).toMatchObject({
        type: 'error',
        error: { message: 'Generation request deadline exceeded.' },
      });
      release();
      const append = once(socket, 'message', { signal: AbortSignal.timeout(4000) });
      socket.send(JSON.stringify({ type: 'response.append', input: 'late follow-up' }));
      const [rejected] = await append;
      expect(JSON.parse(String(rejected))).toMatchObject({
        type: 'error',
        error: { message: expect.stringContaining('before response.create') },
      });
      expect(validateRequest).toHaveBeenCalledOnce();
      expect(streamRequest).not.toHaveBeenCalled();
    } finally {
      release();
      socket?.terminate();
      detach();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      setServerConfig(DEFAULT_APP_CONFIG.proxy);
    }
  }, 12_000);
  it('retains admitted socket configuration after a rejected append', async () => {
    const protocol = new OpenAIResponsesWebSocketProtocol((request) => {
      if (request.model === 'invalid') {
        throw new SchemaInputError('invalid-root');
      }
    });
    await protocol.accept({ type: 'response.create', model: 'valid', input: [] });
    await expect(
      protocol.accept({ type: 'response.append', model: 'invalid', input: [] }),
    ).rejects.toThrow(SchemaInputError);
    expect(await protocol.accept({ type: 'response.append', input: [] })).toEqual({
      kind: 'request',
      request: { model: 'valid', input: [], stream: true },
    });
  });
  it('does not commit a prewarm whose schema preflight fails', async () => {
    const protocol = new OpenAIResponsesWebSocketProtocol((request) => {
      if (request.tools) {
        throw new SchemaInputError('invalid-root');
      }
    });
    await expect(
      protocol.accept({ type: 'response.create', generate: false, model: 'fixture', tools: [{}] }),
    ).rejects.toThrow(SchemaInputError);
    expect(protocol.getPreviousResponseId()).toBe('');
    await expect(protocol.accept({ type: 'response.append', input: [] })).rejects.toThrow(
      'before response.create',
    );
    expect(
      (await protocol.accept({ type: 'response.create', generate: false, model: 'fixture' })).kind,
    ).toBe('local');
  });

  it('does not commit a prewarm with an unsatisfiable function choice', async () => {
    const operations = createResponsesWebSocketOperations(
      {
        prepareResponsesRequest: vi.fn(async () => ({
          request: {
            model: 'fixture',
            messages: [{ role: 'user', content: 'Call the function.' }],
            tool_choice: 'required',
            tools: [],
          },
        })) as never,
        cacheResponsesStream: (stream) => stream,
      },
      { handleChatCompletions: vi.fn() } as never,
    );
    const protocol = new OpenAIResponsesWebSocketProtocol(async (request, mode) => {
      await operations.validateRequest?.(request, mode);
    });

    await expect(
      protocol.accept({
        type: 'response.create',
        generate: false,
        model: 'fixture',
      }),
    ).rejects.toThrow(ToolConfigurationError);
    expect(protocol.getPreviousResponseId()).toBe('');
    await expect(protocol.accept({ type: 'response.append', input: [] })).rejects.toThrow(
      'before response.create',
    );
  });

  it('rejects forced tools with json_schema before publishing a prewarm', async () => {
    const operations = createResponsesWebSocketOperations(
      {
        prepareResponsesRequest: vi.fn(async () => ({
          request: {
            model: 'fixture',
            messages: [{ role: 'user', content: 'Call the function.' }],
            tool_choice: 'required',
            tools: [{ type: 'function', function: { name: 'lookup' } }],
            response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } },
          },
        })) as never,
        cacheResponsesStream: (stream) => stream,
      },
      { handleChatCompletions: vi.fn() } as never,
    );
    const protocol = new OpenAIResponsesWebSocketProtocol(async (request, mode) => {
      await operations.validateRequest?.(request, mode);
    });

    await expect(
      protocol.accept({ type: 'response.create', generate: false, model: 'fixture' }),
    ).rejects.toMatchObject({ reason: 'required-with-json-schema' });
    await expect(protocol.accept({ type: 'response.append', input: [] })).rejects.toThrow(
      'before response.create',
    );
  });

  it('sends a local Schema input error over WebSocket before response.created', async () => {
    const server = createServer();
    let called = false;
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      validateRequest: () => {
        throw new SchemaInputError('invalid-root');
      },
      streamRequest: async () => {
        called = true;
        return of();
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
    try {
      const event = await new Promise<unknown>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('open', () =>
          socket.send(
            JSON.stringify({ type: 'response.create', generate: false, model: 'fixture' }),
          ),
        );
        socket.once('message', (data) => resolve(JSON.parse(data.toString())));
      });
      expect(event).toEqual({
        type: 'error',
        error: {
          message: 'Invalid request schema: invalid-root',
          type: 'invalid_request_error',
          code: 'invalid_schema',
          param: null,
        },
      });
      expect(called).toBe(false);
    } finally {
      socket.terminate();
      detach();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends a tool-choice error over WebSocket before response.created', async () => {
    const server = createServer();
    let called = false;
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      validateRequest: () => {
        throw new ToolConfigurationError('unknown-function-name');
      },
      streamRequest: async () => {
        called = true;
        return of();
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
    try {
      const event = await new Promise<unknown>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('open', () =>
          socket.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] })),
        );
        socket.once('message', (data) => resolve(JSON.parse(data.toString())));
      });
      expect(event).toEqual({
        type: 'error',
        error: {
          message: expect.stringContaining('not declared'),
          type: 'invalid_request_error',
          code: 'invalid_tool_choice',
          param: 'tool_choice',
        },
      });
      expect(called).toBe(false);
    } finally {
      socket.terminate();
      detach();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('handles the initial generate=false request locally and reuses it for the next append', async () => {
    const protocol = new OpenAIResponsesWebSocketProtocol();
    const prewarm = await protocol.accept({
      type: 'response.create',
      generate: false,
      model: 'gpt-5-codex',
      instructions: 'Work carefully',
      tools: [{ type: 'function', function: { name: 'shell', parameters: {} } }],
    });

    expect(prewarm.kind).toBe('local');
    if (prewarm.kind !== 'local') {
      throw new Error('Expected a local prewarm response');
    }
    expect(prewarm.events.map((event) => event.type)).toEqual([
      'response.created',
      'response.completed',
    ]);
    expect(prewarm.events[0]).toMatchObject({ sequence_number: 0 });
    expect(prewarm.events[1]).toMatchObject({
      sequence_number: 1,
      response: {
        model: 'gpt-5-codex',
        output: [],
        status: 'completed',
      },
    });

    const next = await protocol.accept({
      type: 'response.append',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }],
    });
    expect(next).toMatchObject({
      kind: 'request',
      request: {
        model: 'gpt-5-codex',
        instructions: 'Work carefully',
        stream: true,
      },
    });
  });

  it('does not replace the transcript for an ignored empty-type assistant item', async () => {
    const protocol = new OpenAIResponsesWebSocketProtocol();
    const previousInput = [{ type: 'message', role: 'user', content: 'Keep this history.' }];
    await protocol.accept({
      type: 'response.create',
      model: 'gpt-5-codex',
      instructions: 'Keep these instructions.',
      input: previousInput,
    });
    const input = [
      { type: '', role: 'assistant', content: 'Do not replace history.' },
      { role: 'user', content: { legacy: 'Do not serialize.' } },
      { role: 'user', content: 'Continue.' },
    ];
    const before = structuredClone(input);

    const appended = await protocol.accept({ type: 'response.append', input });

    expect(appended).toEqual({
      kind: 'request',
      request: {
        model: 'gpt-5-codex',
        instructions: 'Keep these instructions.',
        input: [...previousInput, ...input],
        stream: true,
      },
    });
    if (appended.kind !== 'request') {
      throw new Error('Expected a generation request');
    }
    expect(buildResponsesChatRequest({ input: appended.request.input }).messages).toEqual([
      { role: 'user', content: 'Keep this history.' },
      { role: 'user', content: '' },
      { role: 'user', content: 'Continue.' },
    ]);
    expect(input).toEqual(before);
  });

  it('replaces the transcript for a role-bearing assistant message without type', async () => {
    const protocol = new OpenAIResponsesWebSocketProtocol();
    await protocol.accept({
      type: 'response.create',
      model: 'gpt-5-codex',
      input: [{ type: 'message', role: 'user', content: 'Old request' }],
    });

    const replacement = await protocol.accept({
      type: 'response.append',
      input: [{ role: 'assistant', content: 'Replacement transcript' }],
    });

    expect(replacement).toMatchObject({
      kind: 'request',
      request: {
        input: [{ role: 'assistant', content: 'Replacement transcript' }],
      },
    });
  });
});

describe('OpenAI Responses WebSocket transport', () => {
  it('serves prewarm events over GET /v1/responses without calling upstream', async () => {
    const server = createServer();
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      streamRequest: async () => {
        throw new Error('Prewarm must not call upstream');
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP server address');
    }

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
    const events = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const received: Array<Record<string, unknown>> = [];
      socket.once('error', reject);
      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            type: 'response.create',
            generate: false,
            model: 'gpt-5-codex',
          }),
        );
      });
      socket.on('message', (data) => {
        received.push(JSON.parse(data.toString()) as Record<string, unknown>);
        if (received.length === 2) {
          resolve(received);
        }
      });
    });

    expect(events.map((event) => event.type)).toEqual(['response.created', 'response.completed']);

    socket.close();
    detach();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('preserves Responses SSE events split across upstream chunks', async () => {
    const server = createServer();
    const response = {
      id: 'resp_split',
      object: 'response',
      status: 'completed',
      output: [],
    };
    const serialized = JSON.stringify({ type: 'response.completed', response });
    const detach = attachOpenAIResponsesWebSocketServer(server, {
      isAuthorized: () => true,
      streamRequest: async () =>
        of(`data: ${serialized.slice(0, 30)}`, `${serialized.slice(30)}\n\n`),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP server address');
    }

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
    const event = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            type: 'response.create',
            model: 'gpt-5-codex',
            input: [],
          }),
        );
      });
      socket.once('message', (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });

    expect(event).toEqual({ type: 'response.completed', response });

    socket.close();
    detach();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
});
