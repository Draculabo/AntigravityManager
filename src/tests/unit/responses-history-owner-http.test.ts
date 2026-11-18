import { responsesIdentityFixture } from './responses-identity.fixture';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIResponsesController } from '@/server/gateway/modules/openai/responses/openai-responses.controller';
import { OpenAIResponsesStoreController } from '@/server/gateway/modules/openai/responses/openai-responses-store.controller';
import { OpenAIResponsesSessionService } from '@/server/gateway/modules/openai/responses/openai-responses-session.service';
import { createResponsesWebSocketOperations } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.operations';
import { attachOpenAIResponsesWebSocketServer } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.server';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: (token: string) => token === 'synthetic-owner-b' },
}));
vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'responses-owner-test/1.0',
}));

const a = { authorization: 'Bearer synthetic-owner-a' };
const b = { 'x-api-key': 'synthetic-owner-b' };
const request = { model: 'gemini-3-flash', input: 'Private synthetic task' };
const identity = z.object({ id: z.string().min(1) });
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const apps: NestFastifyApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  setServerConfig(previous);
});

async function fixture() {
  const store = new OpenAIResponsesSessionService({});
  const lease = createLease([createAccount('owner-account')]);
  const upstream = createUpstream({
    generate: geminiTextResponse('Private answer'),
    streamFrames: [geminiStreamFrame(geminiTextResponse('Private answer'))],
  });
  const gateway = createGateway(upstream, lease);
  const operations = new OpenAIOperations(gateway.openAIService, undefined, undefined, store);
  @Module({
    controllers: [OpenAIResponsesController, OpenAIResponsesStoreController],
    providers: [
      ProxyGuard,
      { provide: OpenAIOperations, useValue: operations },
      { provide: OpenAIResponsesSessionService, useValue: store },
    ],
  })
  class OwnerTestModule {}
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: 'synthetic-owner-a' });
  const app = await NestFactory.create<NestFastifyApplication>(
    OwnerTestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  apps.push(app);
  await app.init();
  return { app, store, lease, upstream, operations, gateway };
}
function notFound(id: string, param = 'id') {
  return {
    error: {
      code: param === 'id' ? 'response_not_found' : 'previous_response_not_found',
      message: `${param === 'id' ? 'Response' : 'Previous response'} with id '${id}' not found.`,
      param,
      type: 'invalid_request_error',
    },
  };
}

