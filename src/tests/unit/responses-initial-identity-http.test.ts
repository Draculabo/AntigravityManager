import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIResponsesController } from '@/server/gateway/modules/openai/responses/openai-responses.controller';
import { OpenAIResponsesSessionStoreImpl } from '@/server/gateway/modules/openai/responses/openai-responses-session.store';
import { createResponsesWebSocketOperations } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.operations';
import { attachOpenAIResponsesWebSocketServer } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.server';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'responses-identity-test/1.0',
}));
const previousConfig = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const apps: NestFastifyApplication[] = [];
const stores: OpenAIResponsesSessionStoreImpl[] = [];
const headers = { authorization: 'Bearer synthetic-identity-owner' };
const image =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2Z8AAAAASUVORK5CYII=';
const input = [
  {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'Describe' },
      { type: 'input_image', image_url: `data:image/png;base64,${image}` },
    ],
  },
];
const responseSchema = z.object({ id: z.string() });
const eventSchema = z.object({ type: z.string(), response: responseSchema.optional() });
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const store of stores.splice(0)) {
    store.clear();
  }
  setServerConfig(previousConfig);
});
function fixture() {
  const store = new OpenAIResponsesSessionStoreImpl();
  stores.push(store);
  const lease = createLease([createAccount('identity-account')]);
  const upstream = createUpstream({
    generate: geminiTextResponse('ok'),
    streamFrames: [geminiStreamFrame(geminiTextResponse('ok'))],
  });
  const gateway = createGateway(upstream, lease);
  const operations = new OpenAIOperations(gateway.openAIService, undefined, undefined, store);
  return { store, lease, upstream, gateway, operations };
}
async function httpSurface() {
  const result = fixture();
  @Module({
    controllers: [OpenAIResponsesController],
    providers: [ProxyGuard, { provide: OpenAIOperations, useValue: result.operations }],
  })
  class IdentityModule {}
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: 'synthetic-identity-owner' });
  const app = await NestFactory.create<NestFastifyApplication>(
    IdentityModule,
    new FastifyAdapter(),
    { logger: false },
  );
  apps.push(app);
  await app.init();
  return { ...result, app };
}
function completedId(body: string, stream: boolean): string {
  if (!stream) {
    return responseSchema.parse(JSON.parse(body)).id;
  }
  const events = body
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => eventSchema.parse(JSON.parse(line.slice(6))));
  const response = events.find((event) => event.type === 'response.completed')?.response;
  if (!response) {
    throw new Error('Missing completed SSE response');
  }
  return response.id;
}
function leaseKeys(lease: ReturnType<typeof createLease>): string[] {
  return lease.getNextToken.mock.calls.map(
    ([options]) => z.object({ sessionKey: z.string().min(1) }).parse(options).sessionKey,
  );
}

