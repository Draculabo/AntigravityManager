import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
import { AnthropicService } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.service';
import { OpenAIChatController } from '@/modules/proxy-gateway/server/modules/openai/openai-chat.controller';
import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { OpenAIService } from '@/modules/proxy-gateway/server/modules/openai/openai.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
import {
  registerTrafficAuditHttpHooks,
  TrafficAuditContextInterceptor,
  startCurrentUpstreamAttempt,
  completeCurrentUpstreamAttempt,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';

const audit = vi.hoisted(() => ({ completeParent: vi.fn() }));
vi.mock('@/modules/proxy-gateway/audit/traffic-audit.service', () => ({
  trafficAuditService: {
    startParent: () => ({ id: 'parent', startedAt: 1, trafficClass: 'model' }),
    startAttempt: () => null,
    completeAttempt: vi.fn(),
    completeParent: audit.completeParent,
    beginParentSse: () => null,
  },
}));
vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));

const apps: NestFastifyApplication[] = [];
const previous = getServerConfig();
const message = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'test',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};
const headers = { authorization: 'Bearer synthetic-fallback-key' };

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  setServerConfig(previous ?? DEFAULT_APP_CONFIG.proxy);
  audit.completeParent.mockClear();
});

async function createApp(failed: boolean, upstreamMessage = 'Agent Platform API is disabled') {
  @Module({
    controllers: [AnthropicController, OpenAIChatController],
    providers: [
      ProxyGuard,
      OpenAIOperations,
      {
        provide: AnthropicService,
        useValue: {
          handleAnthropicMessages: async (request: { stream?: boolean }) => {
            const cache = startCurrentUpstreamAttempt({
              endpoint: 'https://example.test/cache',
              operation: 'create-context-cache',
            });
            completeCurrentUpstreamAttempt(cache, {
              outcome: failed ? 'upstream_error' : 'completed',
              status: failed ? 403 : 200,
            });
            const generation = startCurrentUpstreamAttempt({
              endpoint: 'https://example.test/generate',
              operation: 'generate',
            });
            completeCurrentUpstreamAttempt(generation, { outcome: 'completed', status: 200 });
            return request.stream
              ? of('event: message_stop\ndata: {"type":"message_stop"}\n\n')
              : message;
          },
        },
      },
      {
        provide: OpenAIService,
        useValue: {
          handleChatCompletions: async () => {
            throw new UpstreamRequestError({
              message: upstreamMessage,
              status: 403,
              body: JSON.stringify({
                error: {
                  message: upstreamMessage,
                  details: [{ reason: 'SERVICE_DISABLED' }],
                },
              }),
            });
          },
        },
      },
    ],
  })
  class FallbackTestModule {}
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: 'synthetic-fallback-key' });
  const adapter = new FastifyAdapter();
  registerTrafficAuditHttpHooks(adapter.getInstance());
  const app = await NestFactory.create<NestFastifyApplication>(FallbackTestModule, adapter, {
    logger: false,
  });
  apps.push(app);
  app.useGlobalInterceptors(new TrafficAuditContextInterceptor());
  await app.init();
  return app;
}

describe('fallback diagnostics through HTTP entry points', () => {
  it.each([false, true])('returns Anthropic recovery headers (stream: %s)', async (stream) => {
    const app = await createApp(true);
    const reply = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers,
      payload: {
        model: 'test',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 16,
        stream,
      },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['x-antigravity-attempts']).toBe('2');
    expect(reply.headers['x-antigravity-fallback']).toBe('true');
    expect(stream ? reply.body : reply.json()).toEqual(
      stream ? 'event: message_stop\ndata: {"type":"message_stop"}\n\n' : message,
    );
  });

  it('does not claim fallback when both upstream operations succeeded', async () => {
    const app = await createApp(false);
    const reply = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers,
      payload: { model: 'test', messages: [{ role: 'user', content: 'hello' }], max_tokens: 16 },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.headers['x-antigravity-fallback']).toBeUndefined();
  });

  it('classifies a controller-handled SERVICE_DISABLED response using its emitted body', async () => {
    const app = await createApp(false);
    const reply = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers,
      payload: { model: 'test', prompt: 'hello' },
    });
    expect(reply.statusCode).toBe(403);
    expect(reply.json()).toEqual({
      error: { message: 'Agent Platform API is disabled', type: 'server_error' },
    });
    expect(audit.completeParent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'upstream_error', status: 403 }),
    );
  });

  it('keeps a controller-handled credential rejection classified as authentication failure', async () => {
    const app = await createApp(false, 'Invalid credentials');
    const reply = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers,
      payload: { model: 'test', prompt: 'hello' },
    });
    expect(reply.statusCode).toBe(403);
    expect(reply.json()).toEqual({
      error: { message: 'Invalid credentials', type: 'server_error' },
    });
    expect(audit.completeParent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'auth_failed', status: 403 }),
    );
  });
});
