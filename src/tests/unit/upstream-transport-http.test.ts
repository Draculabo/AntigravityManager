import axios, { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
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
  resolveRequestUserAgent: async () => 'controlled-transport-test/0.0.0',
  buildContentRequestUserAgent: () => 'controlled-transport-test/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));

type Protocol = 'chat' | 'responses' | 'messages' | 'gemini';

async function clientFailure(code: string, message: string, status?: number): Promise<Error> {
  const failure = new AxiosError(message, code);
  if (status !== undefined) {
    failure.response = {
      status,
      statusText: '',
      data: { error: { message } },
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
    };
  }
  vi.spyOn(axios, 'post').mockRejectedValue(failure);
  const client = new GeminiClient({ capture: vi.fn() } as never);
  try {
    await client.generate('gemini-3-flash', { contents: [] }, 'synthetic-access-token');
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected transport failure');
}

async function httpFailure(
  protocol: Protocol,
  error: Error,
  gateway?: ReturnType<typeof createGateway>,
) {
  const service = {
    handleChatCompletions: vi.fn().mockRejectedValue(error),
    handleAnthropicMessages: vi.fn().mockRejectedValue(error),
    handleGeminiGenerateContent: vi.fn().mockRejectedValue(error),
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
  } else if (protocol === 'responses') {
    await new OpenAIOperations(
      gateway?.openAIService ?? (service as unknown as OpenAIService),
    ).responses(
      {
        model: 'gemini-3-flash',
        input: 'controlled',
      },
      reply as never,
    );
  } else {
    await new OpenAIOperations(
      gateway?.openAIService ?? (service as unknown as OpenAIService),
    ).chatCompletions(
      {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'controlled' }],
      },
      reply as never,
    );
  }
  return reply;
}

