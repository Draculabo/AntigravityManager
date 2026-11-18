// @vitest-environment node
import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';
import { gzipSync } from 'node:zlib';
import { of } from 'rxjs';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFastifyAdapter } from '@/server/main';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { AdminGuard } from '@/server/gateway/guards/admin.guard';
import { extractApiKeyToken } from '@/server/gateway/guards/api-key-auth.util';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import { GeminiFilesController } from '@/server/gateway/modules/files/gemini-files.controller';
import { FilesService } from '@/server/gateway/modules/files/files.service';
import type { StoredFileRecord } from '@/server/gateway/modules/files/file-store.types';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import {
  resolveGeminiSessionScope,
  tenantIdentity,
} from '@/server/gateway/common/signature-session-scope';
import { resolveThoughtSession } from '@/modules/proxy-gateway/audit/traffic-audit-http-metadata';
import { attachOpenAIResponsesWebSocketServer } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.server';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: () => false },
}));

const configuredKey = 'd23-synthetic/key+value';
const keyQuery = `key=${encodeURIComponent(configuredKey)}`;
const content = { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] };
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const apps: NestFastifyApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  setServerConfig(previous);
});

@Controller()
class OtherDialectController {
  @Get('v1/models')
  @UseGuards(ProxyGuard)
  openAI() {
    return { accepted: true };
  }

  @Get('internal/d23-control')
  @UseGuards(AdminGuard)
  admin() {
    return { accepted: true };
  }
}

async function createSurface() {
  const generated = {
    candidates: [
      { content: { role: 'model', parts: [{ text: 'accepted' }] }, finishReason: 'STOP' },
    ],
  };
  const generate = vi.fn(async () => generated);
  const record: StoredFileRecord = {
    id: '0'.repeat(32),
    sha256: '0'.repeat(64),
    sizeBytes: 5,
    mimeType: 'text/plain',
    displayName: 'fixture.txt',
    createTimeMs: 1,
    updateTimeMs: 1,
    expireTimeMs: 1000,
  };
  const create = vi.fn(async () => record);
  @Module({
    controllers: [GeminiController, GeminiFilesController, OtherDialectController],
    providers: [
      ProxyGuard,
      AdminGuard,
      { provide: GeminiService, useValue: { handleGeminiGenerateContent: generate } },
      { provide: FilesService, useValue: { create } },
      {
        provide: AccountLeaseService,
        useValue: {
          getAllRawQuotaModels: () => new Set(['gemini-2.5-flash']),
          getAllCollectedModels: () => new Set(['gemini-2.5-flash']),
        },
      },
    ],
  })
  class QueryCredentialModule {}
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    api_key: configuredKey,
    only_raw_quota_models: true,
  });
  const adapter = createFastifyAdapter();
  adapter
    .getInstance()
    .addContentTypeParser(
      /^(?:application|audio|font|image|model|text|video)\//u,
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );
  const seen: Array<ReturnType<typeof identities>> = [];
  // Matches audit registration order: observer is installed after adapter ingress.
  adapter.getInstance().addHook('onRequest', async (request) => {
    seen.push(identities(request));
  });
  const app = await NestFactory.create<NestFastifyApplication>(QueryCredentialModule, adapter, {
    logger: false,
  });
  apps.push(app);
  await app.init();
  return { app, adapter, seen, generate, create, generated };
}

function identities(request: FastifyRequest) {
  return {
    url: request.url,
    tenant: tenantIdentity(request.headers),
    thought: resolveThoughtSession(request).key,
    scope: resolveGeminiSessionScope(content, request.headers, request.url),
  };
}

