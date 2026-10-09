import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { ProxyGuard } from '@/modules/proxy-gateway/server/guards/proxy.guard';
import { OpenAIChatController } from '@/modules/proxy-gateway/server/modules/openai/openai-chat.controller';
import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
import { AnthropicService } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.service';
import type {
  AnthropicChatRequest,
  OpenAIChatRequest,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: (token: string) => token === 'synthetic-tenant-b' },
}));
vi.mock('@/modules/proxy-gateway/server/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'signature-http-test/1.0',
}));

const previousConfig = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const apps: NestFastifyApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  SignatureStore.clear();
  setServerConfig(previousConfig);
});

async function surface() {
  let generation = 0;
  const signatureA = 'synthetic-http-signature-a';
  const upstream = createUpstream({
    generate: () => ({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: { id: 'call_reused', name: 'read', args: {} },
                thoughtSignature:
                  ++generation === 1 ? signatureA : 'synthetic-http-signature-b'.repeat(2),
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    }),
  });
  const gateway = createGateway(upstream, createLease([createAccount('acc-1')]));
  @Module({
    controllers: [OpenAIChatController, AnthropicController],
    providers: [
      ProxyGuard,
      { provide: OpenAIOperations, useValue: new OpenAIOperations(gateway.openAIService) },
      { provide: AnthropicService, useValue: gateway.anthropicService },
    ],
  })
  class SignatureHttpModule {}
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: 'synthetic-tenant-a' });
  const app = await NestFactory.create<NestFastifyApplication>(
    SignatureHttpModule,
    new FastifyAdapter(),
    { logger: false },
  );
  apps.push(app);
  await app.init();
  return { app, upstream, signatureA };
}

describe('HTTP signature scope admission', () => {
  it.each(['openai', 'anthropic'] as const)(
    'passes header and query ownership to the real %s mapper',
    async (protocol) => {
      const { app, upstream, signatureA } = await surface();
      const openAI: OpenAIChatRequest = {
        model: 'gemini-pro-agent',
        messages: [{ role: 'user', content: 'The identical initial task' }],
        tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      };
      const anthropic: AnthropicChatRequest = {
        model: 'gemini-pro-agent',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'The identical initial task' }],
        tools: [{ name: 'read', input_schema: { type: 'object' } }],
      };
      const url = protocol === 'openai' ? '/v1/chat/completions' : '/v1/messages';
      const initial = protocol === 'openai' ? openAI : anthropic;
      const headersA = {
        authorization: 'Bearer synthetic-tenant-a',
        'x-client-session-id': 'session-a',
      };
      const headersB = {
        authorization: 'Bearer synthetic-tenant-a',
        'x-client-session-id': 'session-b',
      };
      expect(
        (await app.inject({ method: 'POST', url, headers: headersA, payload: initial })).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ method: 'POST', url, headers: headersB, payload: initial })).statusCode,
      ).toBe(200);
      const continuation =
        protocol === 'openai'
          ? {
              ...openAI,
              messages: [
                ...openAI.messages,
                {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_reused',
                      type: 'function',
                      function: { name: 'read', arguments: '{}' },
                    },
                  ],
                },
                { role: 'tool', tool_call_id: 'call_reused', content: 'fixed result' },
              ],
            }
          : {
              ...anthropic,
              messages: [
                ...anthropic.messages,
                {
                  role: 'assistant',
                  content: [{ type: 'tool_use', id: 'call_reused', name: 'read', input: {} }],
                },
                {
                  role: 'user',
                  content: [
                    { type: 'tool_result', tool_use_id: 'call_reused', content: 'fixed result' },
                  ],
                },
              ],
            };
      // Equivalent query/body hints refer to the same scope as the initial header hint.
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${url}?session_id=session-a`,
            headers: { authorization: 'Bearer synthetic-tenant-a' },
            payload: continuation,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        upstream.calls[2]?.body.request.contents
          .flatMap((content) => content.parts)
          .filter((part) => part.functionCall)
          .map((part) => part.thoughtSignature),
      ).toEqual([signatureA]);
    },
  );

  it('isolates accepted proxy credentials with the same task and session hint', async () => {
    const { app, upstream, signatureA } = await surface();
    const request: OpenAIChatRequest = {
      model: 'gemini-pro-agent',
      messages: [{ role: 'user', content: 'The identical tenant task' }],
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    };
    const url = '/v1/chat/completions';
    for (const tenant of ['a', 'b']) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            payload: request,
            headers: {
              authorization: `Bearer synthetic-tenant-${tenant}`,
              'x-session-id': 'shared',
            },
          })
        ).statusCode,
      ).toBe(200);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: {
            ...request,
            messages: [
              ...request.messages,
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_reused',
                    type: 'function',
                    function: { name: 'read', arguments: '{}' },
                  },
                ],
              },
              { role: 'tool', tool_call_id: 'call_reused', content: 'tenant A result' },
            ],
          },
          headers: { authorization: 'Bearer synthetic-tenant-a', 'x-session-id': 'shared' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      upstream.calls[2]?.body.request.contents
        .flatMap((content) => content.parts)
        .filter((part) => part.functionCall)
        .map((part) => part.thoughtSignature),
    ).toEqual([signatureA]);
  });
});
