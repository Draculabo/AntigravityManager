import { Readable } from 'stream';
import { vi } from 'vitest';
import { Observable } from 'rxjs';

import { AnthropicService } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.service';
import { GeminiService } from '@/modules/proxy-gateway/server/modules/gemini/gemini.service';
import { OpenAIService } from '@/modules/proxy-gateway/server/modules/openai/openai.service';
import { GenerationConstraintsService } from '@/modules/proxy-gateway/server/shared/services/generation-constraints.service';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/shared/services/model-routing.service';
import {
  ModelAvailabilityService,
  proxyModelAvailabilityStore,
} from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import { ProxyRetryService } from '@/modules/proxy-gateway/server/shared/services/proxy-retry.service';
import type { CloudAccount } from '@/modules/cloud-account/types';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';

/**
 * Shared scaffolding for the black-box coverage of the real request path:
 *
 *   controller -> protocol service -> model routing -> account lease -> retry
 *              -> request mapper -> upstream fixture -> response/stream mapper
 *
 * Every object in that chain is the production one. The fakes here are exactly the three
 * things that leave the process: the account lease, which owns credentials and a database;
 * the upstream client, which replays a fixture instead of calling Google; and — mocked by
 * each test file, since `vi.mock` is hoisted per file — the User-Agent resolver, which asks
 * the network which client version to impersonate.
 *
 * Not a `.test.ts` file on purpose: the runner collects `src/tests/unit/**\/*.test.ts`, so
 * this sits beside its callers without being collected as a suite of its own.
 */

export interface UpstreamCall {
  accessToken: string;
  body: GeminiInternalRequest;
  kind: 'generate' | 'stream';
}

export interface UpstreamCountTokensCall {
  accessToken: string;
  body: unknown;
}

export function createAccount(id: string, projectId = 'test-project'): CloudAccount {
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
export function createUpstream(options: {
  countTokens?: unknown | (() => unknown);
  generate?: unknown | (() => unknown);
  streamError?: Error;
  streamFrames?: unknown[];
}) {
  const calls: UpstreamCall[] = [];
  const countTokensCalls: UpstreamCountTokensCall[] = [];

  return {
    calls,
    countTokensCalls,
    countTokensInternal: vi.fn(async (body: unknown, accessToken: string): Promise<unknown> => {
      countTokensCalls.push({ accessToken, body });
      const armed = options.countTokens;
      if (armed === undefined) {
        throw new Error('the test did not arm a countTokens upstream response');
      }
      return typeof armed === 'function' ? (armed as () => unknown)() : armed;
    }),
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
export function createLease(accounts: CloudAccount[]) {
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

export type FakeUpstream = ReturnType<typeof createUpstream>;
export type FakeLease = ReturnType<typeof createLease>;

/** The real shared services, wired the way `SharedServicesModule` wires them. */
export function createGateway(upstream: FakeUpstream, lease: FakeLease) {
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

  return {
    anthropicService: new AnthropicService(
      lease as never,
      upstream as never,
      constraints,
      retry,
      routing,
    ),
    geminiService,
    logger,
    openAIService: new OpenAIService(
      lease as never,
      upstream as never,
      geminiService,
      constraints,
      retry,
      routing,
    ),
  };
}

export function createReply() {
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
export function geminiTextResponse(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP' }],
    modelVersion: 'gemini-3-flash',
    responseId: 'upstream-response-1',
    usageMetadata: { candidatesTokenCount: 4, promptTokenCount: 11, totalTokenCount: 15 },
  };
}

export function geminiStreamFrame(payload: Record<string, unknown>) {
  return { response: payload };
}

export async function collect(stream: Observable<string>): Promise<string> {
  const chunks: string[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.subscribe({ complete: resolve, error: reject, next: (chunk) => chunks.push(chunk) });
  });
  return chunks.join('');
}
