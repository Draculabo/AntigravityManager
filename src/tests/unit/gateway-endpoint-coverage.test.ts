import { existsSync } from 'node:fs';
import path from 'node:path';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';

/**
 * A census of every HTTP route this gateway registers, and which test file is
 * responsible for exercising it. The route list below is NOT hand-typed: the
 * `beforeAll` hook boots the real `AppModule` on a real `FastifyAdapter` (the
 * same wiring `src/server/main.ts` uses, minus `listen()`) and reads the
 * routes Fastify's own `onRoute` hook reports. That is the only source of
 * truth this file trusts, so a route added to any controller shows up here
 * automatically, and the tests below fail until the census is updated to
 * name it.
 *
 * `AGM_V1INTERNAL_PASSTHROUGH=1` is set before `AppModule` is imported so the
 * gated `/v1internal/*` diagnostic routes (off by default, see
 * `src/modules/proxy-gateway/server/README.md` section 4b) are included too:
 * the point of this census is the full route surface the codebase can
 * register, not just today's default configuration.
 *
 * Fastify auto-registers a `HEAD` sibling for every `GET` route. Those are
 * dropped before comparison: they are intrinsic to Fastify's router, not a
 * route a developer added, and every `HEAD` shares its `GET` counterpart's
 * census entry and test coverage.
 *
 * What this test CANNOT catch: it proves a route is *reachable* and that a
 * named file exists, not that the file's assertions are meaningful, that the
 * route's behavior is correct, or that a test file which imports a
 * controller class actually calls the specific handler method for a given
 * route (that mapping below was built and hand-verified by reading each test
 * file, and can drift silently if a method call is deleted from a test
 * without the route disappearing).
 */

interface CensusEntry {
  method: string;
  routePath: string;
  /** File under `src/tests/unit/` that calls this route's handler, or `null` for `UNCOVERED`. */
  testFile: string | null;
  /** Required when `testFile` is `null`: why no test exercises this route yet. */
  reason?: string;
}

