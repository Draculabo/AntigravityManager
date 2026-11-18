import { BadRequestException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import type { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import type { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import type { OpenAIService } from '@/server/gateway/modules/openai/openai.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { ProxyAccountUnavailableError } from '@/server/gateway/common/exceptions/proxy-account-unavailable.exception';
import {
  createReply,
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'controlled-public-error-test/0.0.0',
  buildContentRequestUserAgent: () => 'controlled-public-error-test/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));

type Protocol = 'chat' | 'responses' | 'messages' | 'gemini';

async function httpFailure(
  protocol: Protocol,
  error: Error,
  gateway?: ReturnType<typeof createGateway>,
) {
  const service = {
    handleChatCompletions: vi.fn().mockRejectedValue(error),
    handleAnthropicMessages: vi.fn().mockRejectedValue(error),
    handleGeminiGenerateContent: vi.fn().mockRejectedValue(error),
    handleGeminiCountTokensWithSource: vi.fn().mockRejectedValue(error),
    handleGeminiStreamGenerateContent: vi.fn().mockRejectedValue(error),
  };
  const reply = createReply();
  if (protocol === 'gemini') {
    await new GeminiController(
      gateway?.geminiService ?? (service as unknown as GeminiService),
    ).modelAction(
      'gemini-3-flash:generateContent',
      { contents: [{ role: 'user', parts: [{ text: 'controlled' }] }] },
      reply as never,
    );
  } else if (protocol === 'messages') {
    await new AnthropicController(
      gateway?.anthropicService ?? (service as unknown as AnthropicService),
    ).anthropicMessages(
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'controlled' }],
      },
      reply as never,
    );
  } else {
    const operations = new OpenAIOperations(
      gateway?.openAIService ?? (service as unknown as OpenAIService),
    );
    if (protocol === 'responses') {
      await operations.responses({ model: 'gemini-3-flash', input: 'controlled' }, reply as never);
    } else {
      await operations.chatCompletions(
        { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'controlled' }] },
        reply as never,
      );
    }
  }
  return reply;
}