describe('Gemini query credentials at the production HTTP ingress', () => {
  it('authenticates model list, retrieval and generation without changing the original URL', async () => {
    const { app, seen, generate } = await createSurface();
    for (const path of ['/v1beta/models', '/v1beta/models/gemini-2.5-flash']) {
      const reply = await app.inject({ url: `${path}?${keyQuery}` });
      expect(reply.statusCode).toBe(200);
      expect(seen.at(-1)?.url).toBe(`${path}?${keyQuery}`);
    }
    const reply = await app.inject({
      method: 'POST',
      url: `/v1beta/models/gemini-2.5-flash:generateContent?${keyQuery}`,
      payload: content,
    });
    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 200,
      body: {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'accepted' }] },
            finishReason: 'STOP',
            index: 0,
          },
        ],
      },
    });
    expect(generate).toHaveBeenCalledOnce();
  });

  it('uses the same credential identity before audit, generation and cache preparation', async () => {
    const { app, seen } = await createSurface();
    const session = { 'x-session-id': 'stable-d23-session' };
    await app.inject({
      url: '/v1beta/models',
      headers: { ...session, 'x-goog-api-key': configuredKey },
    });
    await app.inject({ url: `/v1beta/models?${keyQuery}`, headers: session });
    await app.inject({ url: '/v1beta/models?key=another-client', headers: session });
    const [header, query, other] = seen;
    expect({ tenant: query.tenant, thought: query.thought, scope: query.scope }).toEqual({
      tenant: header.tenant,
      thought: header.thought,
      scope: header.scope,
    });
    expect(other.tenant).not.toBe(query.tenant);
    expect(other.thought).not.toBe(query.thought);
    expect(other.scope.storeKey).not.toBe(query.scope.storeKey);
    const identityKeys = seen.map(({ tenant, thought, scope }) => ({ tenant, thought, scope }));
    expect(JSON.stringify(identityKeys)).not.toContain(configuredKey);
    expect(JSON.stringify(identityKeys)).not.toContain('another-client');
  });

  it('keeps validly formatted Header credentials authoritative even when query is correct', async () => {
    const { app } = await createSurface();
    const invalid = await app.inject({
      url: `/v1beta/models?${keyQuery}`,
      headers: { authorization: 'Bearer wrong-header' },
    });
    expect(invalid.statusCode).toBe(401);
    const valid = await app.inject({
      url: '/v1beta/models?key=wrong&key=duplicate',
      headers: { 'x-api-key': configuredKey },
    });
    expect(valid.statusCode).toBe(200);
  });

  it.each(['key=wrong', 'key=', 'key=%20%20', 'not-key=anything'])(
    'preserves Gemini 401 for missing or incorrect credentials: %s',
    async (query) => {
      const { app, generate } = await createSurface();
      const reply = await app.inject({ url: `/v1beta/models?${query}` });
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 401,
        body: {
          error: { code: 401, message: 'API key validation failed', status: 'UNAUTHENTICATED' },
        },
      });
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it('rejects repeated query keys before a handler in the Gemini error dialect', async () => {
    const { app, generate } = await createSurface();
    const reply = await app.inject({ url: `/v1beta/models?${keyQuery}&key=second-secret` });
    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 400,
      body: {
        error: {
          code: 400,
          message: 'The key query parameter must occur only once.',
          status: 'INVALID_ARGUMENT',
        },
      },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('normalizes before gzip admission and rejects unauthorized compressed input before decoding', async () => {
    const { app, generate } = await createSurface();
    const url = `/v1beta/models/gemini-2.5-flash:generateContent?${keyQuery}`;
    const good = await app.inject({
      method: 'POST',
      url,
      payload: gzipSync(JSON.stringify(content)),
      headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
    });
    expect(good.statusCode).toBe(200);
    expect(generate).toHaveBeenCalledOnce();
    const bad = await app.inject({
      method: 'POST',
      url: url.replace(keyQuery, 'key=wrong'),
      payload: Buffer.from('not gzip'),
      headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({
      error: { code: 401, message: 'API key validation failed', status: 'UNAUTHENTICATED' },
    });
    expect(generate).toHaveBeenCalledOnce();
  });

  it('authenticates the actual Gemini upload adapter before file-store writes', async () => {
    const { app, create } = await createSurface();
    const good = await app.inject({
      method: 'POST',
      url: `/upload/v1beta/files?uploadType=media&${keyQuery}`,
      payload: Buffer.from('hello'),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().file.name).toBe(`files/${'0'.repeat(32)}`);
    expect(create).toHaveBeenCalledExactlyOnceWith({
      bytes: Buffer.from('hello'),
      declaredMimeType: 'application/octet-stream',
      displayName: undefined,
    });
    const bad = await app.inject({
      method: 'POST',
      url: '/upload/v1beta/files?uploadType=media&key=wrong',
      payload: Buffer.from('hello'),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(bad.statusCode).toBe(401);
    expect(create).toHaveBeenCalledOnce();
  });

  it.each(['/v1/models', '/internal/d23-control'])(
    'does not add query authentication to %s',
    async (path) => {
      const { app } = await createSurface();
      expect((await app.inject({ url: `${path}?${keyQuery}` })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            url: `${path}?key=duplicate&key=other`,
            headers: { authorization: `Bearer ${configuredKey}` },
          })
        ).statusCode,
      ).toBe(200);
    },
  );

  it('does not admit query-only credentials through the production Responses WebSocket upgrade', async () => {
    const { app } = await createSurface();
    const streamRequest = vi.fn(async () => of());
    const detach = attachOpenAIResponsesWebSocketServer(app.getHttpServer(), {
      isAuthorized: (request) => extractApiKeyToken(request.headers) === configuredKey,
      streamRequest,
    });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected isolated TCP listener');
    }
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses?${keyQuery}`);
    try {
      const status = await new Promise<number>((resolve, reject) => {
        socket.once('unexpected-response', (_request, reply) => {
          reply.resume();
          resolve(reply.statusCode ?? 0);
        });
        socket.once('open', () => reject(new Error('Query-only upgrade unexpectedly succeeded')));
        socket.once('error', reject);
      });
      expect(status).toBe(401);
      expect(streamRequest).not.toHaveBeenCalled();
    } finally {
      socket.terminate();
      detach();
    }
  });
});
