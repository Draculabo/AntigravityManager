import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { OpenAIResponsesSessionService } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.service';
import { OpenAIResponsesStoreController } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-store.controller';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));

const headers = { authorization: 'Bearer synthetic-response-key' };
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const apps: NestFastifyApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  setServerConfig(previous);
});

// Generation is unchanged; read/delete requests exercise the production HTTP pipeline.
function createReplyMock() {
  const reply: Record<string, unknown> = {};
  reply.status = vi.fn(() => reply);
  reply.header = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply;
}

function chatResponse(id: string, content: string) {
  return {
    id,
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [{ index: 0, finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function responseNotFound(id: string) {
  return {
    error: {
      code: 'response_not_found',
      message: `Response with id '${id}' not found.`,
      param: 'id',
      type: 'invalid_request_error',
    },
  };
}

async function createSurface(...answers: unknown[]) {
  const responsesSessions = new OpenAIResponsesSessionService({});
  const handleChatCompletions = vi.fn();
  for (const answer of answers) {
    handleChatCompletions.mockResolvedValueOnce(answer);
  }
  @Module({
    controllers: [OpenAIResponsesStoreController],
    providers: [
      ProxyGuard,
      { provide: OpenAIResponsesSessionService, useValue: responsesSessions },
    ],
  })
  class ResponsesHttpTestModule {}
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: 'synthetic-response-key' });
  const store = await NestFactory.create<NestFastifyApplication>(
    ResponsesHttpTestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  apps.push(store);
  await store.init();
  return {
    chat: new OpenAIOperations(
      { handleChatCompletions } as never,
      undefined,
      undefined,
      responsesSessions,
    ),
    store,
    responsesSessions,
  };
}

describe('OpenAIResponsesStoreController', () => {
  it('replays the response the create call answered with', async () => {
    const { chat, store } = await createSurface(chatResponse('resp_kept', 'the answer'));
    const created = createReplyMock();
    await chat.responses({ input: 'a question', model: 'gpt-4o' }, created as never);
    const answered = (created.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string };
    const retrieved = await store.inject({ url: `/v1/responses/${answered.id}`, headers });
    expect({ status: retrieved.statusCode, body: retrieved.json() }).toEqual({
      status: 200,
      body: answered,
    });
  });

  it.each(['GET', 'DELETE'] as const)(
    'reports an unknown id as not found on %s, in the OpenAI envelope',
    async (method) => {
      const { store } = await createSurface();
      const reply = await store.inject({ method, url: '/v1/responses/resp_missing', headers });
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 404,
        body: responseNotFound('resp_missing'),
      });
    },
  );

  it('never retains a response the caller asked not to store', async () => {
    const { chat, store } = await createSurface(
      chatResponse('resp_transient', 'gone'),
      chatResponse('resp_next', 'must not run'),
    );
    const created = createReplyMock();
    await chat.responses({ input: 'a question', model: 'gpt-4o', store: false }, created as never);
    const responseId = (
      (created.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string }
    ).id;
    const retrieved = await store.inject({ url: `/v1/responses/${responseId}`, headers });
    expect({ status: retrieved.statusCode, body: retrieved.json() }).toEqual({
      status: 404,
      body: responseNotFound(responseId),
    });
    const continued = createReplyMock();
    await chat.responses(
      { input: 'continue', previous_response_id: responseId },
      continued as never,
    );
    expect(continued.status).toHaveBeenCalledWith(404);
  });

  it('retains responses when store is omitted or explicitly true', async () => {
    for (const storeValue of [undefined, true]) {
      const { chat, store } = await createSurface(chatResponse('resp_kept', 'kept'));
      const created = createReplyMock();
      await chat.responses(
        { input: 'question', model: 'gpt-4o', store: storeValue },
        created as never,
      );
      const responseId = (
        (created.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string }
      ).id;
      const retrieved = await store.inject({ url: `/v1/responses/${responseId}`, headers });
      expect(retrieved.statusCode).toBe(200);
    }
  });

  it('does not create continuation state for an incomplete non-stream response', async () => {
    const incomplete = chatResponse('resp_incomplete', 'truncated');
    incomplete.choices[0].finish_reason = 'length';
    const { chat, store } = await createSurface(incomplete);
    const created = createReplyMock();
    await chat.responses({ input: 'a question', model: 'gpt-4o' }, created as never);
    const responseId = (
      (created.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string }
    ).id;
    const retrieved = await store.inject({ url: `/v1/responses/${responseId}`, headers });
    expect({ status: retrieved.statusCode, body: retrieved.json() }).toEqual({
      status: 404,
      body: responseNotFound(responseId),
    });
  });

  it('deletes a stored response once and reports it missing after that', async () => {
    const { chat, store } = await createSurface(chatResponse('resp_doomed', 'the answer'));
    const created = createReplyMock();
    await chat.responses({ input: 'a question', model: 'gpt-4o' }, created as never);
    const responseId = (
      (created.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string }
    ).id;
    const first = await store.inject({
      method: 'DELETE',
      url: `/v1/responses/${responseId}`,
      headers,
    });
    const second = await store.inject({
      method: 'DELETE',
      url: `/v1/responses/${responseId}`,
      headers,
    });
    expect({ status: first.statusCode, body: first.json() }).toEqual({
      status: 200,
      body: { id: responseId, object: 'response', deleted: true },
    });
    expect({ status: second.statusCode, body: second.json() }).toEqual({
      status: 404,
      body: responseNotFound(responseId),
    });
  });

  it('forgets the continuation history of a deleted response', async () => {
    const { chat, store } = await createSurface(
      chatResponse('resp_chain', 'the answer'),
      chatResponse('resp_chain_2', 'the second answer'),
    );
    const created = createReplyMock();
    await chat.responses({ input: 'a question', model: 'gpt-4o' }, created as never);
    const responseId = (
      (created.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string }
    ).id;
    await store.inject({ method: 'DELETE', url: `/v1/responses/${responseId}`, headers });
    const continuation = createReplyMock();
    await chat.responses(
      { input: 'and another', previous_response_id: responseId },
      continuation as never,
    );
    expect(continuation.status).toHaveBeenCalledWith(404);
  });

  it.each(['GET', 'DELETE'] as const)(
    'rejects unauthenticated %s before accessing response state',
    async (method) => {
      const { store, responsesSessions } = await createSurface();
      const get = vi.spyOn(responsesSessions, 'get');
      const remove = vi.spyOn(responsesSessions, 'delete');
      const reply = await store.inject({ method, url: '/v1/responses/resp_kept' });
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 401,
        body: {
          error: {
            code: 'invalid_api_key',
            message: 'API key validation failed',
            param: null,
            type: 'invalid_request_error',
          },
        },
      });
      expect(get).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it('retains framework handling for unexpected store failures', async () => {
    const { store, responsesSessions } = await createSurface();
    vi.spyOn(responsesSessions, 'get').mockImplementationOnce(() => {
      throw new Error('Store failed');
    });
    const reply = await store.inject({ url: '/v1/responses/resp_kept', headers });
    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 500,
      body: { statusCode: 500, message: 'Internal server error' },
    });
  });
});
