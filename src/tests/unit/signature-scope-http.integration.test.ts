// @vitest-environment node

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { OpenAIChatController } from '@/server/gateway/modules/openai/openai-chat.controller';
import { OpenAIResponsesController } from '@/server/gateway/modules/openai/responses/openai-responses.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import { resolveGeminiSessionScope } from '@/server/gateway/common/signature-session-scope';
import type {
  AnthropicChatRequest,
  OpenAIChatRequest,
} from '@/server/gateway/common/interfaces/request-interfaces';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
  geminiStreamFrame,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock('@/modules/proxy-gateway/opencode-sync/opencode-credentials', () => ({
  openCodeCredentialService: { matches: (token: string) => token === 'synthetic-tenant-b' },
}));
vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
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
    streamFrames: [geminiStreamFrame(geminiTextResponse('Continued after the switch'))],
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
  const lease = createLease([createAccount('acc-1')]);
  const gateway = createGateway(upstream, lease);
  @Module({
    controllers: [
      OpenAIChatController,
      OpenAIResponsesController,
      AnthropicController,
      GeminiController,
    ],
    providers: [
      ProxyGuard,
      { provide: OpenAIOperations, useValue: new OpenAIOperations(gateway.openAIService) },
      { provide: AnthropicService, useValue: gateway.anthropicService },
      { provide: GeminiService, useValue: gateway.geminiService },
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
  return { app, upstream, signatureA, lease };
}

describe('HTTP signature scope admission', () => {
  it.each(['same', 'task', 'session', 'credential'])(
    'restores transient Responses signatures only within the same request scope: %s',
    async (changed) => {
      const { app, upstream, signatureA } = await surface();
      const url = '/v1/responses';
      const headers = {
        authorization: 'Bearer synthetic-tenant-a',
        'x-client-session-id': 'transient-a',
      };
      const input = [{ type: 'message', role: 'user', content: 'Read task A' }];
      const initial = {
        model: 'gemini-3.1-pro-low',
        input,
        store: false,
        tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
      };
      expect(
        (await app.inject({ method: 'POST', url, headers, payload: initial })).statusCode,
      ).toBe(200);
      const nextHeaders = { ...headers };
      if (changed === 'session') {
        nextHeaders['x-client-session-id'] = 'transient-b';
      }
      if (changed === 'credential') {
        setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: 'synthetic-tenant-b' });
        nextHeaders.authorization = 'Bearer synthetic-tenant-b';
      }
      const next = await app.inject({
        method: 'POST',
        url,
        headers: nextHeaders,
        payload: {
          ...initial,
          input: [
            { ...input[0], content: changed === 'task' ? 'Read task B' : 'Read task A' },
            { type: 'function_call', call_id: 'call_reused', name: 'read', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call_reused', output: 'fixture failed' },
          ],
        },
      });
      expect(next.statusCode).toBe(200);
      expect(
        upstream.calls[1]?.body.request.contents
          .flatMap((item) => item.parts)
          .filter((part) => part.functionCall)
          .map((part) => part.thoughtSignature),
      ).toEqual([changed === 'same' ? signatureA : undefined]);
    },
  );

  it('passes native Gemini credential, header and actual query hints to account selection', async () => {
    const { app, lease } = await surface();
    const payload = { contents: [{ role: 'user', parts: [{ text: 'synthetic task' }] }] };
    const url = '/v1beta/models/gemini-3.1-pro-low:generateContent?session_id=query';
    const headers = { authorization: 'Bearer synthetic-tenant-a', 'x-client-session-id': 'header' };
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(200);
    expect(lease.getNextToken.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        sessionKey: resolveGeminiSessionScope(payload, headers, url).affinityKey,
      }),
    );
    lease.getNextToken.mockClear();
    const queryHeaders = { authorization: 'Bearer synthetic-tenant-a' };
    expect(
      (await app.inject({ method: 'POST', url, headers: queryHeaders, payload })).statusCode,
    ).toBe(200);
    expect(lease.getNextToken.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        sessionKey: resolveGeminiSessionScope(payload, queryHeaders, url).affinityKey,
      }),
    );
    expect(resolveGeminiSessionScope(payload, headers, url).affinityKey).not.toBe(
      resolveGeminiSessionScope(payload, queryHeaders, url).affinityKey,
    );
  });
  it.each(['openai', 'anthropic'] as const)(
    'passes header and query ownership to the real %s mapper',
    async (protocol) => {
      const { app, upstream, signatureA } = await surface();
      const openAI: OpenAIChatRequest = {
        model: 'gemini-3.1-pro-low',
        messages: [{ role: 'user', content: 'The identical initial task' }],
        tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
      };
      const anthropic: AnthropicChatRequest = {
        model: 'gemini-3.1-pro-low',
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
      model: 'gemini-3.1-pro-low',
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

describe('HTTP continuation after switching from Gemini to Claude', () => {
  // The original model response is represented by a recognized Gemini-format signature.
  const geminiSignature = Buffer.from([0x12, ...Array<number>(80).fill(0x7f)]).toString('base64');
  const encodedPlaceholder = 'c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=';
  const initial = { contents: [{ role: 'user', parts: [{ text: 'Inspect the workspace' }] }] };
  const readCall = { id: 'call-read', name: 'read_file', args: { path: 'example.txt' } };
  const listCall = { id: 'call-list', name: 'list_files', args: { directory: '.' } };
  const readResult = { id: 'call-read', name: 'read_file', response: { text: 'example contents' } };
  const listResult = { id: 'call-list', name: 'list_files', response: { files: ['example.txt'] } };
  const continuation = {
    contents: [
      ...initial.contents,
      {
        role: 'model',
        parts: [
          { thought: true, text: 'Private Gemini reasoning', thoughtSignature: geminiSignature },
          { thought: true, text: 'Unsigned Gemini reasoning' },
          { text: 'I checked the workspace.', thoughtSignature: geminiSignature },
          {
            functionCall: readCall,
            thoughtSignature: geminiSignature,
            thought_signature: geminiSignature,
          },
          { functionCall: listCall, thought_signature: encodedPlaceholder },
        ],
      },
      {
        role: 'user',
        parts: [{ functionResponse: readResult }, { functionResponse: listResult }],
      },
    ],
  };
  const headers = { authorization: 'Bearer synthetic-tenant-a', 'x-session-id': 'model-switch' };
  const seedUrl = '/v1beta/models/gemini-3-flash:generateContent';

  it.each([
    ['generateContent', 'generateContent', 'generate'],
    ['streamGenerateContent', 'streamGenerateContent', 'stream'],
  ] as const)(
    'preserves tool exchanges from %s to %s after a proven switch',
    async (seedAction, action, kind) => {
      const { app, upstream } = await surface();
      await app.listen(0, '127.0.0.1');
      const origin = await app.getUrl();
      const send = (model: string, method: string, payload: object) =>
        fetch(`${origin}/v1beta/models/${model}:${method}`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5_000),
        });
      const seed = await send('gemini-3-flash', seedAction, initial);
      const seedBody = await seed.text();
      expect(seed.status, seedBody).toBe(200);
      expect(upstream.calls[0]?.body.model).toBe('gemini-3-flash-agent');

      const response = await send('claude-sonnet-4-6', action, continuation);
      const body = await response.text();

      expect(response.status, body).toBe(200);
      expect(upstream.calls).toHaveLength(2);
      expect(upstream.calls[1]).toMatchObject({
        kind,
        body: { model: 'claude-sonnet-4-6-thinking' },
      });
      expect(upstream.calls[1]?.body.request.contents).toEqual([
        ...initial.contents,
        {
          role: 'model',
          parts: [
            { text: 'I checked the workspace.' },
            { functionCall: readCall },
            { functionCall: listCall },
          ],
        },
        {
          role: 'user',
          parts: [{ functionResponse: readResult }, { functionResponse: listResult }],
        },
      ]);
      if (kind === 'stream') {
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const events = body
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => JSON.parse(line.slice(6)));
        expect(events).toEqual([geminiTextResponse('Continued after the switch')]);
      }
    },
  );

  it.each([
    ['another session', { ...headers, 'x-session-id': 'unrelated' }],
    ['another credential', { ...headers, authorization: 'Bearer synthetic-tenant-b' }],
  ] as const)(
    'retains the 400 and does not forward a switch in %s',
    async (_label, requestHeaders) => {
      const { app, upstream } = await surface();
      const seed = await app.inject({ method: 'POST', url: seedUrl, headers, payload: initial });
      expect(seed.statusCode).toBe(200);

      const response = await app.inject({
        method: 'POST',
        url: '/v1beta/models/claude-sonnet-4-6:generateContent',
        headers: requestHeaders,
        payload: continuation,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { message: expect.stringContaining('incompatible with target model family claude') },
      });
      expect(upstream.calls).toHaveLength(1);
    },
  );
});
