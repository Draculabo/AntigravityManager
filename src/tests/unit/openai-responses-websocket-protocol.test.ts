import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { of } from 'rxjs';

import { OpenAIResponsesWebSocketProtocol } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-websocket-protocol';
import { attachOpenAIResponsesWebSocketServer } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-websocket.server';

describe('OpenAIResponsesWebSocketProtocol', () => {
  it('handles the initial generate=false request locally and reuses it for the next append', () => {
    const protocol = new OpenAIResponsesWebSocketProtocol();
    const prewarm = protocol.accept({
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

    const next = protocol.accept({
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
