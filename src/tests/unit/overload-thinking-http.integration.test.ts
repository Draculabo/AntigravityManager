// @vitest-environment node

import { createServer } from 'node:http';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { GeminiController } from '@/modules/proxy-gateway/server/modules/gemini/gemini.controller';
import { GeminiService } from '@/modules/proxy-gateway/server/modules/gemini/gemini.service';
import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
import { AnthropicService } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.service';
import { OpenAIChatController } from '@/modules/proxy-gateway/server/modules/openai/openai-chat.controller';
import { OpenAIResponsesController } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses.controller';
import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { OpenAIService } from '@/modules/proxy-gateway/server/modules/openai/openai.service';
import type { ResponsesRequestBody } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import type {
  AnthropicChatRequest,
  GeminiRequest,
  OpenAIChatRequest,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import {
  createAccount,
  createGateway,
  createLease,
  geminiTextResponse,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));
vi.mock('@/modules/proxy-gateway/server/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'controlled-overload-test/0.0.0',
  buildContentRequestUserAgent: () => 'controlled-overload-test/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));

vi.setConfig({ testTimeout: 15_000 });

type Protocol = 'chat' | 'responses' | 'messages' | 'gemini';
type RequestExtra =
  | Partial<OpenAIChatRequest>
  | Partial<ResponsesRequestBody>
  | Partial<AnthropicChatRequest>
  | Partial<GeminiRequest>;
const protocols: Protocol[] = ['chat', 'responses', 'messages', 'gemini'];
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const cleanup: Array<() => Promise<void> | void> = [];
const headers = { authorization: 'Bearer synthetic-overload-key' };
const WireBody = z
  .object({
    model: z.string(),
    requestId: z.string(),
    request: z
      .object({
        generationConfig: z
          .object({
            maxOutputTokens: z.number(),
            thinkingConfig: z.object({ thinkingBudget: z.number() }).passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
type WireBody = z.infer<typeof WireBody>;

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) {
      await close();
    }
  } finally {
    setServerConfig(previous);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
});

async function createSurface(
  options: {
    failureMessage?: string;
    revokeOnError?: boolean;
    alwaysOverloadedOnFirstAccount?: boolean;
    holdRecovery?: { started(): void; closed(): void };
    requestTimeoutSeconds?: number;
    streamErrorAfterText?: boolean;
  } = {},
) {
  const accounts = [createAccount('overload-a'), createAccount('overload-b')];
  const lease = createLease(accounts);
  const seen: Array<{ path: string; authorization: string | undefined; body: WireBody }> = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = WireBody.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const authorization = request.headers.authorization;
      seen.push({ path: request.url ?? '', authorization, body });
      if (options.streamErrorAfterText) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          `data: ${JSON.stringify(geminiStreamFrame({ candidates: [{ content: { role: 'model', parts: [{ text: 'Visible fixture text' }] } }] }))}\n\n` +
            `data: ${JSON.stringify({ error: { code: 503, message: 'The model is overloaded.' } })}\n\n`,
        );
        return;
      }
      if (
        seen.length === 1 ||
        (options.alwaysOverloadedOnFirstAccount && authorization === 'Bearer access-overload-a')
      ) {
        if (options.revokeOnError) {
          lease.isLeaseEligible.mockReturnValue(false);
        }
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              code: 503,
              status: 'UNAVAILABLE',
              message: options.failureMessage ?? 'The model is overloaded.',
            },
          }),
        );
        return;
      }
      if (options.holdRecovery && seen.length === 2) {
        response.once('close', options.holdRecovery.closed);
        options.holdRecovery.started();
        return;
      }
      const payload = geminiTextResponse('Recovered');
      if (request.url?.includes(':streamGenerateContent')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify(geminiStreamFrame(payload))}\n\n`);
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ response: payload }));
      }
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(
        error instanceof Error ? error.message : 'The fixture rejected an invalid request',
      );
    }
  });
  cleanup.push(async () => {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', fail);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected an allocated loopback port');
  }
  vi.stubEnv('PROXY_INTERNAL_BASE_URLS', `http://127.0.0.1:${address.port}/v1internal`);
  vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    api_key: 'synthetic-overload-key',
    request_timeout: options.requestTimeoutSeconds ?? DEFAULT_APP_CONFIG.proxy.request_timeout,
    experimental: {
      ...DEFAULT_APP_CONFIG.proxy.experimental,
      context_cache_enabled: false,
      thinking_only_recovery: false,
    },
  });
  const client = new GeminiClient({ capture: vi.fn() } as never);
  cleanup.push(() => client.onModuleDestroy());
  const gateway = createGateway(client as never, lease);
  @Module({
    controllers: [
      OpenAIChatController,
      OpenAIResponsesController,
      AnthropicController,
      GeminiController,
    ],
    providers: [
      ProxyGuard,
      OpenAIOperations,
      { provide: OpenAIService, useValue: gateway.openAIService },
      { provide: AnthropicService, useValue: gateway.anthropicService },
      { provide: GeminiService, useValue: gateway.geminiService },
    ],
  })
  class OverloadThinkingHttpModule {}
  const app = await NestFactory.create<NestFastifyApplication>(
    OverloadThinkingHttpModule,
    new FastifyAdapter(),
    { logger: false },
  );
  cleanup.push(() => app.close());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  return { seen, lease, base };
}

