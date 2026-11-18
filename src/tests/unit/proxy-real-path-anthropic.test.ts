import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';
import { PassThrough } from 'stream';

import { AnthropicController } from '@/server/gateway/modules/anthropic/anthropic.controller';
import { proxyModelAvailabilityStore } from '@/server/gateway/shared/services/model-availability.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { resolveAnthropicSessionScope } from '@/server/gateway/common/signature-session-scope';
import {
  collect,
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
  geminiStreamFrame,
  geminiTextResponse,
} from './proxy-real-path.harness';

/**
 * The same black-box coverage as the OpenAI surface, on the Anthropic one. What is real and
 * what is faked is documented in `proxy-real-path.harness.ts`.
 *
 * This surface has its own controller, its own service and its own mappers by design, so a
 * green OpenAI path says nothing about it: the two share only the shared services and the
 * upstream client.
 */

vi.mock(
  '@/server/gateway/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRequestUserAgent: async () => 'antigravity-parity-harness/0.0.0',
  }),
);

describe('real request path, Anthropic messages surface', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
    proxyModelAvailabilityStore.clearAccount('acc-2');
    SignatureStore.clear();
  });

  it('answers an Anthropic client from an upstream fixture, through every real layer', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('The weather is cloudy.') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);
    const reply = createReply();

    await controller.anthropicMessages(
      {
        max_tokens: 128,
        messages: [{ content: 'What is the weather?', role: 'user' }],
        model: 'claude-sonnet-4-5',
        system: 'Use terse phrasing.',
        stream: false,
      } as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.body).toMatchObject({
      content: [{ text: 'The weather is cloudy.', type: 'text' }],
      role: 'assistant',
      stop_reason: 'end_turn',
      type: 'message',
    });
    expect(upstream.calls[0]?.accessToken).toBe('access-acc-1');
    expect(upstream.calls[0]?.body.request.systemInstruction).toEqual(
      expect.objectContaining({
        role: 'user',
        parts: expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('Use terse phrasing.') }),
        ]),
      }),
    );
  });

  it('gives the answer an Anthropic message id rather than the provider identifier', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);
    const reply = createReply();

    await controller.anthropicMessages(
      {
        max_tokens: 16,
        messages: [{ content: 'hello', role: 'user' }],
        model: 'claude-sonnet-4-5',
        stream: false,
      } as never,
      reply as never,
    );

    expect((reply.body as { id: string }).id).toBe('msg_upstream-response-1');
  });

  it('keeps the Gemini 3 server profile when an Anthropic client supplies a low raw budget', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);
    const reply = createReply();

    await controller.anthropicMessages(
      {
        max_tokens: 16384,
        messages: [{ content: 'Use the configured profile.', role: 'user' }],
        model: 'gemini-3.5-flash',
        stream: false,
        thinking: {
          budget_tokens: 1000,
          type: 'enabled',
        },
      } as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(upstream.calls[0]?.body.model).toBe('gemini-3-flash-agent');
    expect(upstream.calls[0]?.body.request.generationConfig).toEqual(
      expect.objectContaining({
        maxOutputTokens: 16384,
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 10000,
        },
      }),
    );
  });

  it('replaces raw Anthropic thinking controls for a direct Gemini agent identity', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);
    const reply = createReply();

    await controller.anthropicMessages(
      {
        max_tokens: 16384,
        messages: [{ content: 'Use the configured profile.', role: 'user' }],
        model: 'gemini-3-flash-agent',
        stream: false,
        thinking: {
          budget_tokens: 1000,
          type: 'enabled',
        },
      } as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(upstream.calls[0]?.body.model).toBe('gemini-3-flash-agent');
    expect(upstream.calls[0]?.body.request.generationConfig).toEqual(
      expect.objectContaining({
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 10000,
        },
      }),
    );
  });

  it('passes an Anthropic bare-model effort into account selection and physical resolution', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);

    await controller.anthropicMessages(
      {
        max_tokens: 128,
        messages: [{ content: 'Use medium effort.', role: 'user' }],
        model: 'gemini-3.8-flash',
        output_config: { effort: 'medium' },
        stream: false,
      } as never,
      createReply() as never,
    );

    expect(lease.getNextToken).toHaveBeenCalledWith(
      expect.objectContaining({
        effort: 'medium',
        model: 'gemini-3.8-flash',
      }),
    );
    expect(lease.resolveDynamicModelForAccount).toHaveBeenCalledWith(
      'acc-1',
      'gemini-3.8-flash',
      'medium',
      false,
    );
  });

  it('rejects an unknown Anthropic effort before account selection', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('unreachable') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);
    const reply = createReply();

    await controller.anthropicMessages(
      {
        max_tokens: 128,
        messages: [{ content: 'Reject this effort.', role: 'user' }],
        model: 'gemini-3.8-flash',
        output_config: { effort: 'not-a-tier' },
        stream: false,
      } as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.body).toEqual({
      error: {
        message: expect.stringContaining('Unsupported model effort "not-a-tier"'),
        type: 'invalid_request_error',
      },
      type: 'error',
    });
    expect(lease.getNextToken).not.toHaveBeenCalled();
    expect(lease.resolveDynamicModelForAccount).not.toHaveBeenCalled();
    expect(upstream.calls).toEqual([]);
  });

  it('recovers a registered unary tool call leaked as text', async () => {
    const upstream = createUpstream({
      generate: geminiTextResponse('call:default_api:read{"file_path":"C:/tmp/a.txt"}'),
    });
    const lease = createLease([createAccount('acc-1')]);
    const { anthropicService } = createGateway(upstream, lease);

    const response = await anthropicService.handleAnthropicMessages({
      max_tokens: 32,
      messages: [{ content: 'read it', role: 'user' }],
      model: 'claude-sonnet-4-5',
      stream: false,
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    } as never);

    expect(response).toMatchObject({
      content: [
        {
          type: 'tool_use',
          name: 'Read',
          input: { file_path: 'C:/tmp/a.txt' },
        },
      ],
      stop_reason: 'tool_use',
    });
  });

  it('replaces an unfinished thinking-only unary response with the streamed tool turn', async () => {
    const upstream = createUpstream({
      generate: {
        candidates: [
          { content: { role: 'model', parts: [{ thought: true, text: 'unfinished reasoning' }] } },
        ],
      },
      streamFrames: [
        geminiStreamFrame({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      id: 'controlled-tool-1',
                      name: 'probe_read',
                      args: { file_path: 'C:/controlled/read.txt' },
                    },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        }),
      ],
    });
    const { anthropicService } = createGateway(upstream, createLease([createAccount('acc-1')]));
    const response = await anthropicService.handleAnthropicMessages({
      model: 'gemini-3.1-pro-low',
      max_tokens: 128,
      stream: false,
      messages: [{ role: 'user', content: 'Read the controlled file.' }],
      tools: [
        {
          name: 'probe_read',
          input_schema: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'probe_read' },
    });
    expect(response).toMatchObject({
      content: [
        {
          type: 'tool_use',
          id: 'controlled-tool-1',
          name: 'probe_read',
          input: { file_path: 'C:/controlled/read.txt' },
        },
      ],
      stop_reason: 'tool_use',
    });
    expect(upstream.calls.map((call) => call.kind)).toEqual(['generate', 'stream']);
  });

  it('fails when both unary and streamed responses remain unfinished thinking', async () => {
    const unfinished = {
      candidates: [
        { content: { role: 'model', parts: [{ thought: true, text: 'unfinished reasoning' }] } },
      ],
    };
    const upstream = createUpstream({
      generate: unfinished,
      streamFrames: [geminiStreamFrame(unfinished)],
    });
    const { anthropicService } = createGateway(upstream, createLease([createAccount('acc-1')]));
    await expect(
      anthropicService.handleAnthropicMessages({
        model: 'gemini-3.1-pro-low',
        max_tokens: 128,
        stream: false,
        messages: [{ role: 'user', content: 'Reply.' }],
      }),
    ).rejects.toThrow('Gemini stream ended without a finish reason');
  });

  it('preserves a thinking-only response with an explicit token-limit finish', async () => {
    const upstream = createUpstream({
      generate: {
        candidates: [
          {
            content: { role: 'model', parts: [{ thought: true, text: 'limited reasoning' }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
      },
    });
    const { anthropicService } = createGateway(upstream, createLease([createAccount('acc-1')]));
    const response = await anthropicService.handleAnthropicMessages({
      model: 'gemini-3.1-pro-low',
      max_tokens: 128,
      stream: false,
      messages: [{ role: 'user', content: 'Reply.' }],
    });
    expect(response).toMatchObject({
      content: [{ type: 'thinking', thinking: 'limited reasoning' }],
      stop_reason: 'max_tokens',
    });
    expect(upstream.calls.map((call) => call.kind)).toEqual(['generate']);
  });

  it('rejects a thinking-only response with a normal STOP finish', async () => {
    const upstream = createUpstream({
      generate: {
        candidates: [
          {
            content: { role: 'model', parts: [{ thought: true, text: 'hidden reasoning' }] },
            finishReason: 'STOP',
          },
        ],
      },
    });
    const { anthropicService } = createGateway(upstream, createLease([createAccount('acc-1')]));

    await expect(
      anthropicService.handleAnthropicMessages({
        model: 'gemini-3.1-pro-low',
        max_tokens: 128,
        stream: false,
        messages: [{ role: 'user', content: 'Reply.' }],
      }),
    ).rejects.toThrow('Upstream returned empty thinking-only response');
    expect(upstream.calls.map((call) => call.kind)).toEqual(['generate']);
  });

  it('rejects an unknown direct response shape without starting aggregation', async () => {
    const upstream = createUpstream({ generate: {}, streamFrames: [] });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);
    const reply = createReply();

    await controller.anthropicMessages(
      {
        max_tokens: 16,
        messages: [{ content: '.', role: 'user' }],
        model: 'claude-sonnet-4-5',
        stream: false,
      } as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(502);
    expect(reply.body).toMatchObject({
      error: { message: 'Upstream returned an invalid generation response.', type: 'api_error' },
      type: 'error',
    });
    expect(upstream.calls.map((call) => call.kind)).toEqual(['generate']);
  });

  it('streams an upstream fixture as the Anthropic event sequence a client expects', async () => {
    const upstream = createUpstream({
      streamFrames: [
        geminiStreamFrame({
          candidates: [{ content: { parts: [{ text: 'partial ' }], role: 'model' } }],
          modelVersion: 'gemini-3-flash',
          responseId: 'upstream-response-1',
        }),
        geminiStreamFrame({
          candidates: [
            { content: { parts: [{ text: 'answer' }], role: 'model' }, finishReason: 'STOP' },
          ],
          modelVersion: 'gemini-3-flash',
        }),
      ],
    });
    const lease = createLease([createAccount('acc-1')]);
    const { anthropicService } = createGateway(upstream, lease);

    const result = await anthropicService.handleAnthropicMessages({
      max_tokens: 128,
      messages: [{ content: 'stream please', role: 'user' }],
      model: 'claude-sonnet-4-5',
      stream: true,
    } as never);
    const payload = await collect(result as Observable<string>);

    const events = payload
      .split('\n')
      .filter((line) => line.startsWith('event: '))
      .map((line) => line.slice('event: '.length));

    expect(events[0]).toBe('message_start');
    expect(events).toContain('content_block_delta');
    expect(events.at(-1)).toBe('message_stop');
    expect(payload).toContain('partial ');
    expect(payload).toContain('answer');
    expect(payload).toContain('"id":"msg_upstream-response-1"');
  });

  it('recovers a registered streamed tool leak and supplies zero start usage', async () => {
    const leaked = 'call:default_api:Read{file_path:"C:/tmp/a.txt"}';
    const upstream = createUpstream({
      streamFrames: [
        geminiStreamFrame({
          candidates: [
            { content: { parts: [{ text: leaked }], role: 'model' }, finishReason: 'STOP' },
          ],
          modelVersion: 'gemini-3-flash',
          responseId: 'upstream-response-1',
        }),
      ],
    });
    const lease = createLease([createAccount('acc-1')]);
    const { anthropicService } = createGateway(upstream, lease);

    const result = await anthropicService.handleAnthropicMessages({
      max_tokens: 32,
      messages: [{ content: 'read it', role: 'user' }],
      model: 'claude-sonnet-4-5',
      stream: true,
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    } as never);
    const payload = await collect(result as Observable<string>);

    expect(payload).toContain('"usage":{"input_tokens":0,"output_tokens":0}');
    expect(payload).toContain('"type":"tool_use"');
    expect(payload).toContain('"name":"Read"');
    expect(payload).toContain('"partial_json":"{\\"file_path\\":\\"C:/tmp/a.txt\\"}"');
    expect(payload).toContain('"stop_reason":"tool_use"');
    expect(payload).not.toContain(`"type":"text_delta","text":"${leaked}`);
  });

  it('moves to the next account when the first one is rejected upstream', async () => {
    let attempt = 0;
    const upstream = createUpstream({
      generate: () => {
        attempt += 1;
        if (attempt === 1) {
          throw new UpstreamRequestError({
            body: '{"error":{"status":"PERMISSION_DENIED"}}',
            message: 'The caller does not have permission',
            status: 403,
          });
        }
        return geminiTextResponse('second account answered');
      },
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);
    const reply = createReply();

    await controller.anthropicMessages(
      {
        max_tokens: 16,
        messages: [{ content: 'hello', role: 'user' }],
        model: 'claude-sonnet-4-5',
        stream: false,
      } as never,
      reply as never,
    );

    expect(lease.penalties).toEqual([{ accountId: 'acc-1', kind: 'forbidden' }]);
    expect(reply.body).toMatchObject({
      content: [{ text: 'second account answered', type: 'text' }],
    });
  });

  it('binds signature provenance to the physical model after a web-search remap', async () => {
    const sessionId = 'anthropic-real-path-remap';
    const request = {
      max_tokens: 128,
      metadata: { user_id: sessionId },
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use' as const, id: 'call_old', name: 'lookup', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: 'call_old',
              content: 'actual lookup result',
            },
          ],
        },
      ],
      model: 'gpt-oss-120b-medium',
      stream: false,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    };
    const sessionKey = resolveAnthropicSessionScope(request).cacheKey;
    const staleSignature = 'gpt-oss-signature'.repeat(4);
    const returnedSignature = 'gemini-signature'.repeat(4);
    SignatureStore.store({
      signature: staleSignature,
      model: 'gpt-oss-120b-medium',
      family: 'gpt-oss-120b-medium',
      familyModel: 'gpt-oss-120b-medium',
      sessionKey,
      toolCallId: 'call_old',
    });
    const upstream = createUpstream({
      generate: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { id: 'call_new', name: 'lookup', args: {} },
                  thoughtSignature: returnedSignature,
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    });
    const lease = createLease([createAccount('acc-1')]);
    const { anthropicService } = createGateway(upstream, lease);

    await anthropicService.handleAnthropicMessages(request);

    const body = upstream.calls[0]?.body;
    const historicalToolCall = body?.request.contents[0]?.parts.find((part) => part.functionCall);
    expect(body?.model).toBe('gemini-3-flash');
    expect(historicalToolCall?.thoughtSignature).not.toBe(staleSignature);
    expect(
      SignatureStore.getAt({ model: 'gpt-oss-120b-medium', sessionKey, messageCount: 1 }),
    ).toBeNull();
    expect(SignatureStore.getAt({ model: 'gemini-3-flash', sessionKey, messageCount: 2 })).toBe(
      returnedSignature,
    );
  });

  it('never replays a signature error after the upstream stream has been returned', async () => {
    const upstream = createUpstream({ streamFrames: [] });
    const returnedStream = new PassThrough();
    upstream.streamGenerateInternal.mockImplementation(async (body, accessToken) => {
      upstream.calls.push({ accessToken, body, kind: 'stream' });
      return returnedStream;
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const { anthropicService } = createGateway(upstream, lease);
    returnedStream.write(
      Buffer.from(
        `data: ${JSON.stringify(
          geminiStreamFrame({
            candidates: [{ content: { parts: [{ text: 'ready' }], role: 'model' } }],
            modelVersion: 'gemini-3-flash',
            responseId: 'upstream-response-1',
          }),
        )}\n\n`,
      ),
    );

    const result = await anthropicService.handleAnthropicMessages({
      max_tokens: 16,
      messages: [{ content: 'hello', role: 'user' }],
      model: 'claude-sonnet-4-5',
      stream: true,
    } as never);
    const completion = collect(result as Observable<string>);
    returnedStream.emit(
      'error',
      new UpstreamRequestError({ message: 'Invalid thought signature.', status: 400 }),
    );

    const chunks = await completion;
    expect(chunks).toContain('event: error');
    expect(chunks).toContain('Invalid thought signature.');
    expect(upstream.calls).toHaveLength(1);
    expect(lease.penalties).toEqual([]);
  });

  it('answers an exhausted rotation in the Anthropic error envelope', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('unreachable') });
    const lease = createLease([]);
    const controller = new AnthropicController(createGateway(upstream, lease).anthropicService);
    const reply = createReply();

    await controller.anthropicMessages(
      {
        max_tokens: 16,
        messages: [{ content: 'hello', role: 'user' }],
        model: 'claude-sonnet-4-5',
        stream: false,
      } as never,
      reply as never,
    );

    expect(reply.body).toMatchObject({ type: 'error' });
    expect(upstream.calls).toHaveLength(0);
  });
});