function expectedBody(protocol: Protocol, status: number, message: string) {
  if (protocol === 'gemini') {
    const statusName =
      status === 400
        ? 'INVALID_ARGUMENT'
        : status === 429
          ? 'RESOURCE_EXHAUSTED'
          : status === 503
            ? 'UNAVAILABLE'
            : 'INTERNAL';
    return { error: { code: status, status: statusName, message } };
  }
  return protocol === 'messages'
    ? {
        type: 'error',
        error: {
          type:
            status === 429
              ? 'rate_limit_error'
              : status < 500
                ? 'invalid_request_error'
                : 'api_error',
          message,
        },
      }
    : {
        error: {
          type:
            status === 429
              ? 'rate_limit_error'
              : status < 500
                ? 'invalid_request_error'
                : 'server_error',
          message,
        },
      };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe.each(['chat', 'responses', 'messages', 'gemini'] as const)(
  '%s public HTTP error messages',
  (protocol) => {
    it.each([
      ['Bearer synthetic-bearer-value', 'Bearer [REDACTED]'],
      ['Basic c3ludGhldGljOnBhc3N3b3Jk', 'Basic [REDACTED]'],
      ['token=synthetic-token-value', 'token=[REDACTED]'],
      ['x-api-key: synthetic-api-key', 'x-api-key: [REDACTED]'],
      [
        'https://synthetic-user:synthetic-password@example.invalid/path?key=synthetic-query-value',
        'https://[REDACTED]@example.invalid/path?key=[REDACTED]',
      ],
      ['synthetic-person@example.invalid', '[EMAIL REDACTED]'],
      ['C:\\Users\\synthetic-user\\app', '[PATH REDACTED]'],
      ['/home/synthetic-user/app', '[PATH REDACTED]'],
    ])('redacts %s without changing the internal error', async (input, output) => {
      const message = `Provider rejected request: ${input}`;
      const error = new UpstreamRequestError({
        message,
        status: 400,
        body: 'synthetic private body',
      });
      const reply = await httpFailure(protocol, error);
      expect(reply.statusCode).toBe(400);
      expect(reply.body).toEqual(
        expectedBody(protocol, 400, `Provider rejected request: ${output}`),
      );
      expect(error.message).toBe(message);
      expect(error.body).toBe('synthetic private body');
    });

    it('bounds the complete message to 2048 UTF-8 bytes at a character boundary', async () => {
      const message = 'a'.repeat(2043) + '😀中文'.repeat(1000);
      const reply = await httpFailure(protocol, new UpstreamRequestError({ message, status: 400 }));
      const expected = 'a'.repeat(2043) + '…';
      expect(reply.body).toEqual(expectedBody(protocol, 400, expected));
      expect(Buffer.byteLength(expected, 'utf8')).toBeLessThanOrEqual(2048);
      expect(JSON.stringify(reply.body)).not.toContain('�');
    });

    it('redacts before truncation so a credential crossing the limit cannot leak', async () => {
      const message = 'a'.repeat(2020) + ' token=' + 'synthetic-secret'.repeat(500);
      const reply = await httpFailure(protocol, new UpstreamRequestError({ message, status: 400 }));
      expect(reply.body).toEqual(
        expectedBody(protocol, 400, 'a'.repeat(2020) + ' token=[REDACTED]'),
      );
    });

    it('keeps an exactly 2048-byte safe message unchanged', async () => {
      const message = '😀'.repeat(512);
      const reply = await httpFailure(protocol, new UpstreamRequestError({ message, status: 400 }));
      expect(reply.body).toEqual(expectedBody(protocol, 400, message));
    });

    it('applies the byte limit after redaction expands short sensitive values', async () => {
      const message = 'x@y.zz '.repeat(400);
      const reply = await httpFailure(protocol, new UpstreamRequestError({ message, status: 400 }));
      expect(reply.body).toEqual(
        expectedBody(protocol, 400, '[EMAIL REDACTED] '.repeat(120) + '[EMAI' + '…'),
      );
    });

    it('bounds the serialized envelope even when JSON escapes expand the message', async () => {
      const message = '\u0000'.repeat(5000);
      const reply = await httpFailure(protocol, new UpstreamRequestError({ message, status: 400 }));
      expect(reply.body).toEqual(expectedBody(protocol, 400, '\u0000'.repeat(2045) + '…'));
      expect(Buffer.byteLength(JSON.stringify(reply.body), 'utf8')).toBeLessThan(16 * 1024);
    });

    it('keeps a useful tool name and reason for an ordinary safe message', async () => {
      const message = 'Tool read_file failed: required argument path is missing.';
      const reply = await httpFailure(protocol, new UpstreamRequestError({ message, status: 400 }));
      expect(reply.body).toEqual(expectedBody(protocol, 400, message));
    });

    it('keeps status classification independent of redacted or truncated text', async () => {
      const error = new UpstreamRequestError({
        message: 'token=429 ' + 'x'.repeat(5000),
        status: 503,
      });
      const reply = await httpFailure(protocol, error);
      expect(reply.statusCode).toBe(503);
      expect(reply.body).toEqual(
        expectedBody(protocol, 503, 'token=[REDACTED] ' + 'x'.repeat(2028) + '…'),
      );
    });

    it('uses a nonempty fallback for an empty upstream message', async () => {
      const reply = await httpFailure(
        protocol,
        new UpstreamRequestError({ message: '  ', status: 400 }),
      );
      expect(reply.body).toEqual(expectedBody(protocol, 400, 'Request failed.'));
    });

    it('preserves typed pool status and Retry-After', async () => {
      const error = new ProxyAccountUnavailableError({ status: 429, retryAfterSeconds: 4 });
      const reply = await httpFailure(protocol, error);
      expect(reply.statusCode).toBe(429);
      expect(reply.header).toHaveBeenCalledWith('Retry-After', '4');
    });

    it('sanitizes through the production account/retry and protocol path', async () => {
      const error = new UpstreamRequestError({
        message: 'Tool read_file failed: token=synthetic-private-value',
        status: 400,
      });
      const upstream = createUpstream({
        generate: async () => {
          throw error;
        },
      });
      const lease = createLease([createAccount('public-error-controlled')]);
      const reply = await httpFailure(protocol, error, createGateway(upstream, lease));
      expect(reply.statusCode).toBe(400);
      expect(reply.body).toEqual(
        expectedBody(protocol, 400, 'Tool read_file failed: token=[REDACTED]'),
      );
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
      expect(upstream.streamGenerateInternal).not.toHaveBeenCalled();
    });

    it('sanitizes unresolved file references before service dispatch', async () => {
      const handle = 'synthetic-person@example.invalid';
      const reply = createReply();
      const service = {
        handleChatCompletions: vi.fn(),
        handleAnthropicMessages: vi.fn(),
        handleGeminiGenerateContent: vi.fn(),
      };
      let param: string;
      if (protocol === 'gemini') {
        param = 'body.contents.0.parts.0';
        await new GeminiController(service as unknown as GeminiService).modelAction(
          'gemini-3-flash:generateContent',
          {
            contents: [
              {
                role: 'user',
                parts: [{ fileData: { fileUri: handle, mimeType: 'application/pdf' } }],
              },
            ],
          },
          reply as never,
        );
      } else if (protocol === 'messages') {
        param = 'body.messages.0.content.0';
        await new AnthropicController(service as unknown as AnthropicService).anthropicMessages(
          {
            model: 'claude-sonnet-4-5',
            max_tokens: 32,
            messages: [
              {
                role: 'user',
                content: [{ type: 'document', source: { type: 'file', file_id: handle } }],
              },
            ],
          } as never,
          reply as never,
        );
      } else {
        const operations = new OpenAIOperations(service as unknown as OpenAIService);
        if (protocol === 'responses') {
          param = 'body.input.0.content.0';
          await operations.responses(
            {
              model: 'gemini-3-flash',
              input: [{ role: 'user', content: [{ type: 'input_file', file_id: handle }] }],
            } as never,
            reply as never,
          );
        } else {
          param = 'body.messages.0.content.0';
          await operations.chatCompletions(
            {
              model: 'gemini-3-flash',
              messages: [{ role: 'user', content: [{ type: 'file', file: { file_id: handle } }] }],
            } as never,
            reply as never,
          );
        }
      }
      const message = `${param} references '[EMAIL REDACTED]', but the file store is not available on this proxy`;
      expect(reply.statusCode).toBe(404);
      expect(reply.body).toEqual(
        protocol === 'gemini'
          ? { error: { code: 404, message, status: 'NOT_FOUND' } }
          : protocol === 'messages'
            ? { type: 'error', error: { type: 'invalid_request_error', message } }
            : { error: { code: 'file_not_found', param, type: 'invalid_request_error', message } },
      );
      expect(service.handleChatCompletions).not.toHaveBeenCalled();
      expect(service.handleAnthropicMessages).not.toHaveBeenCalled();
      expect(service.handleGeminiGenerateContent).not.toHaveBeenCalled();
    });
  },
);

it.each(['generateContent', 'streamGenerateContent', 'countTokens'])(
  'sanitizes Gemini %s validation errors',
  async (action) => {
    const error = new BadRequestException('Invalid input: token=synthetic-validation-value');
    const service = {
      handleGeminiGenerateContent: vi.fn().mockRejectedValue(error),
      handleGeminiStreamGenerateContent: vi.fn().mockRejectedValue(error),
      handleGeminiCountTokensWithSource: vi.fn().mockRejectedValue(error),
    };
    const reply = createReply();
    await new GeminiController(service as unknown as GeminiService).modelAction(
      `gemini-3-flash:${action}`,
      { contents: [] },
      reply as never,
    );
    expect(reply.statusCode).toBe(400);
    expect(reply.body).toEqual(expectedBody('gemini', 400, 'Invalid input: token=[REDACTED]'));
  },
);

it('sanitizes an unsupported Gemini action reflected from the route', async () => {
  const reply = createReply();
  await new GeminiController({} as GeminiService).modelAction(
    'gemini-3-flash:token=synthetic-action-value',
    { contents: [] },
    reply as never,
  );
  expect(reply.statusCode).toBe(400);
  expect(reply.body).toEqual(
    expectedBody('gemini', 400, 'Unsupported model action: token=[REDACTED]'),
  );
});

it('redacts HTTP diagnostic logs while retaining every stack frame', async () => {
  const error = new UpstreamRequestError({
    message: 'Provider rejected token=synthetic-log-value',
    status: 500,
  });
  const frames = Array.from(
    { length: 1000 },
    (_, index) => `    at syntheticFunction${index} (synthetic-module:${index}:1)`,
  ).join('\n');
  error.stack = `Error: token=synthetic-log-value\n${frames}`;
  const reply = await httpFailure('chat', error);
  expect(reply.body).toEqual(expectedBody('chat', 500, 'Provider rejected token=[REDACTED]'));
  expect(Logger.prototype.error).toHaveBeenCalledWith(
    '[/v1/chat/completions] status=500 message=Provider rejected token=[REDACTED]',
    `Error: token=[REDACTED]\n${frames}`,
  );
  expect(error.stack).toBe(`Error: token=synthetic-log-value\n${frames}`);
});