function expectedBody(protocol: Protocol, status: number, message: string) {
  return protocol === 'gemini'
    ? {
        error: {
          code: status,
          status:
            status === 504
              ? 'DEADLINE_EXCEEDED'
              : status === 503
                ? 'UNAVAILABLE'
                : status === 403
                  ? 'PERMISSION_DENIED'
                  : status === 429
                    ? 'RESOURCE_EXHAUSTED'
                    : 'INTERNAL',
          message,
        },
      }
    : protocol === 'messages'
      ? {
          type: 'error',
          error: {
            type:
              status === 504
                ? 'timeout_error'
                : status === 429
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each(['chat', 'responses', 'messages', 'gemini'] as const)(
  '%s transport HTTP projection',
  (protocol) => {
    it.each([
      ['ETIMEDOUT', 504],
      ['ECONNREFUSED', 502],
    ] as const)('preserves %s through the real account/retry path', async (code, status) => {
      vi.stubEnv('PROXY_INTERNAL_BASE_URLS', 'https://synthetic-upstream.invalid/v1internal');
      const failure = new AxiosError('opaque controlled failure', code);
      vi.spyOn(axios, 'post').mockRejectedValue(failure);
      const client = new GeminiClient({ capture: vi.fn() } as never);
      const upstream = createUpstream({});
      upstream.generateInternal.mockImplementation((...args) => client.generateInternal(...args));
      const lease = createLease([createAccount('transport-controlled')]);
      const reply = await httpFailure(protocol, failure, createGateway(upstream, lease));
      expect(reply.statusCode).toBe(status);
      expect(reply.body).toEqual(expectedBody(protocol, status, failure.message));
      const sends = vi.mocked(axios.post).mock.calls.length;
      expect(sends).toBeGreaterThan(0);
      expect(sends).toBeLessThanOrEqual(3);
      expect(upstream.streamGenerateInternal).not.toHaveBeenCalled();
      expect(lease.markModelSuccess).not.toHaveBeenCalled();
    });

    it('keeps native error codes while discarding transport object graphs', async () => {
      const failure = Object.assign(new Error('opaque native failure'), {
        code: 'ETIMEDOUT',
        request: { internal: 'synthetic request graph' },
      });
      vi.spyOn(axios, 'post').mockRejectedValue(failure);
      const client = new GeminiClient({ capture: vi.fn() } as never);
      const error = await client
        .generate('gemini-3-flash', { contents: [] }, 'synthetic-token')
        .then(
          () => {
            throw new Error('Expected native failure');
          },
          (value: unknown) => value,
        );
      expect(error).toMatchObject({ code: 'ETIMEDOUT', message: failure.message });
      expect(error).not.toHaveProperty('request');
      if (!(error instanceof Error)) {
        throw new Error('Expected clean native error');
      }
      const reply = await httpFailure(protocol, error);
      expect(reply.statusCode).toBe(504);
      expect(reply.body).toEqual(expectedBody(protocol, 504, failure.message));
    });

    it.each([
      ['ETIMEDOUT', 'opaque controlled failure', 504],
      ['ECONNABORTED', 'opaque controlled failure', 504],
      ['ECONNREFUSED', 'controlled message mentions timeout', 502],
      ['ECONNRESET', 'controlled message mentions timeout', 502],
      ['ENOTFOUND', 'opaque controlled failure', 502],
      ['EAI_AGAIN', 'opaque controlled failure', 502],
    ] as const)(
      'maps Axios %s through the production client and controller',
      async (code, message, status) => {
        const error = await clientFailure(code, message);
        const reply = await httpFailure(protocol, error);
        expect(reply.statusCode).toBe(status);
        expect(reply.body).toEqual(expectedBody(protocol, status, message));
        expect(axios.post).toHaveBeenCalledOnce();
      },
    );

    it.each([
      ['Connection timed out while reading', 504],
      ['DEADLINE_EXCEEDED', 504],
      ['error reading a body from connection: connection reset', 502],
      ['connect ECONNREFUSED controlled-host', 502],
      ['socket hang up', 502],
    ] as const)('retains text fallback for %s', async (message, status) => {
      const reply = await httpFailure(protocol, new Error(message));
      expect(reply.statusCode).toBe(status);
      expect(reply.body).toEqual(expectedBody(protocol, status, message));
    });

    it.each([403, 429, 499, 503])(
      'preserves actual upstream HTTP %i before transport metadata or wording',
      async (upstreamStatus) => {
        const message = 'controlled timeout mentioning quota 429';
        const error = await clientFailure('ETIMEDOUT', message, upstreamStatus);
        const reply = await httpFailure(protocol, error);
        const status = protocol === 'messages' && upstreamStatus === 403 ? 503 : upstreamStatus;
        expect(reply.statusCode).toBe(status);
        expect(reply.body).toEqual(expectedBody(protocol, status, message));
      },
    );

    it('does not turn an invalid upstream HTTP error status into a message-derived timeout', async () => {
      const message = 'controlled timeout mentioning quota 429';
      const reply = await httpFailure(protocol, new UpstreamRequestError({ status: 200, message }));
      expect(reply.statusCode).toBe(502);
      expect(reply.body).toEqual(expectedBody(protocol, 502, message));
    });

    it('keeps deliberate account-pool status and Retry-After', async () => {
      const error = new ProxyAccountUnavailableError({ status: 503, retryAfterSeconds: 11 });
      const reply = await httpFailure(protocol, error);
      expect(reply.statusCode).toBe(503);
      expect(reply.body).toEqual(expectedBody(protocol, 503, error.message));
      expect(reply.header).toHaveBeenCalledWith('Retry-After', '11');
    });

    it('does not classify cancellation with timeout wording as an upstream timeout', async () => {
      const error = Object.assign(new Error('controlled cancellation after timeout'), {
        code: 'ERR_CANCELED',
      });
      const reply = await httpFailure(protocol, error);
      expect(reply.statusCode).toBe(500);
      expect(reply.body).toEqual(expectedBody(protocol, 500, error.message));
    });
  },
);