const CENSUS: readonly CensusEntry[] = [
  // Anthropic message batches (src/modules/proxy-gateway/server/modules/batch/anthropic-message-batches.controller.ts)
  {
    method: 'POST',
    routePath: '/v1/messages/batches',
    testFile: 'anthropic-message-batches.controller.test.ts',
  },
  {
    method: 'GET',
    routePath: '/v1/messages/batches',
    testFile: 'anthropic-message-batches.controller.test.ts',
  },
  {
    method: 'GET',
    routePath: '/v1/messages/batches/:id',
    testFile: 'anthropic-message-batches.controller.test.ts',
  },
  {
    method: 'GET',
    routePath: '/v1/messages/batches/:id/results',
    testFile: 'anthropic-message-batches.controller.test.ts',
  },
  {
    method: 'POST',
    routePath: '/v1/messages/batches/:id/cancel',
    testFile: 'anthropic-message-batches.controller.test.ts',
  },
  {
    method: 'DELETE',
    routePath: '/v1/messages/batches/:id',
    testFile: 'anthropic-message-batches.controller.test.ts',
  },

  // Gemini batches (src/modules/proxy-gateway/server/modules/batch/gemini-batches.controller.ts)
  {
    method: 'GET',
    routePath: '/v1beta/batches',
    testFile: 'gemini-batch.test.ts',
  },
  { method: 'GET', routePath: '/v1beta/batches/:name', testFile: 'gemini-batch.test.ts' },

  // OpenAI batches (src/modules/proxy-gateway/server/modules/batch/openai-batches.controller.ts)
  { method: 'POST', routePath: '/v1/batches', testFile: 'openai-batches.controller.test.ts' },
  { method: 'GET', routePath: '/v1/batches', testFile: 'openai-batches.controller.test.ts' },
  { method: 'GET', routePath: '/v1/batches/:id', testFile: 'openai-batches.controller.test.ts' },
  {
    method: 'POST',
    routePath: '/v1/batches/:id/cancel',
    testFile: 'openai-batches.controller.test.ts',
  },

  // Gemini protocol (src/modules/proxy-gateway/server/modules/gemini/gemini.controller.ts)
  { method: 'GET', routePath: '/v1beta/models', testFile: 'gemini-controller.integration.test.ts' },
  {
    method: 'GET',
    routePath: '/v1beta/models/:model',
    testFile: 'gemini-controller.integration.test.ts',
  },
  {
    method: 'POST',
    routePath: '/v1beta/models/:modelAction',
    testFile: 'gemini-controller.integration.test.ts',
  },
  {
    method: 'POST',
    routePath: '/v1beta/models/:model/countTokens',
    testFile: 'gemini-count-tokens.test.ts',
  },

  // Anthropic /v1/complete legacy surface (src/modules/proxy-gateway/server/modules/anthropic/anthropic-complete.controller.ts)
  { method: 'POST', routePath: '/v1/complete', testFile: 'anthropic-complete.controller.test.ts' },

  // Anthropic Messages protocol (src/modules/proxy-gateway/server/modules/anthropic/anthropic.controller.ts)
  {
    method: 'POST',
    routePath: '/v1/messages/count_tokens',
    testFile: 'anthropic-count-tokens.test.ts',
  },
  { method: 'POST', routePath: '/v1/messages', testFile: 'proxy-real-path-anthropic.test.ts' },

  // Gemini Files API (src/modules/proxy-gateway/server/modules/files/gemini-files.controller.ts)
  { method: 'POST', routePath: '/upload/v1beta/files', testFile: 'files-api.test.ts' },
  { method: 'GET', routePath: '/v1beta/files', testFile: 'files-api.test.ts' },
  { method: 'GET', routePath: '/v1beta/files/:name', testFile: 'files-api.test.ts' },
  {
    method: 'DELETE',
    routePath: '/v1beta/files/:name',
    testFile: 'files-api.test.ts',
  },

  // OpenAI/Anthropic client Files API (src/modules/proxy-gateway/server/modules/files/client-files.controller.ts)
  { method: 'POST', routePath: '/v1/files', testFile: 'files-api.test.ts' },
  {
    method: 'GET',
    routePath: '/v1/files',
    testFile: 'files-api.test.ts',
  },
  { method: 'GET', routePath: '/v1/files/:id', testFile: 'files-api.test.ts' },
  { method: 'GET', routePath: '/v1/files/:id/content', testFile: 'files-api.test.ts' },
  { method: 'DELETE', routePath: '/v1/files/:id', testFile: 'files-api.test.ts' },

  // OpenAI Uploads (src/modules/proxy-gateway/server/modules/uploads/openai-uploads.controller.ts)
  { method: 'POST', routePath: '/v1/uploads', testFile: 'openai-uploads.test.ts' },
  { method: 'POST', routePath: '/v1/uploads/:id/parts', testFile: 'openai-uploads.test.ts' },
  { method: 'POST', routePath: '/v1/uploads/:id/complete', testFile: 'openai-uploads.test.ts' },
  { method: 'POST', routePath: '/v1/uploads/:id/cancel', testFile: 'openai-uploads.test.ts' },

  // OpenAI protocol entry controllers (src/modules/proxy-gateway/server/modules/openai/openai-*.controller.ts)
  { method: 'GET', routePath: '/v1/models', testFile: 'openai-retrieve-model.test.ts' },
  { method: 'GET', routePath: '/v1/models/:model', testFile: 'openai-retrieve-model.test.ts' },
  {
    method: 'POST',
    routePath: '/v1/chat/completions',
    testFile: 'file-reference-expansion.test.ts',
  },
  {
    method: 'GET',
    routePath: '/v1/chat/completions/:completionId',
    testFile: 'openai-stored-chat-completions.test.ts',
  },
  {
    method: 'POST',
    routePath: '/v1/completions',
    testFile: 'proxy-controller.integration.test.ts',
  },
  {
    method: 'POST',
    routePath: '/v1/responses',
    testFile: 'openai-responses-session-durability.test.ts',
  },
  {
    method: 'POST',
    routePath: '/v1/images/generations',
    testFile: 'proxy-controller.integration.test.ts',
  },
  {
    method: 'POST',
    routePath: '/v1/images/edits',
    testFile: 'proxy-controller.integration.test.ts',
  },
  {
    method: 'POST',
    routePath: '/v1/audio/transcriptions',
    testFile: 'proxy-controller.integration.test.ts',
  },
  {
    method: 'POST',
    routePath: '/v1/audio/translations',
    testFile: 'openai-audio-translations.test.ts',
  },

  // OpenAI Responses store (src/modules/proxy-gateway/server/modules/openai/responses/openai-responses-store.controller.ts)
  {
    method: 'GET',
    routePath: '/v1/responses/:responseId',
    testFile: 'openai-responses-store.controller.test.ts',
  },
  {
    method: 'DELETE',
    routePath: '/v1/responses/:responseId',
    testFile: 'openai-responses-store.controller.test.ts',
  },

  // v1internal diagnostic passthrough, gated by AGM_V1INTERNAL_PASSTHROUGH
  // (src/modules/proxy-gateway/server/modules/v1internal-passthrough/v1internal-passthrough.controller.ts)
  {
    method: 'POST',
    routePath: '/v1internal/countTokens',
    testFile: 'v1internal-passthrough.test.ts',
  },
  {
    method: 'POST',
    routePath: '/v1internal/embedContent',
    testFile: 'v1internal-passthrough.test.ts',
  },
  {
    method: 'POST',
    routePath: '/v1internal/generateChat',
    testFile: 'v1internal-passthrough.test.ts',
  },
];

