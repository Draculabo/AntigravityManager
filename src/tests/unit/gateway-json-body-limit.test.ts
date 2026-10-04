import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { bootstrapNestServer, stopNestServer } from '@/server/main';
import { trafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@nestjs/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nestjs/core')>()),
  NestFactory: { create: mocks.create },
}));
vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock(
  '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-websocket.server',
  () => ({
    attachOpenAIResponsesWebSocketServer: () => () => {},
  }),
);

let gateway: FastifyInstance;

function jsonPayload(bytes: number): string {
  return JSON.stringify({ text: 'a'.repeat(bytes - Buffer.byteLength('{"text":""}')) });
}

beforeEach(async () => {
  vi.spyOn(trafficAuditService, 'close').mockResolvedValue(undefined);
  vi.spyOn(thoughtStoreService, 'close').mockResolvedValue(undefined);
  // Exercise the production bootstrap and real Fastify parsers without account or upstream work.
  mocks.create.mockImplementation(async (_module: unknown, adapter: unknown) => {
    if (!(adapter instanceof FastifyAdapter)) {
      throw new Error('Expected the production Fastify adapter');
    }
    gateway = adapter.getInstance<FastifyInstance>();
    for (const url of [
      '/v1/chat/completions',
      '/v1/responses',
      '/v1/messages',
      '/v1beta/models/test:generateContent',
      '/internal/audit/repair',
    ]) {
      gateway.post(url, async (request, reply) => {
        if (request.headers.authorization !== 'Bearer synthetic-key') {
          return reply.code(401).send({ error: 'Unauthorized' });
        }
        return { parsedBytes: Buffer.byteLength(JSON.stringify(request.body)) };
      });
    }
    return {
      register: gateway.register.bind(gateway),
      enableCors: vi.fn(),
      listen: () => gateway.ready(),
      close: () => gateway.close(),
      get: () => ({ getAccountCount: () => 0 }),
      getHttpServer: () => gateway.server,
    };
  });
  expect(
    (
      await bootstrapNestServer({
        ...DEFAULT_APP_CONFIG.proxy,
        api_key: 'synthetic-key',
        traffic_audit: { ...DEFAULT_APP_CONFIG.proxy.traffic_audit, enabled: false },
      })
    ).success,
  ).toBe(true);
});

afterEach(async () => {
  await stopNestServer();
  vi.restoreAllMocks();
});

describe('gateway JSON request capacity', () => {
  it.each([
    '/v1/chat/completions',
    '/v1/responses',
    '/v1/messages',
    '/v1beta/models/test:generateContent',
  ])('accepts a 2 MiB JSON request on %s', async (url) => {
    const response = await gateway.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-key' },
      payload: jsonPayload(2 * 1024 * 1024),
    });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 200,
      body: { parsedBytes: 2 * 1024 * 1024 },
    });
  });

  it('allows a large JSON request to reach authentication rather than returning 413', async () => {
    const response = await gateway.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: jsonPayload(2 * 1024 * 1024),
    });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 401,
      body: { error: 'Unauthorized' },
    });
  });

  it('preserves the control route ceiling through the production bootstrap', async () => {
    const rejected = await gateway.inject({
      method: 'POST',
      url: '/internal/audit/repair',
      headers: { 'content-type': 'application/json', authorization: 'Bearer synthetic-key' },
      payload: jsonPayload(2 * 1024 * 1024),
    });
    expect(rejected.statusCode).toBe(413);
  });
});
