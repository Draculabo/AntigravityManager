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
import { OpenAIChatController } from '@/server/gateway/modules/openai/openai-chat.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'schema-object-items-test/1.0',
}));

it('normalizes misplaced object and array keywords through both tool HTTP routes', async () => {
  const upstream = createUpstream({ generate: geminiTextResponse('Ready') });
  const gateway = createGateway(upstream, createLease([createAccount('schema-object-items')]));
  @Module({
    controllers: [GeminiController, OpenAIChatController],
    providers: [
      ProxyGuard,
      { provide: GeminiService, useValue: gateway.geminiService },
      { provide: OpenAIOperations, useValue: new OpenAIOperations(gateway.openAIService) },
    ],
  })
  class SchemaObjectItemsModule {}

  const app = await NestFactory.create<NestFastifyApplication>(
    SchemaObjectItemsModule,
    new FastifyAdapter(),
    { logger: false },
  );
  const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
  const key = 'synthetic-schema-object-items';
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: key });
  const parameters = {
    type: 'object',
    items: { filename: { type: 'string' }, count: { type: 'string' } },
    properties: {
      count: { type: 'integer' },
      offsets: {
        type: 'array',
        items: { type: 'integer' },
        properties: { unexpected: { type: 'string' } },
      },
    },
    required: ['filename'],
  };
  const tool = { name: 'read_files', parameters };
  const expected = {
    type: 'object',
    properties: {
      filename: { type: 'string' },
      count: { type: 'integer' },
      offsets: { type: 'array', items: { type: 'integer' } },
    },
    required: ['filename'],
  };
  try {
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    for (const [route, body] of [
      [
        '/v1/chat/completions',
        {
          model: 'gemini-3-flash',
          messages: [{ role: 'user', content: 'Read a file' }],
          tools: [{ type: 'function', function: tool }],
        },
      ],
      [
        '/v1beta/models/gemini-3-flash:generateContent',
        {
          contents: [{ role: 'user', parts: [{ text: 'Read a file' }] }],
          tools: [{ functionDeclarations: [tool] }],
        },
      ],
    ] as const) {
      const response = await fetch(`${origin}${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      expect(response.status, await response.text()).toBe(200);
    }
    expect(
      upstream.calls.map(
        (call) => call.body.request.tools?.[0]?.functionDeclarations?.[0]?.parameters,
      ),
    ).toEqual([expected, expected]);
  } finally {
    setServerConfig(previous);
    await app.close();
  }
});