describe('Responses history ownership at HTTP and WebSocket boundaries', () => {
  it('allows equivalent credential headers, rejects another accepted caller, and preserves the owner record', async () => {
    const { app, lease } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: a,
      payload: request,
    });
    expect(created.statusCode).toBe(200);
    const id = identity.parse(created.json()).id;
    for (const method of ['GET', 'DELETE'] as const) {
      const denied = await app.inject({ method, url: `/v1/responses/${id}`, headers: b });
      expect({ status: denied.statusCode, body: denied.json() }).toEqual({
        status: 404,
        body: notFound(id),
      });
    }
    for (const store of [undefined, false, true]) {
      for (const stream of [false, true]) {
        const denied = await app.inject({
          method: 'POST',
          url: '/v1/responses',
          headers: b,
          payload: { input: 'Continue', previous_response_id: id, store, stream },
        });
        expect({ status: denied.statusCode, body: denied.json() }).toEqual({
          status: 404,
          body: notFound(id, 'previous_response_id'),
        });
      }
    }
    expect(lease.getNextToken).toHaveBeenCalledTimes(1);
    const ownHeaders = { 'x-api-key': 'synthetic-owner-a' };
    const read = await app.inject({ url: `/v1/responses/${id}`, headers: ownHeaders });
    expect({ status: read.statusCode, body: read.json() }).toEqual({
      status: 200,
      body: created.json(),
    });
    const child = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: ownHeaders,
      payload: { input: 'Continue', previous_response_id: id },
    });
    expect(child.statusCode).toBe(200);
    const childId = identity.parse(child.json()).id;
    expect((await app.inject({ url: `/v1/responses/${childId}`, headers: b })).statusCode).toBe(
      404,
    );
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/responses/${id}`,
      headers: ownHeaders,
    });
    expect({ status: deleted.statusCode, body: deleted.json() }).toEqual({
      status: 200,
      body: { id, object: 'response', deleted: true },
    });
  });

  it('does not guess an owner for old records or reveal whether a rejected cursor exists', async () => {
    const { app, store, lease } = await fixture();
    store.save('resp_unknown', {
      identity: responsesIdentityFixture,
      model: request.model,
      inputItems: [{ role: 'user', content: 'Old private input' }],
      response: { id: 'resp_unknown', output: [] },
    });
    for (const headers of [a, b]) {
      for (const id of ['resp_unknown', 'resp_missing']) {
        for (const method of ['GET', 'DELETE'] as const) {
          const denied = await app.inject({ method, url: `/v1/responses/${id}`, headers });
          expect({ status: denied.statusCode, body: denied.json() }).toEqual({
            status: 404,
            body: notFound(id),
          });
        }
        const denied = await app.inject({
          method: 'POST',
          url: '/v1/responses',
          headers,
          payload: { ...request, previous_response_id: id },
        });
        expect({ status: denied.statusCode, body: denied.json() }).toEqual({
          status: 404,
          body: notFound(id, 'previous_response_id'),
        });
      }
    }
    expect(lease.getNextToken).not.toHaveBeenCalled();
    expect(store.getHistoryOwner('resp_unknown')).toBe('unknown');
    expect(store.get('resp_unknown')?.inputItems).toEqual([
      { role: 'user', content: 'Old private input' },
    ]);
  });

  it('keeps anonymous mode separate from presented credentials without requiring encryption', async () => {
    const { app } = await fixture();
    setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: '' });
    const created = await app.inject({ method: 'POST', url: '/v1/responses', payload: request });
    const id = identity.parse(created.json()).id;
    expect(created.statusCode).toBe(200);
    expect((await app.inject({ url: `/v1/responses/${id}` })).statusCode).toBe(200);
    for (const headers of [a, b, { 'x-api-key': 'anonymous' }]) {
      expect((await app.inject({ url: `/v1/responses/${id}`, headers })).statusCode).toBe(404);
    }
  });

  it('publishes caller-owned history only after a streaming response completes', async () => {
    const { app, store } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: a,
      payload: { ...request, stream: true },
    });
    expect(created.statusCode).toBe(200);
    const event = created.body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .filter((line) => line !== '[DONE]')
      .map((line) => JSON.parse(line))
      .find((value) => value.type === 'response.completed');
    const id = identity.parse(event.response).id;
    expect(store.getHistoryOwner(id)).not.toBe('unknown');
    expect((await app.inject({ url: `/v1/responses/${id}`, headers: a })).statusCode).toBe(200);
    expect((await app.inject({ url: `/v1/responses/${id}`, headers: b })).statusCode).toBe(404);
  });

  it.each([true, false])(
    'rejects a foreign cursor at real WebSocket admission with explicit model=%s',
    async (includeModel) => {
      const { app, operations, gateway, lease } = await fixture();
      const created = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: a,
        payload: request,
      });
      const id = identity.parse(created.json()).id;
      const server = createServer();
      const detach = attachOpenAIResponsesWebSocketServer(server, {
        ...createResponsesWebSocketOperations(operations, gateway.openAIService),
        isAuthorized: () => true,
      });
      let socket: WebSocket | undefined;
      try {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Expected loopback listener');
        }
        socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`, { headers: b });
        const connected = socket;
        await new Promise<void>((resolve, reject) => {
          connected.once('open', resolve);
          connected.once('error', reject);
        });
        const rejected = new Promise<unknown>((resolve, reject) => {
          connected.once('message', (data) => resolve(JSON.parse(data.toString())));
          connected.once('error', reject);
        });
        connected.send(
          JSON.stringify({
            type: 'response.create',
            ...(includeModel ? request : { input: request.input }),
            previous_response_id: id,
          }),
        );
        expect(await rejected).toEqual({
          type: 'error',
          error: {
            message: 'Unknown or expired previous_response_id',
            type: 'invalid_request_error',
          },
        });
        expect(lease.getNextToken).toHaveBeenCalledTimes(1);
      } finally {
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          const closed = new Promise<void>((resolve) => socket!.once('close', () => resolve()));
          socket.terminate();
          await closed;
        }
        detach();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