it('recovers a stored WebSocket response on a new connection without resending its model', async () => {
  const { operations, gateway, store, upstream } = fixture();
  const server = createServer();
  const detach = attachOpenAIResponsesWebSocketServer(server, {
    ...createResponsesWebSocketOperations(operations, gateway.openAIService),
    isAuthorized: () => true,
  });
  const sockets: WebSocket[] = [];
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a loopback address');
    }
    const connect = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`, { headers });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      return socket;
    };
    const first = await connect();
    const id = await socketRequest(first, {
      model: 'gemini-3-flash',
      store: true,
      input: [{ type: 'message', role: 'user', content: 'Remember the synthetic token CEDAR.' }],
    });
    expect(store.get(id)).not.toBeNull();
    const closed = new Promise<void>((resolve) => first.once('close', () => resolve()));
    first.close();
    await closed;
    const next = await connect();
    const nextId = await socketRequest(next, {
      previous_response_id: id,
      store: false,
      input: [{ type: 'message', role: 'user', content: 'Recall the token.' }],
    });
    expect(nextId).not.toBe(id);
    expect(store.get(nextId)).toBeNull();
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls[1]?.body.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'Remember the synthetic token CEDAR.' }] },
      { role: 'model', parts: [{ text: 'ok' }] },
      { role: 'user', parts: [{ text: 'Recall the token.' }] },
    ]);
    await socketRequest(next, {
      store: false,
      input: [{ type: 'message', role: 'user', content: 'Recall it once again.' }],
    });
    expect(upstream.calls).toHaveLength(3);
    expect(upstream.calls[2]?.body.request.contents).toEqual([
      { role: 'user', parts: [{ text: 'Remember the synthetic token CEDAR.' }] },
      { role: 'model', parts: [{ text: 'ok' }] },
      { role: 'user', parts: [{ text: 'Recall the token.' }] },
      { role: 'model', parts: [{ text: 'ok' }] },
      { role: 'user', parts: [{ text: 'Recall it once again.' }] },
    ]);
  } finally {
    await Promise.all(
      sockets.map(async (socket) => {
        if (socket.readyState !== WebSocket.CLOSED) {
          const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
          socket.terminate();
          await closed;
        }
      }),
    );
    detach();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function socketRequest(socket: WebSocket, request: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', receive);
      socket.off('error', fail);
      socket.off('close', closed);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () => fail(new Error('Socket closed before response.completed'));
    const receive = (data: Buffer) => {
      try {
        const event = eventSchema.parse(JSON.parse(data.toString()));
        if (event.type === 'error') {
          fail(new Error('Socket error event'));
        }
        if (event.type === 'response.completed' && event.response) {
          cleanup();
          resolve(event.response.id);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const timer = setTimeout(() => fail(new Error('Socket completion deadline exceeded')), 5000);
    socket.on('message', receive);
    socket.once('error', fail);
    socket.once('close', closed);
    socket.send(JSON.stringify({ type: 'response.create', ...request }));
  });
}
describe('Responses identity through controlled gateway transports', () => {
  it.each([false, true])(
    'retains image identity and affinity across HTTP continuation, stream=%s',
    async (stream) => {
      const { app, store, lease, upstream } = await httpSurface();
      const first = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers,
        payload: { model: 'gemini-3-flash', input, stream },
      });
      expect(first.statusCode).toBe(200);
      const id = completedId(first.body, stream);
      const identity = store.get(id)?.identity;
      expect(identity?.origin).toBe('content');
      expect(JSON.stringify(identity)).not.toContain(image);
      expect(JSON.stringify(store.get(id)?.inputItems)).toContain(image);
      const next = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers,
        payload: { previous_response_id: id, input: 'Continue', stream },
      });
      expect(next.statusCode).toBe(200);
      const child = completedId(next.body, stream);
      expect(child).not.toBe(id);
      expect(store.get(child)?.identity).toEqual(identity);
      expect(leaseKeys(lease)).toEqual([leaseKeys(lease)[0], leaseKeys(lease)[0]]);
      expect(upstream.calls).toHaveLength(2);
      expect(upstream.calls[0].options?.upstreamSession).toBeDefined();
      expect(upstream.calls[1].options?.upstreamSession).toEqual(
        upstream.calls[0].options?.upstreamSession,
      );
      expect(JSON.stringify(upstream.calls[1].body)).toContain(image);
    },
  );
  it('rejects old cursors and invalid media before leasing, regardless of body admission flags', async () => {
    const { app, upstream, lease } = await httpSurface();
    const old = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: { previous_response_id: 'resp_old_file_only', input: 'Continue' },
    });
    expect(old.statusCode).toBe(404);
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: {
        mediaAdmitted: true,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: 'data:image/png;base64,not-valid' }],
          },
        ],
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(upstream.calls).toEqual([]);
    expect(lease.getNextToken).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'preserves image identity across WebSocket deltas and full transcripts, prewarm=%s',
    async (prewarm) => {
      const { operations, gateway, lease, upstream } = fixture();
      const server = createServer();
      const detach = attachOpenAIResponsesWebSocketServer(server, {
        ...createResponsesWebSocketOperations(operations, gateway.openAIService),
        isAuthorized: () => true,
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected loopback address');
      }
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`, { headers });
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('open', resolve);
          socket.once('error', reject);
        });
        const warmed = prewarm
          ? await socketRequest(socket, { model: 'gemini-3-flash', input, generate: false })
          : undefined;
        expect(upstream.calls).toEqual([]);
        const first = await socketRequest(
          socket,
          warmed ? { previous_response_id: warmed, input: [] } : { model: 'gemini-3-flash', input },
        );
        const second = await socketRequest(socket, {
          previous_response_id: first,
          input: [{ type: 'message', role: 'user', content: 'Continue' }],
        });
        const third = await socketRequest(socket, {
          model: 'gemini-3-flash',
          input: [
            ...input,
            { type: 'message', role: 'assistant', content: 'ok' },
            { type: 'message', role: 'user', content: 'Continue' },
          ],
        });
        expect(new Set([first, second, third]).size).toBe(3);
        expect(upstream.calls).toHaveLength(3);
        expect(leaseKeys(lease)).toEqual(Array.from({ length: 3 }, () => leaseKeys(lease)[0]));
        expect(upstream.calls[0].options?.upstreamSession).toBeDefined();
        expect(upstream.calls[1].options?.upstreamSession).toEqual(
          upstream.calls[0].options?.upstreamSession,
        );
        expect(upstream.calls[2].options?.upstreamSession).toEqual(
          upstream.calls[0].options?.upstreamSession,
        );
        expect(JSON.stringify(upstream.calls[1].body)).toContain(image);
      } finally {
        socket.terminate();
        detach();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