function requestFor(protocol: Protocol, stream: boolean, extra: RequestExtra = {}) {
  if (protocol === 'gemini') {
    return {
      path: `/v1beta/models/gemini-3-flash:${stream ? 'streamGenerateContent' : 'generateContent'}`,
      body: { contents: [{ role: 'user', parts: [{ text: 'fixture' }] }], ...extra },
    };
  }
  if (protocol === 'responses') {
    return {
      path: '/v1/responses',
      body: { model: 'gemini-3-flash', input: 'fixture', store: false, stream, ...extra },
    };
  }
  return {
    path: protocol === 'chat' ? '/v1/chat/completions' : '/v1/messages',
    body: {
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'fixture' }],
      stream,
      ...extra,
    },
  };
}

async function send(
  base: string,
  protocol: Protocol,
  stream = false,
  extra: RequestExtra = {},
  signal = AbortSignal.timeout(10_000),
) {
  const request = requestFor(protocol, stream, extra);
  const response = await fetch(`${base}${request.path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(request.body),
    signal,
  });
  return { status: response.status, body: await response.text() };
}

describe('Automatic thinking overload recovery over HTTP', () => {
  it('closes an in-flight recovery when the caller cancels', async () => {
    const started = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const { base, seen, lease } = await createSurface({
      holdRecovery: { started: started.resolve, closed: closed.resolve },
    });
    const controller = new AbortController();
    const pending = send(base, 'gemini', false, {}, controller.signal).then(
      () => {
        throw new Error('Expected caller cancellation');
      },
      (error: unknown) => error,
    );
    await started.promise;
    controller.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    await closed.promise;
    expect(
      seen.map((attempt) => attempt.body.request.generationConfig.thinkingConfig.thinkingBudget),
    ).toEqual([-1, 4000]);
    expect(lease.commitSession).not.toHaveBeenCalled();
  });

  it('keeps the original deadline while a recovery response is pending', async () => {
    const started = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const { base, seen, lease } = await createSurface({
      requestTimeoutSeconds: 1,
      holdRecovery: { started: started.resolve, closed: closed.resolve },
    });
    const pending = send(base, 'gemini');
    await started.promise;
    const reply = await pending;
    expect(reply.status, reply.body).toBe(504);
    await closed.promise;
    expect(
      seen.map((attempt) => attempt.body.request.generationConfig.thinkingConfig.thinkingBudget),
    ).toEqual([-1, 4000]);
    expect(lease.commitSession).not.toHaveBeenCalled();
  });

  it('does not replay a stream that reports overload after visible text', async () => {
    const { base, seen } = await createSurface({ streamErrorAfterText: true });
    const reply = await send(base, 'gemini', true);
    expect(reply.status, reply.body).toBe(200);
    expect(reply.body).toContain('Visible fixture text');
    expect(
      seen.map((attempt) => attempt.body.request.generationConfig.thinkingConfig.thinkingBudget),
    ).toEqual([-1]);
  });
  it.each(protocols.flatMap((protocol) => [false, true].map((stream) => ({ protocol, stream }))))(
    '$protocol stream=$stream retries once on the same account and returns a complete response',
    async ({ protocol, stream }) => {
      const { base, seen, lease } = await createSurface();
      const reply = await send(base, protocol, stream);
      expect(reply.status, reply.body).toBe(200);
      expect(reply.body).toContain('Recovered');
      if (stream) {
        expect(reply.body).toContain(
          protocol === 'messages'
            ? 'message_stop'
            : protocol === 'responses'
              ? 'response.completed'
              : protocol === 'chat'
                ? '[DONE]'
                : 'STOP',
        );
      }
      expect(seen).toHaveLength(2);
      const [first, recovered] = seen;
      expect(first.body.request.generationConfig.thinkingConfig.thinkingBudget).toBe(-1);
      expect(recovered.body.requestId).not.toBe(first.body.requestId);
      expect(recovered.body.requestId.split('/')[1]).toBe(first.body.requestId.split('/')[1]);
      expect(recovered).toEqual({
        ...first,
        body: {
          ...first.body,
          requestId: recovered.body.requestId,
          request: {
            ...first.body.request,
            generationConfig: {
              ...first.body.request.generationConfig,
              thinkingConfig: {
                ...first.body.request.generationConfig.thinkingConfig,
                thinkingBudget: 4000,
              },
            },
          },
        },
      });
      expect(lease.getNextToken).toHaveBeenCalledOnce();
      expect(lease.penalties).toEqual([]);
      expect(lease.commitSession).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { protocol: 'chat', extra: { reasoning_effort: 'high' } },
    { protocol: 'chat', extra: { thinking: { type: 'enabled', budget_tokens: 12_000 } } },
    { protocol: 'responses', extra: { reasoning: { effort: 'high' } } },
    { protocol: 'messages', extra: { thinking: { type: 'enabled', budget_tokens: 12_000 } } },
    { protocol: 'messages', extra: { output_config: { effort: 'high' } } },
    {
      protocol: 'gemini',
      extra: {
        generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 12_000 } },
      },
    },
    {
      protocol: 'gemini',
      extra: {
        generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } },
      },
    },
    { protocol: 'chat', extra: { model: 'gemini-3.1-pro-low' } },
  ] satisfies Array<{ protocol: Protocol; extra: RequestExtra }>)(
    '$protocol preserves explicit thinking controls $extra',
    async ({ protocol, extra }) => {
      const { base, seen } = await createSurface();
      const reply = await send(base, protocol, false, extra);
      expect(reply.status, reply.body).toBe(200);
      expect(reply.body).toContain('Recovered');
      expect(seen.length).toBeGreaterThanOrEqual(2);
      const budgets = seen.map(
        (attempt) => attempt.body.request.generationConfig.thinkingConfig.thinkingBudget,
      );
      expect(budgets).toEqual(budgets.map(() => budgets[0]));
      expect(budgets).not.toContain(4000);
    },
  );

  it('keeps a plain 503 on the ordinary retry path without changing thinking', async () => {
    const { base, seen } = await createSurface({
      failureMessage: 'Service temporarily unavailable.',
    });
    const reply = await send(base, 'gemini');
    expect(reply.status, reply.body).toBe(200);
    expect(
      seen.map((attempt) => attempt.body.request.generationConfig.thinkingConfig.thinkingBudget),
    ).toEqual([-1, -1]);
  });

  it('spends only one degradation across a failed recovery and ordinary account rotation', async () => {
    const { base, seen, lease } = await createSurface({ alwaysOverloadedOnFirstAccount: true });
    const reply = await send(base, 'gemini');
    expect(reply.status, reply.body).toBe(200);
    expect(reply.body).toContain('Recovered');
    expect(
      seen.filter(
        (attempt) => attempt.body.request.generationConfig.thinkingConfig.thinkingBudget === 4000,
      ),
    ).toHaveLength(1);
    expect(seen.at(-1)?.authorization).toBe('Bearer access-overload-b');
    expect(seen.at(-1)?.body.request.generationConfig.thinkingConfig.thinkingBudget).toBe(-1);
    expect(lease.commitSession).toHaveBeenCalledOnce();
  });

  it('does not degrade after the owning account lease is revoked', async () => {
    const { base, seen } = await createSurface({ revokeOnError: true });
    await send(base, 'gemini');
    expect(seen[0].body.request.generationConfig.thinkingConfig.thinkingBudget).toBe(-1);
    expect(
      seen.every(
        (attempt) => attempt.body.request.generationConfig.thinkingConfig.thinkingBudget !== 4000,
      ),
    ).toBe(true);
  });
});
