import { Readable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';

import { OpenAIController } from '@/modules/proxy-gateway/server/modules/openai/openai.controller';
import { OpenAIService } from '@/modules/proxy-gateway/server/modules/openai/openai.service';
import { GeminiService } from '@/modules/proxy-gateway/server/modules/gemini/gemini.service';
import { GenerationConstraintsService } from '@/modules/proxy-gateway/server/shared/services/generation-constraints.service';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/shared/services/model-routing.service';
import {
  ModelAvailabilityService,
  proxyModelAvailabilityStore,
} from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import { ProxyRetryService } from '@/modules/proxy-gateway/server/shared/services/proxy-retry.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
import type { CloudAccount } from '@/modules/cloud-account/types';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';

/**
 * Black-box coverage of the real request path, end to end:
 *
 *   controller -> protocol service -> model routing -> account lease -> retry
 *              -> request mapper -> upstream fixture -> response/stream mapper
 *
 * Everything in that chain is the production object. The fakes are exactly the three things
 * that leave the process: the account lease, which owns credentials and a database; the
 * upstream client, which replays a fixture instead of calling Google; and the User-Agent
 * resolver, which asks the network which client version to impersonate. A conformance test
 * that mocks the protocol service proves the controller talks to the service; it cannot
 * prove the gateway still answers an OpenAI client correctly, which is what these check.
 */

vi.mock(
  '@/modules/proxy-gateway/server/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRequestUserAgent: async () => 'antigravity-parity-harness/0.0.0',
  }),
);

interface UpstreamCall {
  accessToken: string;
  body: GeminiInternalRequest;
  kind: 'generate' | 'stream';
}

function createAccount(id: string, projectId = 'test-project'): CloudAccount {
  return {
    created_at: 1,
    email: `${id}@example.com`,
    id,
    last_used: 1,
    provider: 'google',
    token: {
      access_token: `access-${id}`,
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      project_id: projectId,
      refresh_token: `refresh-${id}`,
      token_type: 'Bearer',
    },
  } as CloudAccount;
}

/** An upstream that replays what the test hands it and records what the gateway sent. */
function createUpstream(options: {
  generate?: unknown | (() => unknown);
  streamError?: Error;
  streamFrames?: unknown[];
}) {
  const calls: UpstreamCall[] = [];

  return {
    calls,
    generateInternal: vi.fn(
      async (body: GeminiInternalRequest, accessToken: string): Promise<unknown> => {
        calls.push({ accessToken, body, kind: 'generate' });
        const armed = options.generate;
        if (armed === undefined) {
          throw new Error('the test did not arm a non-stream upstream response');
        }
        return typeof armed === 'function' ? (armed as () => unknown)() : armed;
      },
    ),
    streamGenerateInternal: vi.fn(
      async (body: GeminiInternalRequest, accessToken: string): Promise<Readable> => {
        calls.push({ accessToken, body, kind: 'stream' });
        if (options.streamError) {
          throw options.streamError;
        }
        // A real readable rather than a bare emitter: it buffers until the gateway subscribes.
        // An emitter fires into nothing if the consumer attaches its listeners a tick later,
        // and the collector then waits for an `end` that already happened.
        return Readable.from(
          (options.streamFrames ?? []).map((frame) =>
            Buffer.from(`data: ${JSON.stringify(frame)}\n\n`),
          ),
        );
      },
    ),
  };
}

/** The account lease, reduced to the two interfaces the shared services actually ask for. */
function createLease(accounts: CloudAccount[]) {
  const penalties: Array<{ accountId: string; kind: string }> = [];

  return {
    getModelOutputLimitForAccount: vi.fn(() => undefined),
    getModelThinkingBudgetForAccount: vi.fn(() => undefined),
    getNextToken: vi.fn(async (options?: { excludeAccountIds?: string[] }) => {
      const excluded = new Set(options?.excludeAccountIds ?? []);
      return accounts.find((candidate) => !excluded.has(candidate.id)) ?? null;
    }),
    getRemainingRateLimitWait: vi.fn(() => 0),
    markAsForbidden: vi.fn((accountId: string) => {
      penalties.push({ accountId, kind: 'forbidden' });
    }),
    markAsRateLimited: vi.fn((accountId: string) => {
      penalties.push({ accountId, kind: 'rate_limited' });
    }),
    markFromUpstreamError: vi.fn(async (params: { accountIdOrEmail: string }) => {
      penalties.push({ accountId: params.accountIdOrEmail, kind: 'upstream_error' });
    }),
    markModelSuccess: vi.fn(),
    markModelUnrequestable: vi.fn(),
    penalties,
    recordParityError: vi.fn(),
    resolveDynamicModelForAccount: vi.fn((_accountId: string, model: string) => model),
  };
}

function createGateway(
  upstream: ReturnType<typeof createUpstream>,
  lease: ReturnType<typeof createLease>,
) {
  const logger = { log: vi.fn(), warn: vi.fn() };
  const availability = proxyModelAvailabilityStore as unknown as ModelAvailabilityService;
  const routing = new ModelRoutingService();
  const constraints = new GenerationConstraintsService(lease);
  const retry = new ProxyRetryService(lease, logger, availability);
  const geminiService = new GeminiService(
    lease as never,
    upstream as never,
    constraints,
    retry,
    routing,
  );
  const service = new OpenAIService(
    lease as never,
    upstream as never,
    geminiService,
    constraints,
    retry,
    routing,
  );

  return { controller: new OpenAIController(service), logger, service };
}