const EXPECTED_UNCOVERED_ROUTES: readonly string[] = [];

const OPENAI_PROTOCOL_ROUTE_KEYS = [
  'GET /v1/models',
  'GET /v1/models/:model',
  'POST /v1/chat/completions',
  'GET /v1/chat/completions/:completionId',
  'POST /v1/completions',
  'POST /v1/responses',
  'POST /v1/images/generations',
  'POST /v1/images/edits',
  'POST /v1/audio/transcriptions',
  'POST /v1/audio/translations',
] as const;

const UNIT_TEST_DIR = path.join(process.cwd(), 'src/tests/unit');

function routeKey(entry: { method: string; routePath: string }): string {
  return `${entry.method} ${entry.routePath}`;
}

let registeredRoutes: Array<{ method: string; routePath: string }> = [];
let previousV1InternalFlag: string | undefined;
let previousServerConfig = getServerConfig();
let app: NestFastifyApplication | undefined;

// This boots and transforms the complete Electron/Nest graph; cold WSL and CI workers can take
// more than Vitest's default hook budget even when application initialization completes normally.
beforeAll(async () => {
  previousV1InternalFlag = process.env.AGM_V1INTERNAL_PASSTHROUGH;
  process.env.AGM_V1INTERNAL_PASSTHROUGH = '1';

  // Imported dynamically, after the env var above is set: `V1InternalPassthroughModule`
  // reads it once while its `@Module` decorator is evaluated at import time.
  const { AppModule } = await import('@/server/app.module');

  const seen = new Set<string>();
  const adapter = new FastifyAdapter();
  adapter.getInstance().addHook('onRoute', (opts) => {
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
    for (const method of methods) {
      const normalizedMethod = String(method);
      if (normalizedMethod === 'HEAD') {
        continue;
      }
      const key = `${normalizedMethod} ${opts.url}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      registeredRoutes.push({ method: normalizedMethod, routePath: opts.url });
    }
  });

  app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { logger: false });
  await app.init();
}, 60_000);

afterAll(async () => {
  await app?.close();
  app = undefined;
  registeredRoutes = [];
  if (previousV1InternalFlag === undefined) {
    delete process.env.AGM_V1INTERNAL_PASSTHROUGH;
  } else {
    process.env.AGM_V1INTERNAL_PASSTHROUGH = previousV1InternalFlag;
  }
  setServerConfig(previousServerConfig ?? DEFAULT_APP_CONFIG.proxy);
});

describe('gateway endpoint coverage census', () => {
  it('boots the real gateway and finds at least one route', () => {
    expect(registeredRoutes.length).toBeGreaterThan(0);
  });

  it('preserves every OpenAI protocol route while its entry controllers are split', () => {
    const routeKeys = new Set(registeredRoutes.map(routeKey));

    expect(OPENAI_PROTOCOL_ROUTE_KEYS.filter((key) => !routeKeys.has(key))).toEqual([]);
  });

  it('has a census entry for every route the gateway actually registers', () => {
    const censusKeys = new Set(CENSUS.map(routeKey));
    const uncensused = registeredRoutes
      .map(routeKey)
      .filter((key) => !censusKeys.has(key))
      .sort();

    expect(uncensused, 'routes the app registers but the census does not mention').toEqual([]);
  });

  it('has no census entry for a route the gateway does not register', () => {
    const liveKeys = new Set(registeredRoutes.map(routeKey));
    const stale = CENSUS.map(routeKey)
      .filter((key) => !liveKeys.has(key))
      .sort();

    expect(stale, 'census entries naming a route the app never registers').toEqual([]);
  });

  it('points every covered census entry at a test file that exists on disk', () => {
    const missingTestFiles = CENSUS.filter(
      (entry) => entry.testFile !== null && !existsSync(path.join(UNIT_TEST_DIR, entry.testFile)),
    ).map((entry) => `${routeKey(entry)} -> ${entry.testFile}`);

    expect(
      missingTestFiles,
      'census entries naming a test file that does not exist on disk',
    ).toEqual([]);
  });

  it('gives every UNCOVERED entry a one-line reason', () => {
    const uncoveredWithoutReason = CENSUS.filter(
      (entry) => entry.testFile === null && !entry.reason,
    ).map(routeKey);

    expect(uncoveredWithoutReason, 'UNCOVERED entries missing a reason').toEqual([]);
  });

  it('keeps the exact set of routes without a behavior test', () => {
    const uncovered = CENSUS.filter((entry) => entry.testFile === null)
      .map(routeKey)
      .sort();

    expect(uncovered).toEqual([...EXPECTED_UNCOVERED_ROUTES].sort());
    expect(uncovered).toHaveLength(0);
  });

  it('rejects unauthenticated requests on each formerly uncovered route with its protocol envelope', async () => {
    if (!app) {
      throw new Error('gateway application was not initialized');
    }
    previousServerConfig = getServerConfig();
    setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: 'gateway-test-key' });

    try {
      const server = app.getHttpAdapter().getInstance();
      const [anthropic, gemini, openAI] = await Promise.all([
        server.inject({ method: 'DELETE', url: '/v1/messages/batches/missing' }),
        server.inject({ method: 'DELETE', url: '/v1beta/files/missing' }),
        server.inject({ method: 'GET', url: '/v1/files' }),
      ]);

      expect([
        { statusCode: anthropic.statusCode, body: JSON.parse(anthropic.body) },
        { statusCode: gemini.statusCode, body: JSON.parse(gemini.body) },
        { statusCode: openAI.statusCode, body: JSON.parse(openAI.body) },
      ]).toEqual([
        {
          statusCode: 401,
          body: {
            type: 'error',
            error: { message: 'API key validation failed', type: 'authentication_error' },
          },
        },
        {
          statusCode: 401,
          body: {
            error: {
              code: 401,
              message: 'API key validation failed',
              status: 'UNAUTHENTICATED',
            },
          },
        },
        {
          statusCode: 401,
          body: {
            error: {
              code: 'invalid_api_key',
              message: 'API key validation failed',
              param: null,
              type: 'invalid_request_error',
            },
          },
        },
      ]);
    } finally {
      setServerConfig(previousServerConfig ?? DEFAULT_APP_CONFIG.proxy);
    }
  });
});
