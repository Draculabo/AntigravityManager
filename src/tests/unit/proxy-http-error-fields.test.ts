import { BadRequestException, HttpException, Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import type { AnthropicService } from '@/server/gateway/modules/anthropic/anthropic.service';
import type { OpenAIService } from '@/server/gateway/modules/openai/openai.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { ProxyAccountUnavailableError } from '@/server/gateway/common/exceptions/proxy-account-unavailable.exception';
import { SchemaInputError } from '@/modules/proxy-gateway/antigravity/schema/SchemaConversion';
import { ToolConfigurationError } from '@/modules/proxy-gateway/antigravity/ToolChoiceCompat';
import { InvalidToolResultAssociationError } from '@/modules/proxy-gateway/antigravity/ClaudeToolResultAssociation';
import { InvalidModelEffortError } from '@/server/gateway/common/invalid-model-effort.error';
import { OutputTokenLimitConflictError } from '@/server/gateway/common/output-token-limit';
import {
  createReply,
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', () => ({
  resolveRequestUserAgent: async () => 'controlled-error-fields/0.0.0',
  buildContentRequestUserAgent: () => 'controlled-error-fields/0.0.0',
  resolveLocalInstalledVersion: () => '0.0.0',
}));

type Protocol = 'chat' | 'responses' | 'messages';
async function dispatch(
  protocol: Protocol,
  error: Error,
  gateway?: ReturnType<typeof createGateway>,
) {
  const service = {
    handleChatCompletions: vi.fn().mockRejectedValue(error),
    handleAnthropicMessages: vi.fn().mockRejectedValue(error),
  };
  const reply = createReply();
  if (protocol === 'messages') {
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

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe.each(['chat', 'responses', 'messages'] as const)('%s HTTP error fields', (protocol) => {
  it.each([
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [402, 'billing_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [409, 'conflict_error'],
    [413, 'request_too_large'],
    [422, 'invalid_request_error'],
    [429, 'rate_limit_error'],
    [499, 'invalid_request_error'],
    [500, 'api_error'],
    [502, 'api_error'],
    [503, 'api_error'],
    [504, 'timeout_error'],
    [529, 'overloaded_error'],
  ] as const)('maps local HTTP %i independently of message text', async (status, anthropicType) => {
    const reply = await dispatch(protocol, new HttpException('opaque controlled message', status));
    const type =
      protocol === 'messages'
        ? anthropicType
        : status === 429
          ? 'rate_limit_error'
          : status < 500
            ? 'invalid_request_error'
            : 'server_error';
    expect(reply.statusCode).toBe(status);
    expect(reply.body).toEqual(
      protocol === 'messages'
        ? { type: 'error', error: { type, message: 'opaque controlled message' } }
        : { error: { type, message: 'opaque controlled message' } },
    );
  });

  it('preserves the upstream 403 compatibility exception after type mapping', async () => {
    const reply = await dispatch(
      protocol,
      new UpstreamRequestError({
        status: 403,
        message: 'provider refused token=synthetic-field-secret',
      }),
    );
    expect(reply.statusCode).toBe(protocol === 'messages' ? 503 : 403);
    expect(reply.body).toEqual(
      protocol === 'messages'
        ? {
            type: 'error',
            error: { type: 'api_error', message: 'provider refused token=[REDACTED]' },
          }
        : {
            error: { type: 'invalid_request_error', message: 'provider refused token=[REDACTED]' },
          },
    );
  });

  it('preserves pool rate limiting and Retry-After', async () => {
    const reply = await dispatch(
      protocol,
      new ProxyAccountUnavailableError({ status: 429, retryAfterSeconds: 3 }),
    );
    expect(reply.statusCode).toBe(429);
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '3');
    expect(reply.body).toMatchObject({ error: { type: 'rate_limit_error' } });
  });

  it('does not project untrusted body fields as machine-readable fields', async () => {
    const error = new UpstreamRequestError({
      status: 400,
      message: 'controlled',
      body: JSON.stringify({
        error: {
          type: 'authentication_error',
          code: 'private-provider-code',
          param: 'token=synthetic-param-secret',
          details: { private: true },
        },
      }),
    });
    const reply = await dispatch(protocol, error);
    expect(reply.body).toEqual(
      protocol === 'messages'
        ? { type: 'error', error: { type: 'invalid_request_error', message: 'controlled' } }
        : { error: { type: 'invalid_request_error', message: 'controlled' } },
    );
  });

  it.each([
    [new SchemaInputError('invalid-root'), 'invalid_request_schema', null],
    [
      new InvalidToolResultAssociationError('messages.0', 'missing-pending-call'),
      'invalid_tool_history',
      null,
    ],
    [new ToolConfigurationError('unknown-function-name'), 'invalid_tool_choice', 'tool_choice'],
    [
      new OutputTokenLimitConflictError(['max_tokens', 'max_completion_tokens']),
      'conflicting_output_token_limits',
      null,
    ],
    [new InvalidModelEffortError('synthetic-unsupported'), 'invalid_model_effort', null],
  ] as const)('exposes only known local metadata for %s', async (error, code, param) => {
    const reply = await dispatch(protocol, error);
    expect(reply.statusCode).toBe(400);
    expect(reply.body).toEqual(
      protocol === 'messages'
        ? { type: 'error', error: { type: 'invalid_request_error', message: error.message } }
        : { error: { type: 'invalid_request_error', message: error.message, code, param } },
    );
  });

  it('classifies a generic local validation failure as invalid request', async () => {
    const reply = await dispatch(protocol, new BadRequestException('opaque input validation'));
    expect(reply.statusCode).toBe(400);
    expect(reply.body).toMatchObject({
      error: { type: 'invalid_request_error', message: 'opaque input validation' },
    });
  });

  it('maps a typed provider rejection through production services and retry ownership', async () => {
    const error = new UpstreamRequestError({
      status: 400,
      message: 'Tool read_file failed: invalid arguments',
    });
    const upstream = createUpstream({
      generate: () => {
        throw error;
      },
    });
    const lease = createLease([createAccount('error-fields-controlled')]);
    const reply = await dispatch(protocol, error, createGateway(upstream, lease));
    expect(reply.statusCode).toBe(400);
    expect(reply.body).toMatchObject({
      error: { type: 'invalid_request_error', message: error.message },
    });
    expect(lease.markModelSuccess).not.toHaveBeenCalled();
    expect(upstream.streamGenerateInternal).not.toHaveBeenCalled();
  });
});
