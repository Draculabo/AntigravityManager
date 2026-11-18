import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { decodeInternalGeminiPayload } from '@/modules/proxy-gateway/antigravity/internal-sse';
import { upstreamGenerationFailure } from '@/server/gateway/common/upstream-generation-failure';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import type { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import type { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import type { OpenAIService } from '@/server/gateway/modules/openai/openai.service';
import { attachOpenAIResponsesWebSocketServer } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.server';
import { createReply } from './proxy-real-path.harness';
import { GenerationDeadlineExceededError } from '@/server/gateway/common/exceptions/generation-deadline.exception';

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

function providerError() {
  const decoded = decodeInternalGeminiPayload({
    response: {
      error: {
        code: 403,
        status: 'PERMISSION_DENIED',
        message: 'controlled token=synthetic-secret',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'VALIDATION_REQUIRED',
            domain: 'cloudcode-pa.googleapis.com',
            metadata: { private: 'synthetic-private-metadata' },
          },
          {
            '@type': 'type.googleapis.com/google.rpc.Help',
            links: [{ url: 'https://example.invalid?token=synthetic-private-link' }],
          },
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'unsafe reason',
            domain: 'cloudcode-pa.googleapis.com',
          },
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'VALIDATION_REQUIRED',
            domain: 'untrusted.invalid',
          },
        ],
      },
    },
  });
  if (decoded.kind !== 'error') {
    throw new Error('Expected controlled provider error');
  }
  return upstreamGenerationFailure(decoded.error);
}

describe.each(['chat', 'responses', 'messages', 'gemini'] as const)(
  '%s bounded error projection',
  (protocol) => {
    it('projects a logical business deadline as 504 rather than cancellation or account denial', async () => {
      const error = new GenerationDeadlineExceededError();
      const reply = createReply();
      if (protocol === 'gemini') {
        const service = { handleGeminiGenerateContent: vi.fn().mockRejectedValue(error) };
        await new GeminiController(service as unknown as GeminiService).modelAction(
          'fixture:generateContent',
          { contents: [] },
          reply as never,
        );
      } else if (protocol === 'messages') {
        const service = { handleAnthropicMessages: vi.fn().mockRejectedValue(error) };
        await new AnthropicController(service as unknown as AnthropicService).anthropicMessages(
          {
            model: 'fixture',
            max_tokens: 16,
            messages: [{ role: 'user', content: 'controlled' }],
          },
          reply as never,
        );
      } else {
        const service = { handleChatCompletions: vi.fn().mockRejectedValue(error) };
        const operations = new OpenAIOperations(service as unknown as OpenAIService);
        if (protocol === 'chat') {
          await operations.chatCompletions(
            { model: 'fixture', messages: [{ role: 'user', content: 'controlled' }] },
            reply as never,
          );
        } else {
          await operations.responses({ model: 'fixture', input: 'controlled' }, reply as never);
        }
      }
      expect(reply.statusCode).toBe(504);
      expect(JSON.stringify(reply.body)).toContain('Generation request deadline exceeded.');
      if (protocol === 'messages') {
        expect(reply.body).toMatchObject({ type: 'error', error: { type: 'timeout_error' } });
      }
    });
    it('preserves provider identity and existing correlation without disclosing private details', async () => {
      const error = providerError();
      const reply = createReply();
      reply.request = { id: 'controlled-request-1' };
      if (protocol === 'gemini') {
        const service = { handleGeminiGenerateContent: vi.fn().mockRejectedValue(error) };
        await new GeminiController(service as unknown as GeminiService).modelAction(
          'fixture:generateContent',
          { contents: [] },
          reply as never,
        );
      } else if (protocol === 'messages') {
        const service = { handleAnthropicMessages: vi.fn().mockRejectedValue(error) };
        await new AnthropicController(service as unknown as AnthropicService).anthropicMessages(
          { model: 'fixture', max_tokens: 16, messages: [{ role: 'user', content: 'controlled' }] },
          reply as never,
        );
      } else {
        const service = { handleChatCompletions: vi.fn().mockRejectedValue(error) };
        const operations = new OpenAIOperations(service as unknown as OpenAIService);
        if (protocol === 'chat') {
          await operations.chatCompletions(
            { model: 'fixture', messages: [{ role: 'user', content: 'controlled' }] },
            reply as never,
          );
        } else {
          await operations.responses({ model: 'fixture', input: 'controlled' }, reply as never);
        }
      }
      expect(reply.header).toHaveBeenCalledWith('X-Request-Id', 'controlled-request-1');
      expect(reply.statusCode).toBe(protocol === 'messages' ? 503 : 403);
      const message = 'controlled token=[REDACTED]';
      expect(reply.body).toEqual(
        protocol === 'gemini'
          ? {
              error: {
                code: 403,
                status: 'PERMISSION_DENIED',
                message,
                details: [
                  {
                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                    reason: 'VALIDATION_REQUIRED',
                    domain: 'cloudcode-pa.googleapis.com',
                  },
                ],
              },
            }
          : protocol === 'messages'
            ? {
                type: 'error',
                request_id: 'controlled-request-1',
                error: { type: 'api_error', message },
              }
            : {
                error: {
                  type: 'invalid_request_error',
                  code: 'PERMISSION_DENIED',
                  param: null,
                  message,
                },
              },
      );
      expect(error).toMatchObject({
        status: 403,
        upstreamStatus: 'PERMISSION_DENIED',
        source: 'wrapped',
        message: 'controlled token=synthetic-secret',
      });
      expect(error).toBeInstanceOf(UpstreamRequestError);
      expect(JSON.stringify(reply.body)).not.toMatch(
        /synthetic-private|synthetic-secret|untrusted/,
      );
    });
  },
);

