// @vitest-environment node
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import { OpenAIChatController } from '@/server/gateway/modules/openai/openai-chat.controller';
import { OpenAIResponsesController } from '@/server/gateway/modules/openai/responses/openai-responses.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIService } from '@/server/gateway/modules/openai/openai.service';
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
vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'd09-acceptance/1.0',
}));

vi.setConfig({ testTimeout: 15_000 });

type Protocol = 'chat' | 'responses' | 'messages' | 'gemini';
const protocols: Protocol[] = ['chat', 'responses', 'messages', 'gemini'];
const model = 'claude-sonnet-4-6-thinking';
const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const cleanup: Array<() => Promise<void> | void> = [];
const key = 'synthetic-d09-key';
const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
const WireBody = z
  .object({
    model: z.string(),
    request: z
      .object({
        generationConfig: z
          .object({
            maxOutputTokens: z.number().optional(),
            thinkingConfig: z
              .object({
                thinkingBudget: z.number().optional(),
                thinkingLevel: z.string().optional(),
                includeThoughts: z.boolean().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

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

async function fixture(
  options: {
    source?: 'gateway' | 'client';
    gatewayBudget?: number;
    transport?: { kind: 'level'; defaultLevel: 'high' };
    outputCap?: number;
  } = {},
) {
  const seen: z.infer<typeof WireBody>[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      seen.push(WireBody.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      const payload = geminiTextResponse('D09 accepted');
      if (request.url?.includes(':streamGenerateContent')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify(geminiStreamFrame(payload))}\n\n`);
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ response: payload }));
      }
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : 'Invalid fixture request');
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
  const budget = options.gatewayBudget ?? 8192;
  setServerConfig({
    ...DEFAULT_APP_CONFIG.proxy,
    api_key: key,
    model_aliases: [
      { alias: 'claude-3.5-sonnet-d09', target: model, enabled: true },
      { alias: 'claude-4.5-opus-d09', target: model, enabled: true },
      { alias: 'claude-3-5-haiku-d09-*', target: model, enabled: true },
    ],
    thinking_budget: {
      ...DEFAULT_APP_CONFIG.proxy.thinking_budget,
      control_source: options.source ?? 'gateway',
      claude_budget: budget,
      claude_low: budget,
      claude_medium: budget,
      claude_high: budget,
    },
  });
  const lease = Object.assign(createLease([createAccount('d09-synthetic')]), {
    getModelThinkingTransportForAccount: vi.fn(() => options.transport),
    getModelOutputLimitForAccount: vi.fn(() => options.outputCap),
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
  class ThinkingHttpModule {}
  const app = await NestFactory.create<NestFastifyApplication>(
    ThinkingHttpModule,
    new FastifyAdapter(),
    { logger: false },
  );
  cleanup.push(() => app.close());
  await app.listen(0, '127.0.0.1');
  return { base: await app.getUrl(), seen, lease };
}

function requestFor(
  protocol: Protocol,
  options: {
    budget?: number;
    effort?: 'low';
    alias?: string;
    omitGenerationConfig?: boolean;
  } = {},
) {
  const requestedModel = options.alias ?? model;
  if (protocol === 'gemini') {
    return {
      path: `/v1beta/models/${requestedModel}:generateContent`,
      body: {
        contents: [{ role: 'user', parts: [{ text: 'Reply briefly' }] }],
        ...(options.omitGenerationConfig
          ? {}
          : {
              generationConfig: {
                maxOutputTokens: 20000,
                ...(options.budget !== undefined
                  ? { thinkingConfig: { thinkingBudget: options.budget, includeThoughts: true } }
                  : {}),
                ...(options.effort
                  ? { thinkingConfig: { thinkingLevel: options.effort, includeThoughts: true } }
                  : {}),
              },
            }),
      },
    };
  }
  if (protocol === 'responses') {
    return {
      path: '/v1/responses',
      body: {
        model: requestedModel,
        input: 'Reply briefly',
        store: false,
        max_output_tokens: 20000,
        ...(options.budget !== undefined ? { reasoning: { max_tokens: options.budget } } : {}),
        ...(options.effort ? { reasoning: { effort: options.effort } } : {}),
      },
    };
  }
  return {
    path: protocol === 'chat' ? '/v1/chat/completions' : '/v1/messages',
    body: {
      model: requestedModel,
      max_tokens: 20000,
      messages: [{ role: 'user', content: 'Reply briefly' }],
      ...(options.budget !== undefined
        ? { thinking: { type: 'enabled', budget_tokens: options.budget } }
        : {}),
      ...(options.effort
        ? protocol === 'chat'
          ? { reasoning_effort: options.effort }
          : { output_config: { effort: options.effort } }
        : {}),
    },
  };
}

async function send(
  base: string,
  protocol: Protocol,
  options: Parameters<typeof requestFor>[1] = {},
) {
  const request = requestFor(protocol, options);
  const response = await fetch(`${base}${request.path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.text() };
}

it.each(protocols)(
  '%s applies the saved Gateway budget to the actual upstream request',
  async (protocol) => {
    const { base, seen } = await fixture();
    const reply = await send(base, protocol, { omitGenerationConfig: protocol === 'gemini' });
    expect(reply.status, reply.body).toBe(200);
    expect(
      seen.map((entry) => ({
        model: entry.model,
        thinking: entry.request.generationConfig?.thinkingConfig,
      })),
    ).toEqual([{ model, thinking: { includeThoughts: true, thinkingBudget: 8192 } }]);
  },
);

it.each(protocols.flatMap((protocol) => [0, -1].map((budget) => ({ protocol, budget }))))(
  '$protocol preserves explicit Client budget $budget',
  async ({ protocol, budget }) => {
    const { base, seen } = await fixture({ source: 'client' });
    const reply = await send(base, protocol, { budget });
    expect(reply.status, reply.body).toBe(200);
    expect(
      seen.map((entry) => ({
        model: entry.model,
        thinking: entry.request.generationConfig?.thinkingConfig,
      })),
    ).toEqual([{ model, thinking: { includeThoughts: budget !== 0, thinkingBudget: budget } }]);
  },
);

it.each(protocols)(
  '%s emits only the provider-declared level and enforces the account output cap',
  async (protocol) => {
    const { base, seen } = await fixture({
      gatewayBudget: -1,
      transport: { kind: 'level', defaultLevel: 'high' },
      outputCap: 4096,
    });
    const reply = await send(base, protocol, { omitGenerationConfig: protocol === 'gemini' });
    expect(reply.status, reply.body).toBe(200);
    expect(
      seen.map((entry) => ({
        model: entry.model,
        output: entry.request.generationConfig?.maxOutputTokens,
        thinking: entry.request.generationConfig?.thinkingConfig,
      })),
    ).toEqual([
      { model, output: 4096, thinking: { includeThoughts: true, thinkingLevel: 'HIGH' } },
    ]);
  },
);

it.each(protocols)(
  '%s preserves a supported explicit Client level without a numeric budget',
  async (protocol) => {
    const { base, seen } = await fixture({
      source: 'client',
      transport: { kind: 'level', defaultLevel: 'high' },
    });
    const reply = await send(base, protocol, { effort: 'low' });
    expect(reply.status, reply.body).toBe(200);
    expect(seen.map((entry) => entry.request.generationConfig?.thinkingConfig)).toEqual([
      { includeThoughts: true, thinkingLevel: 'LOW' },
    ]);
  },
);

it.each(
  protocols.flatMap((protocol) =>
    (['gateway', 'client'] as const).map((source) => ({ protocol, source })),
  ),
)(
  '$protocol rejects an explicit $source numeric budget for a level-only model before sending',
  async ({ protocol, source }) => {
    const { base, seen, lease } = await fixture({
      source,
      transport: { kind: 'level', defaultLevel: 'high' },
    });
    const reply = await send(base, protocol, source === 'client' ? { budget: 8192 } : {});
    expect(reply.status, reply.body).toBe(400);
    expect(seen).toEqual([]);
    expect(lease.penalties).toEqual([]);
  },
);

it.each(protocols)(
  '%s retains hard output and thinking bounds after the configured budget is applied',
  async (protocol) => {
    const { base, seen } = await fixture({ outputCap: 4096 });
    const reply = await send(base, protocol);
    expect(reply.status, reply.body).toBe(200);
    expect(
      seen.map((entry) => ({
        model: entry.model,
        output: entry.request.generationConfig?.maxOutputTokens,
        thinking: entry.request.generationConfig?.thinkingConfig,
      })),
    ).toEqual([{ model, output: 4096, thinking: { includeThoughts: true, thinkingBudget: 3072 } }]);
  },
);

it.each(['claude-3.5-sonnet-d09', 'claude-4-5-opus-d09', 'claude-3-5-haiku-d09-fixture'])(
  'maps the retired-shaped alias %s before sending its valid physical target',
  async (alias) => {
    const { base, seen } = await fixture();
    const reply = await send(base, 'chat', { alias });
    expect(reply.status, reply.body).toBe(200);
    expect(
      seen.map((entry) => ({
        model: entry.model,
        thinking: entry.request.generationConfig?.thinkingConfig,
      })),
    ).toEqual([{ model, thinking: { includeThoughts: true, thinkingBudget: 8192 } }]);
  },
);

it.runIf(Boolean(process.env.AGM_D09_CURL_EXE))(
  'uses the configured budget through the installed curl client',
  async () => {
    const executable = process.env.AGM_D09_CURL_EXE;
    if (!executable) {
      throw new Error('Expected the installed curl path');
    }
    const { base, seen } = await fixture();
    const request = requestFor('chat');
    const { stdout } = await promisify(execFile)(
      executable,
      [
        '-q',
        '--noproxy',
        '*',
        '--fail-with-body',
        '--silent',
        '--show-error',
        '-H',
        `Authorization: Bearer ${key}`,
        '-H',
        'Content-Type: application/json',
        '--data-binary',
        JSON.stringify(request.body),
        `${base}${request.path}`,
      ],
      { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      choices: [{ message: { content: 'D09 accepted' } }],
    });
    expect(
      seen.map((entry) => ({
        model: entry.model,
        thinking: entry.request.generationConfig?.thinkingConfig,
      })),
    ).toEqual([{ model, thinking: { includeThoughts: true, thinkingBudget: 8192 } }]);
  },
);
