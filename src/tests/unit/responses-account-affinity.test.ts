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
import {
  resolveLineageAccountAffinity,
  resolveOpenAISessionScope,
} from '@/server/gateway/common/signature-session-scope';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: (token: string) => token === 'synthetic-tenant-b' },
}));
vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'responses-affinity-test/1.0',
}));

const previousConfig = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const apps: NestFastifyApplication[] = [];
const stores: OpenAIResponsesSessionStoreImpl[] = [];
const responseIdentity = z.object({ id: z.string().min(1) });
const request = { model: 'gemini-3-flash', input: 'Synthetic task' };
const headers = { authorization: 'Bearer synthetic-tenant-a', 'x-session-id': 'header' };

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
  const lease = createLease([createAccount('acc-1')]);
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
  class ResponsesAffinityModule {}
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: 'synthetic-tenant-a' });
  const app = await NestFactory.create<NestFastifyApplication>(
    ResponsesAffinityModule,
    new FastifyAdapter(),
    { logger: false },
  );
  apps.push(app);
  await app.init();
  return { ...result, app };
}

describe('Responses account affinity', () => {
  it('selects hints before storing lineage and preserves the winner when a continuation omits it', async () => {
    const { store, operations } = fixture();
    const root = await operations.prepareResponsesRequest(
      { ...request, session_id: 'body', metadata: { session_id: 'metadata' } },
      { headers, url: '/v1/responses?session_id=query' },
    );
    expect(root?.routingSessionId).toBe('header');
    if (!root) {
      throw new Error('Expected prepared root');
    }
    store.save(root.responseId, {
      identity: root.session.identity,
      historyOwner: root.session.historyOwner,
      inputItems: [
        { type: 'message', role: 'user', content: 'Synthetic task' },
        { type: 'message', role: 'assistant', content: 'Previous answer' },
      ],
      model: request.model,
      routingSessionId: root.routingSessionId,
    });
    const next = await operations.prepareResponsesRequest(
      { input: 'Continue', previous_response_id: root.responseId },
      { headers: { authorization: headers.authorization } },
    );
    expect(next?.routingSessionId).toBe('header');
    expect(next?.request.messages[0]).toEqual({ role: 'user', content: 'Synthetic task' });
    expect(
      (
        await operations.prepareResponsesRequest({
          ...request,
          session_id: 'x'.repeat(129),
          metadata: { session_id: 'metadata' },
        })
      )?.routingSessionId,
    ).toBe('metadata');
    expect(
      (
        await operations.prepareResponsesRequest(
          { ...request, session_id: 'body' },
          { headers: {}, url: '/?session_id=query' },
        )
      )?.routingSessionId,
    ).toBe('query');
    expect(
      (
        await operations.prepareResponsesRequest({
          ...request,
          metadata: { user_id: 'legacy-user' },
        })
      )?.routingSessionId,
    ).toBe('legacy-user');
  });

  it('uses the same explicit affinity as Chat, while separating proxy credentials on HTTP', async () => {
    const { app, lease, upstream } = await httpSurface();
    const root = await app.inject({
      method: 'POST',
      url: '/v1/responses?session_id=query',
      headers,
      payload: { ...request, session_id: 'body' },
    });
    expect(root.statusCode).toBe(200);
    const rootId = responseIdentity.parse(root.json()).id;
    const expected = resolveOpenAISessionScope(
      { model: request.model, messages: [{ role: 'user', content: request.input }] },
      headers,
    ).affinityKey;
    expect(lease.getNextToken.mock.calls[0][0]).toEqual(
      expect.objectContaining({ sessionKey: expected }),
    );
    const continued = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { authorization: headers.authorization },
      payload: { input: 'Continue', previous_response_id: rootId },
    });
    expect(continued.statusCode).toBe(200);
    expect(responseIdentity.parse(continued.json()).id).not.toBe(rootId);
    expect(upstream.calls[1]?.options?.upstreamSession).toEqual(
      upstream.calls[0]?.options?.upstreamSession,
    );
    expect(lease.getNextToken.mock.calls[1][0]).toEqual(
      expect.objectContaining({ sessionKey: expected }),
    );
    const otherHeaders = { ...headers, authorization: 'Bearer synthetic-tenant-b' };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/responses',
          headers: otherHeaders,
          payload: request,
        })
      ).statusCode,
    ).toBe(200);
    expect(lease.getNextToken.mock.calls[2][0]).toEqual(
      expect.objectContaining({
        sessionKey: resolveLineageAccountAffinity('header', otherHeaders),
      }),
    );
    expect(resolveLineageAccountAffinity('header', otherHeaders)).not.toBe(expected);
  });

  it('retains content affinity for hint-free continuation without routing by generated response IDs', async () => {
    const { app, lease } = await httpSurface();
    const noHint = { authorization: headers.authorization };
    const root = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: noHint,
      payload: request,
    });
    expect(root.statusCode).toBe(200);
    const id = responseIdentity.parse(root.json()).id;
    const first = lease.getNextToken.mock.calls[0][0];
    const next = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: noHint,
      payload: { input: 'Continue', previous_response_id: id },
    });
    expect(next.statusCode).toBe(200);
    expect(lease.getNextToken.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        sessionKey: resolveOpenAISessionScope(
          { model: request.model, messages: [{ role: 'user', content: request.input }] },
          noHint,
        ).affinityKey,
      }),
    );
    expect(first).toEqual(
      expect.objectContaining({
        sessionKey: resolveOpenAISessionScope(
          { model: request.model, messages: [{ role: 'user', content: request.input }] },
          noHint,
        ).affinityKey,
      }),
    );
  });

  it('does not interpret invalid legacy lineage IDs as unbounded client hints', () => {
    expect(resolveLineageAccountAffinity('x'.repeat(129), headers)).toBeUndefined();
    expect(resolveLineageAccountAffinity('bad\nvalue', headers)).toBeUndefined();
    expect(resolveLineageAccountAffinity('same', { 'x-api-key': 'synthetic-tenant-a' })).toBe(
      resolveLineageAccountAffinity('same', { authorization: headers.authorization }),
    );
    expect(resolveLineageAccountAffinity('same')).not.toBe(
      resolveLineageAccountAffinity('same', { 'x-api-key': 'anonymous' }),
    );
  });

  it('carries actual upgrade identity through admission and execution over a local WebSocket', async () => {
    const { operations, gateway, lease } = fixture();
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
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses?session_id=query`, {
      headers,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('WebSocket completion deadline exceeded')),
          5000,
        );
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
        const closed = () => fail(new Error('WebSocket closed before completion'));
        const receive = (data: Buffer) => {
          const event = z.object({ type: z.string() }).parse(JSON.parse(data.toString()));
          if (event.type === 'error') {
            fail(new Error('WebSocket returned an error'));
          }
          if (event.type === 'response.completed') {
            cleanup();
            resolve();
          }
        };
        socket.once('open', () =>
          socket.send(JSON.stringify({ type: 'response.create', ...request, session_id: 'body' })),
        );
        socket.on('message', receive);
        socket.once('error', fail);
        socket.once('close', closed);
      });
      expect(lease.getNextToken.mock.calls[0][0]).toEqual(
        expect.objectContaining({ sessionKey: resolveLineageAccountAffinity('header', headers) }),
      );
    } finally {
      socket.terminate();
      detach();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
