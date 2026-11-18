// @vitest-environment node

import { createServer, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { ProxyGuard } from '@/server/gateway/guards/proxy.guard';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import { OpenAIChatController } from '@/server/gateway/modules/openai/openai-chat.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIResponsesController } from '@/server/gateway/modules/openai/responses/openai-responses.controller';
import { OpenAIResponsesSessionService } from '@/server/gateway/modules/openai/responses/openai-responses-session.service';
import { Upstream4xxCaptureService } from '@/server/gateway/common/upstream-4xx-capture.service';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<object>()),
  resolveRequestUserAgent: async () => 'interrupted-stream-http-test/1.0',
  buildContentRequestUserAgent: () => 'interrupted-stream-http-test/1.0',
}));

const previousConfig = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
const fixtureText = '```typescript\nconst answer = 42;\n';
const outputCandidates = z.array(
  z.object({
    content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }).optional(),
  }),
);
const outputEvent = z.object({
  type: z.string().optional(),
  delta: z.union([z.string(), z.object({ text: z.string().optional() })]).optional(),
  choices: z.array(z.object({ delta: z.object({ content: z.string().optional() }) })).optional(),
  candidates: outputCandidates.optional(),
  response: z.object({ candidates: outputCandidates.optional() }).optional(),
});
const cases = [
  ['chat', 'text', 'eof'],
  ['chat', 'tool', 'eof'],
  ['messages', 'text', 'eof'],
  ['messages', 'tool', 'eof'],
  ['gemini', 'text', 'eof'],
  ['gemini', 'tool', 'eof'],
  ['responses', 'text', 'eof'],
  ['responses', 'tool', 'eof'],
  ['chat', 'text', 'reset'],
  ['chat', 'tool', 'reset'],
  ['messages', 'text', 'reset'],
  ['messages', 'tool', 'reset'],
  ['gemini', 'text', 'reset'],
  ['gemini', 'tool', 'reset'],
  ['responses', 'text', 'reset'],
  ['responses', 'tool', 'reset'],
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setServerConfig(previousConfig);
});

