// @vitest-environment node

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import type { GeminiRequest } from '@/server/gateway/common/interfaces/request-interfaces';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
  geminiStreamFrame,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'tool-name-repair-fixture',
}));

it.each(['generateContent', 'streamGenerateContent'] as const)(
  'repairs only explicitly associated unknown names through Gemini HTTP %s',
  async (action) => {
    const upstream = createUpstream({
      generate: geminiTextResponse('Ready'),
      streamFrames: [geminiStreamFrame(geminiTextResponse('Ready'))],
    });
    const lease = createLease([createAccount('tool-name-repair')]);
    const gateway = createGateway(upstream, lease);
    @Module({
      controllers: [GeminiController],
      providers: [ProxyGuard, { provide: GeminiService, useValue: gateway.geminiService }],
    })
    class ToolNameRepairModule {}
    const app = await NestFactory.create<NestFastifyApplication>(
      ToolNameRepairModule,
      new FastifyAdapter(),
      { logger: false },
    );
    const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
    const key = 'synthetic-tool-name-repair';
    setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: key });
    const request: GeminiRequest = {
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'read-id', name: 'read_file', args: { path: '/fixture' } } },
            { functionCall: { id: 'write-id', name: 'write_file', args: { path: '/other' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'write-id',
                name: 'unknown',
                response: { error: 'denied', count: 0 },
              },
            },
            {
              functionResponse: { id: 'read-id', name: 'unknown', response: { result: 'fixture' } },
            },
          ],
        },
      ],
    };
    try {
      await app.listen(0, '127.0.0.1');
      const origin = await app.getUrl();
      const send = (body: GeminiRequest) =>
        fetch(`${origin}/v1beta/models/gemini-3-flash:${action}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
      const response = await send(request);
      expect(response.status, await response.text()).toBe(200);
      expect(upstream.calls).toHaveLength(1);
      expect(upstream.calls[0]?.body.request.contents[1]?.parts).toEqual([
        {
          functionResponse: {
            id: 'write-id',
            name: 'write_file',
            response: { error: 'denied', count: 0 },
          },
        },
        { functionResponse: { id: 'read-id', name: 'read_file', response: { result: 'fixture' } } },
      ]);
      const selectionCount = lease.getNextToken.mock.calls.length;
      for (const result of [
        { id: 'read-id', name: 'write_file' },
        { id: 'orphan', name: 'unknown' },
        { name: 'unknown' },
      ]) {
        const invalid: GeminiRequest = {
          contents: [
            request.contents[0],
            {
              role: 'user',
              parts: [{ functionResponse: { ...result, response: { result: 'fixture' } } }],
            },
          ],
        };
        const rejected = await send(invalid);
        expect(rejected.status, await rejected.text()).toBe(400);
      }
      expect(upstream.calls).toHaveLength(1);
      expect(lease.getNextToken).toHaveBeenCalledTimes(selectionCount);
      expect(request.contents[1]?.parts[0]?.functionResponse?.name).toBe('unknown');
    } finally {
      setServerConfig(previous);
      await app.close();
    }
  },
);