function createReply() {
  const reply: Record<string, unknown> & { body?: unknown; statusCode?: number } = {};
  reply.header = vi.fn(() => reply);
  reply.status = vi.fn((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  reply.send = vi.fn((payload: unknown) => {
    reply.body = payload;
    return reply;
  });
  return reply;
}

/**
 * What `GeminiClient.generateInternal` hands back. It strips the `{ response: ... }` transport
 * envelope itself, so the fake returns the inner object; stream frames keep the envelope,
 * because there it is the SSE decoder that strips it.
 */
function geminiTextResponse(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP' }],
    modelVersion: 'gemini-3-flash',
    responseId: 'upstream-response-1',
    usageMetadata: { candidatesTokenCount: 4, promptTokenCount: 11, totalTokenCount: 15 },
  };
}

function geminiStreamFrame(payload: Record<string, unknown>) {
  return { response: payload };
}

async function collect(stream: Observable<string>): Promise<string> {
  const chunks: string[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.subscribe({ complete: resolve, error: reject, next: (chunk) => chunks.push(chunk) });
  });
  return chunks.join('');
}

describe('real request path, OpenAI chat surface', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
    proxyModelAvailabilityStore.clearAccount('acc-2');
  });

  it('answers an OpenAI client from an upstream fixture, through every real layer', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('The weather is cloudy.') });
    const lease = createLease([createAccount('acc-1')]);
    const { controller } = createGateway(upstream, lease);
    const reply = createReply();

    await controller.chatCompletions(
      {
        messages: [{ content: 'What is the weather?', role: 'user' }],
        model: 'gemini-3-flash',
        stream: false,
      } as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.body).toMatchObject({
      choices: [
        {
          finish_reason: 'stop',
          index: 0,
          message: { content: 'The weather is cloudy.', role: 'assistant' },
        },
      ],
      object: 'chat.completion',
    });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.accessToken).toBe('access-acc-1');
  });

  it('carries the client request through the mapper into the upstream body', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1', 'project-42')]);
    const { controller } = createGateway(upstream, lease);

    await controller.chatCompletions(
      {
        messages: [
          { content: 'You are terse.', role: 'system' },
          { content: 'Say hello.', role: 'user' },
        ],
        model: 'gemini-3-flash',
        stream: false,
      } as never,
      createReply() as never,
    );

    const sent = JSON.stringify(upstream.calls[0]?.body);
    expect(sent).toContain('project-42');
    expect(sent).toContain('Say hello.');
    expect(sent).toContain('You are terse.');
  });

  it('streams an upstream fixture to an OpenAI client as SSE it can read', async () => {
    const upstream = createUpstream({
      streamFrames: [
        geminiStreamFrame({
          candidates: [{ content: { parts: [{ text: 'partial ' }], role: 'model' } }],
          modelVersion: 'gemini-3-flash',
        }),
        geminiStreamFrame({
          candidates: [
            { content: { parts: [{ text: 'answer' }], role: 'model' }, finishReason: 'STOP' },
          ],
          modelVersion: 'gemini-3-flash',
        }),
      ],
    });
    const lease = createLease([createAccount('acc-1')]);
    const { service } = createGateway(upstream, lease);

    const result = await service.handleChatCompletions({
      messages: [{ content: 'stream please', role: 'user' }],
      model: 'gemini-3-flash',
      stream: true,
    } as never);
    const payload = await collect(result as Observable<string>);

    expect(payload).toContain('"object":"chat.completion.chunk"');
    expect(payload).toContain('partial ');
    expect(payload).toContain('answer');
    expect(payload.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('moves to the next account when the first one is rejected upstream', async () => {
    let attempt = 0;
    const upstream = createUpstream({
      generate: () => {
        attempt += 1;
        if (attempt === 1) {
          throw new UpstreamRequestError({
            body: '{"error":{"status":"PERMISSION_DENIED"}}',
            message: 'The caller does not have permission',
            status: 403,
          });
        }
        return geminiTextResponse('second account answered');
      },
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const { controller } = createGateway(upstream, lease);
    const reply = createReply();

    await controller.chatCompletions(
      {
        messages: [{ content: 'hello', role: 'user' }],
        model: 'gemini-3-flash',
        stream: false,
      } as never,
      reply as never,
    );

    expect(lease.penalties).toEqual([{ accountId: 'acc-1', kind: 'forbidden' }]);
    expect(upstream.calls.map((call) => call.accessToken)).toEqual([
      'access-acc-1',
      'access-acc-2',
    ]);
    expect(reply.body).toMatchObject({
      choices: [{ message: { content: 'second account answered' } }],
    });
  });

  it('keeps a recoverable 403 account in rotation instead of burning it', async () => {
    let attempt = 0;
    const upstream = createUpstream({
      generate: () => {
        attempt += 1;
        if (attempt === 1) {
          throw new UpstreamRequestError({
            details: [
              {
                domain: 'cloudcode-pa.googleapis.com',
                reason: 'VALIDATION_REQUIRED',
                type: 'type.googleapis.com/google.rpc.ErrorInfo',
              },
            ],
            message: 'Permission denied',
            status: 403,
          });
        }
        return geminiTextResponse('answered anyway');
      },
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const { controller } = createGateway(upstream, lease);

    await controller.chatCompletions(
      {
        messages: [{ content: 'hello', role: 'user' }],
        model: 'gemini-3-flash',
        stream: false,
      } as never,
      createReply() as never,
    );

    expect(lease.penalties).toEqual([]);
  });
});