it('bounds the diagnostic message in UTF-8 and preserves the truncation marker and source', () => {
  const decoded = decodeInternalGeminiPayload({
    error: { code: 503, message: '😀'.repeat(10000) },
  });
  expect(decoded.kind).toBe('error');
  if (decoded.kind !== 'error') {
    throw new Error('Expected controlled error');
  }
  expect(Buffer.byteLength(decoded.error.message)).toBe(32768);
  expect(decoded.error.message).not.toContain('\uFFFD');
  expect(upstreamGenerationFailure(decoded.error)).toMatchObject({
    source: 'bare',
    messageTruncated: true,
    status: 503,
  });
});

it.each([{ code: 200 }, { code: '429' }, { message: 5 }, { status: [] }, { details: {} }, {}])(
  'rejects malformed error contracts: %j',
  (error) => {
    const decoded = decodeInternalGeminiPayload({
      error,
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'must not succeed' }] } }],
    });
    expect(decoded).toMatchObject({
      kind: 'error',
      error: { source: 'bare', cause: { code: 'invalid_upstream_response', status: 502 } },
    });
  },
);

it('sends one sanitized WebSocket error and keeps provider diagnostics private', async () => {
  const error = new UpstreamRequestError({
    status: 503,
    upstreamStatus: 'UNAVAILABLE',
    message: 'failed token=synthetic-secret\n    at internal (C:\\private\\server.ts:5:1)',
  });
  const streamRequest = vi.fn().mockRejectedValue(error);
  const server = createServer();
  const detach = attachOpenAIResponsesWebSocketServer(server, {
    isAuthorized: () => true,
    streamRequest,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address');
  }
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const received = new Promise<unknown>((resolve, reject) => {
      socket.once('message', (data) => resolve(JSON.parse(data.toString())));
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] }));
    expect(await received).toEqual({
      type: 'error',
      error: {
        message: 'failed token=[REDACTED]',
        type: 'server_error',
        code: 'UNAVAILABLE',
        param: null,
      },
    });
    expect(streamRequest).toHaveBeenCalledOnce();
  } finally {
    socket.terminate();
    detach();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