it.each(cases)(
  'preserves interrupted %s %s output after upstream %s across HTTP boundaries',
  async (protocol, kind, ending) => {
    const part =
      kind === 'text'
        ? { text: fixtureText }
        : { functionCall: { id: 'call-http', name: 'read_file', args: { path: '/fixture' } } };
    const payload = {
      response: {
        candidates: [{ content: { role: 'model', parts: [part] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      },
    };
    const requests: string[] = [];
    let upstreamResponse: ServerResponse | undefined;
    const server = createServer((request, response) => {
      upstreamResponse = response;
      requests.push(request.url ?? '');
      request.resume();
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = `data: ${JSON.stringify(payload)}\n\n`;
      if (ending === 'eof') {
        response.end(frame);
      } else {
        response.write(frame);
      }
    });
    const client = new GeminiClient(new Upstream4xxCaptureService());
    const upstream = createUpstream({});
    upstream.streamGenerateInternal.mockImplementation(async (...args) => {
      const stream = await client.streamGenerateInternal(...args);
      if (!(stream instanceof Readable)) {
        throw new Error('Expected a Node upstream stream');
      }
      return stream;
    });
    const lease = createLease([createAccount('interrupted-stream-http')]);
    const gateway = createGateway(upstream, lease);
    const store = new OpenAIResponsesSessionService({});
    const operations = new OpenAIOperations(gateway.openAIService, undefined, undefined, store);
    @Module({
      controllers: [
        OpenAIChatController,
        OpenAIResponsesController,
        AnthropicController,
        GeminiController,
      ],
      providers: [
        ProxyGuard,
        { provide: OpenAIOperations, useValue: operations },
        { provide: AnthropicService, useValue: gateway.anthropicService },
        { provide: GeminiService, useValue: gateway.geminiService },
      ],
    })
    class InterruptedStreamModule {}

    let app: NestFastifyApplication | undefined;
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), 5_000);
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected isolated loopback listener');
      }
      vi.stubEnv('PROXY_INTERNAL_BASE_URLS', `http://127.0.0.1:${address.port}`);
      vi.stubEnv('PROXY_CONTEXT_CACHE_ENABLED', 'false');
      for (const name of [
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'ALL_PROXY',
        'http_proxy',
        'https_proxy',
        'all_proxy',
      ]) {
        vi.stubEnv(name, '');
      }
      const originalPost = axios.post.bind(axios);
      vi.spyOn(axios, 'post').mockImplementation((url, data, config) =>
        originalPost(url, data, { ...config, adapter: 'http' }),
      );
      const key = 'synthetic-interrupted-stream';
      setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, api_key: key });
      app = await NestFactory.create<NestFastifyApplication>(
        InterruptedStreamModule,
        new FastifyAdapter(),
        { logger: false },
      );
      await app.listen(0, '127.0.0.1');
      const origin = await app.getUrl();
      const model = protocol === 'messages' ? 'claude-sonnet-4-5' : 'gemini-3-flash';
      const route =
        protocol === 'gemini'
          ? `/v1beta/models/${model}:streamGenerateContent`
          : protocol === 'chat'
            ? '/v1/chat/completions'
            : `/v1/${protocol}`;
      const body =
        protocol === 'gemini'
          ? { contents: [{ role: 'user', parts: [{ text: 'Controlled interruption' }] }] }
          : protocol === 'responses'
            ? { model, input: 'Controlled interruption', stream: true }
            : {
                model,
                stream: true,
                max_tokens: 32,
                messages: [{ role: 'user', content: 'Controlled interruption' }],
                ...(protocol === 'chat' ? { stream_options: { include_usage: true } } : {}),
              };
      const response = await fetch(`${origin}${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.body) {
        throw new Error('Expected streamed HTTP response body');
      }
      let output = '';
      let reset = false;
      const decoder = new TextDecoder();
      const marker = kind === 'text' ? JSON.stringify(fixtureText).slice(1, -1) : 'read_file';
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          output += decoder.decode(value, { stream: true });
          if (ending === 'reset' && !reset && output.includes(marker)) {
            reset = true;
            upstreamResponse?.destroy();
          }
        }
      } catch (error) {
        controller.abort();
        throw error;
      } finally {
        reader.releaseLock();
      }
      output += decoder.decode();
      expect(reset).toBe(ending === 'reset');
      expect(response.status, output).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      if (kind === 'text') {
        const visibleText = output
          .split('\n\n')
          .flatMap((event) => {
            const data = event
              .split('\n')
              .find((line) => line.startsWith('data: '))
              ?.slice(6);
            if (!data || data === '[DONE]') {
              return [];
            }
            const parsed = outputEvent.parse(JSON.parse(data));
            if (protocol === 'chat') {
              return parsed.choices?.flatMap((choice) => choice.delta.content ?? []) ?? [];
            }
            if (protocol === 'messages') {
              return parsed.type === 'content_block_delta' && typeof parsed.delta === 'object'
                ? [parsed.delta.text ?? '']
                : [];
            }
            if (protocol === 'responses') {
              return parsed.type === 'response.output_text.delta' &&
                typeof parsed.delta === 'string'
                ? [parsed.delta]
                : [];
            }
            return (
              (parsed.candidates ?? parsed.response?.candidates)?.flatMap(
                (candidate) => candidate.content?.parts.flatMap((item) => item.text ?? []) ?? [],
              ) ?? []
            );
          })
          .join('');
        expect(visibleText).toBe(fixtureText);
      } else {
        expect(output).toContain('read_file');
        expect(output).toContain('/fixture');
      }
      if (protocol === 'responses') {
        expect(output.match(/event: response.failed/gu)).toHaveLength(1);
        expect(output).not.toContain('event: response.completed');
      } else {
        expect(output).not.toContain('"error":');
        if (protocol === 'chat') {
          expect(output.match(/"finish_reason":"[^"]+"/gu)).toEqual([
            `"finish_reason":"${kind === 'tool' ? 'tool_calls' : 'length'}"`,
          ]);
          expect(output.match(/data: \[DONE\]/gu)).toHaveLength(1);
        } else if (protocol === 'messages') {
          expect(output.match(/"stop_reason":"[^"]+"/gu)).toEqual([
            `"stop_reason":"${kind === 'tool' ? 'tool_use' : 'max_tokens'}"`,
          ]);
          expect(output.match(/event: message_stop/gu)).toHaveLength(1);
        } else {
          expect(output.match(/"finishReason":"[^"]+"/gu)).toEqual([
            `"finishReason":"${kind === 'tool' ? 'STOP' : 'MAX_TOKENS'}"`,
          ]);
          expect(output).toContain('"gatewayInterrupted":true');
        }
      }
      expect(requests).toEqual(['/:streamGenerateContent?alt=sse']);
      expect(upstream.streamGenerateInternal).toHaveBeenCalledOnce();
      expect(upstream.generateInternal).not.toHaveBeenCalled();
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
    } finally {
      clearTimeout(watchdog);
      controller.abort();
      await app?.close();
      client.onModuleDestroy();
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  },
  15_000,
);
