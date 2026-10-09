import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
import { logger } from '@/shared/logging/logger';
import * as schemaUtils from '@/modules/proxy-gateway/antigravity/JsonSchemaUtils';
import { STRING_SCHEMA_FALLBACK } from '@/modules/proxy-gateway/antigravity/schema/JsonSchemaReferenceResolver';
import { OpenAIResponsesSessionStore } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.store';
import {
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock(
  '@/modules/proxy-gateway/server/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    resolveRequestUserAgent: async () => 'schema-test/1',
  }),
);
const broken = {
  type: 'object',
  properties: { good: { type: 'integer' }, bad: { $ref: '#/$defs/missing' } },
  required: ['bad'],
};

afterEach(() => {
  logger.setSentryReporter(null);
  logger.setErrorReportingEnabled(false);
  vi.restoreAllMocks();
});

describe('schema admission before account execution', () => {
  it('keeps unexpected converter faults as server errors without fallback or account penalties', async () => {
    vi.spyOn(schemaUtils, 'normalizeObjectJsonSchema').mockImplementationOnce(() => {
      throw new Error('Unexpected converter fault');
    });
    const lease = createLease([createAccount('schema-fault')]);
    const upstream = createUpstream({ generate: geminiTextResponse('unused') });
    const reply = createReply();
    await new OpenAIOperations(createGateway(upstream, lease).openAIService).chatCompletions(
      {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          { type: 'function', function: { name: 'safe_tool', parameters: { type: 'object' } } },
        ],
      } as never,
      reply as never,
    );
    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({
      error: { type: 'server_error', message: 'Unexpected converter fault' },
    });
    expect(lease.getNextToken).not.toHaveBeenCalled();
    expect(lease.penalties).toEqual([]);
    expect(upstream.calls).toEqual([]);
  });
  it.each(['openai', 'anthropic', 'count-tokens'] as const)(
    'rejects invalid roots on %s without leasing, upstream calls or penalties',
    async (protocol) => {
      const lease = createLease([createAccount('schema-account')]);
      const upstream = createUpstream({ generate: geminiTextResponse('ok') });
      const gateway = createGateway(upstream, lease);
      const reply = createReply();
      const parameters = { $ref: 'https://private.invalid/tool' };
      const base = {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      };
      if (protocol === 'openai') {
        await new OpenAIOperations(gateway.openAIService).chatCompletions(
          {
            ...base,
            tools: [{ type: 'function', function: { name: 'safe_tool', parameters } }],
          } as never,
          reply as never,
        );
        expect(reply.body).toEqual({
          error: {
            type: 'invalid_request_error',
            message: 'Invalid request schema: unsupported-reference',
          },
        });
      } else {
        const controller = new AnthropicController(gateway.anthropicService);
        const request = { ...base, tools: [{ name: 'safe_tool', input_schema: parameters }] };
        if (protocol === 'count-tokens') {
          await controller.countTokens(request as never, reply as never);
        } else {
          await controller.anthropicMessages(request as never, reply as never);
        }
        expect(reply.body).toEqual({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'Invalid request schema: unsupported-reference',
          },
        });
      }
      expect(reply.statusCode).toBe(400);
      expect(lease.getNextToken).not.toHaveBeenCalled();
      expect(lease.penalties).toEqual([]);
      expect(upstream.calls).toEqual([]);
    },
  );

  it('retains a degraded parameter across account retries and reports once without request context', async () => {
    const lease = createLease([createAccount('schema-a'), createAccount('schema-b')]);
    let attempt = 0;
    const upstream = createUpstream({
      generate: () => {
        if (attempt++ === 0) {
          throw new Error('503 unavailable');
        }
        return geminiTextResponse('ok');
      },
    });
    const reporter = vi.fn();
    logger.setSentryReporter(reporter);
    logger.setErrorReportingEnabled(true);
    logger.info('private preceding request schema secret');
    const request = {
      model: 'gemini-3-flash',
      messages: [{ role: 'user', content: 'private conversation' }],
      tools: [{ type: 'function', function: { name: 'private_tool_name', parameters: broken } }],
      stream: false,
    };
    const original = structuredClone(request);
    await createGateway(upstream, lease).openAIService.handleChatCompletions(request as never);
    expect(upstream.calls).toHaveLength(2);
    const expected = {
      type: 'object',
      properties: { good: { type: 'integer' }, bad: STRING_SCHEMA_FALLBACK },
      required: ['bad'],
    };
    for (const call of upstream.calls) {
      expect(call.body.request.tools?.[0].functionDeclarations?.[0].parameters).toEqual(expected);
    }
    expect(request).toEqual(original);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter.mock.calls[0][0]).toMatchObject({ isolated: true, logs: [], error: undefined });
    expect(JSON.stringify(reporter.mock.calls)).not.toMatch(
      /private|\$defs|missing|schema-a|schema-b/,
    );
  });

  it('rejects structured output child failures before leasing', async () => {
    const lease = createLease([createAccount('schema-account')]);
    const upstream = createUpstream({ generate: geminiTextResponse('{}') });
    const reply = createReply();
    await new OpenAIOperations(createGateway(upstream, lease).openAIService).chatCompletions(
      {
        model: 'gemini-3-flash',
        messages: [{ role: 'user', content: 'hello' }],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: broken } },
      } as never,
      reply as never,
    );
    expect(reply.statusCode).toBe(400);
    expect(lease.getNextToken).not.toHaveBeenCalled();
  });

  it('prepares inherited Responses tools without mutating the stored parent', async () => {
    OpenAIResponsesSessionStore.clear();
    const lease = createLease([createAccount('schema-response')]);
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const operations = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const first = createReply();
    await operations.responses(
      {
        model: 'gemini-3-flash',
        input: 'first',
        tools: [{ type: 'function', name: 'safe_tool', parameters: broken }],
      },
      first as never,
    );
    const id = Reflect.get(first.body as object, 'id');
    const parent = OpenAIResponsesSessionStore.getWithParent(id);
    const before = structuredClone(parent);
    const next = createReply();
    await operations.responses({ previous_response_id: id, input: 'continue' }, next as never);
    expect(next.statusCode).toBe(200);
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls[0].body.request.tools).toEqual(upstream.calls[1].body.request.tools);
    expect(OpenAIResponsesSessionStore.getWithParent(id)).toEqual(before);
    OpenAIResponsesSessionStore.clear();
  });
});
