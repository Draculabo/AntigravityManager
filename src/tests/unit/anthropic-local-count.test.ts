import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { createGateway, createLease, createUpstream } from './proxy-real-path.harness';
import { PIXEL_PNG } from '../fixtures/image-content';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));
vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'antigravity-local-count-fixture',
}));

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const apps: NestFastifyApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  setServerConfig(previous);
});
const payload = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Count this input.' }],
};
async function fixture() {
  const upstream = createUpstream({
    countTokens: () => {
      throw new Error('Local counting must not call the provider');
    },
  });
  const lease = createLease([]);
  const service = createGateway(upstream, lease).anthropicService;
  const count = vi.spyOn(service, 'handleAnthropicCountTokensWithSource');
  @Module({
    controllers: [AnthropicController],
    providers: [ProxyGuard, { provide: AnthropicService, useValue: service }],
  })
  class CountModule {}
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: 'synthetic-local-count-key' });
  const app = await NestFactory.create<NestFastifyApplication>(CountModule, new FastifyAdapter(), {
    logger: false,
  });
  apps.push(app);
  await app.init();
  return { app, count, lease, upstream };
}
const headers = { authorization: 'Bearer synthetic-local-count-key' };

describe('Anthropic local count HTTP contract', () => {
  it('returns a local count with no available provider account or upstream request', async () => {
    const f = await fixture();
    const reply = await f.app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers,
      payload,
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['x-agm-count-tokens-source']).toBe('estimated');
    expect(reply.headers['x-agm-count-tokens-reason']).toBe('anthropic-local');
    expect(reply.json()).toEqual({ input_tokens: expect.any(Number) });
    expect(reply.json().input_tokens).toBeGreaterThan(0);
    expect(f.lease.getNextToken).not.toHaveBeenCalled();
    expect(f.upstream.countTokensInternal).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Bearer wrong-key'])(
    'denies %s before local estimation',
    async (authorization) => {
      const f = await fixture();
      const reply = await f.app.inject({
        method: 'POST',
        url: '/v1/messages/count_tokens',
        headers: authorization ? { authorization } : {},
        payload,
      });
      expect(reply.statusCode).toBe(401);
      expect(f.count).not.toHaveBeenCalled();
      expect(f.upstream.countTokensInternal).not.toHaveBeenCalled();
    },
  );

  it('keeps malformed media admission ahead of local success', async () => {
    const f = await fixture();
    const reply = await f.app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers,
      payload: {
        ...payload,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQ==' } },
            ],
          },
        ],
      },
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
    expect(f.lease.getNextToken).not.toHaveBeenCalled();
    expect(f.upstream.countTokensInternal).not.toHaveBeenCalled();
  });

  it('counts submitted historical images independently of the generation send window', async () => {
    const f = await fixture();
    const input = {
      ...payload,
      messages: [
        {
          role: 'user',
          content: [0, 1].map(() => ({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: PIXEL_PNG.toString('base64') },
          })),
        },
        { role: 'assistant', content: 'Received both.' },
        { role: 'user', content: 'Compare both.' },
      ],
    };
    const before = await f.app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers,
      payload: input,
    });
    setServerConfig({
      ...DEFAULT_APP_CONFIG.proxy,
      api_key: 'synthetic-local-count-key',
      image_scheduler: {
        ...DEFAULT_APP_CONFIG.proxy.image_scheduler,
        send_window_enabled: true,
        send_window_count: 1,
      },
    });
    const after = await f.app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers,
      payload: input,
    });
    expect({ status: after.statusCode, body: after.json() }).toEqual({
      status: before.statusCode,
      body: before.json(),
    });
    expect(before.statusCode).toBe(200);
    expect(f.upstream.countTokensCalls).toEqual([]);
  });
});
