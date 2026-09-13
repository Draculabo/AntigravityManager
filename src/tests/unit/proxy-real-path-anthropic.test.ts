import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';
import { PassThrough } from 'stream';

import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
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
  '@/modules/proxy-gateway/server/common/utils/request-user-agent',
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

  it('returns a minimal non-empty response when both direct and streamed upstream responses are empty', async () => {
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

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.body).toMatchObject({
      content: [{ text: '.', type: 'text' }],
      stop_reason: 'end_turn',
    });
    expect(upstream.calls.map((call) => call.kind)).toEqual(['generate', 'stream']);
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

  it('repairs an invalid thought signature once on the same account and physical model', async () => {
    let attempt = 0;
    const upstream = createUpstream({
      generate: () => {
        attempt += 1;
        if (attempt === 1) {
          throw new UpstreamRequestError({
            message: 'Invalid thought signature.',
            status: 400,
          });
        }
        return geminiTextResponse('recovered answer');
      },
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const { anthropicService } = createGateway(upstream, lease);

    const response = await anthropicService.handleAnthropicMessages({
      max_tokens: 128,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'preserved reasoning',
              signature: 'corrupted signature',
            },
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'lookup',
              input: {},
            },
          ],
        },
        {
          role: 'user',
          content: 'continue',
        },
      ],
      model: 'claude-sonnet-4-5',
      stream: false,
    } as never);

    expect(response).toMatchObject({
      content: [{ text: 'recovered answer', type: 'text' }],
    });
    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls.map((call) => call.accessToken)).toEqual([
      'access-acc-1',
      'access-acc-1',
    ]);
    expect(upstream.calls.map((call) => call.body.model)).toEqual([
      'claude-sonnet-4-6-thinking',
      'claude-sonnet-4-6-thinking',
    ]);
    expect(lease.penalties).toEqual([]);
    expect(upstream.calls[0]?.body.request.contents[0]?.parts[0]).toMatchObject({
      thought: true,
      thoughtSignature: 'corrupted signature',
    });
    expect(upstream.calls[1]?.body.request.contents[0]?.parts[0]).toEqual({
      text: 'preserved reasoning',
    });
    expect(upstream.calls[1]?.body.request.contents[1]?.parts[0]?.text).toContain(
      '[Tool call was interrupted by user.]',
    );
    expect(upstream.calls[1]?.body.request.contents[2]?.parts[0]?.text).toContain(
      '[System Recovery]',
    );
  });

  it('binds signature provenance to the physical model after a web-search remap', async () => {
    const sessionId = 'anthropic-real-path-remap';
    const sessionKey = `anthropic:${sessionId}`;
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

    await anthropicService.handleAnthropicMessages({
      max_tokens: 128,
      metadata: { user_id: sessionId },
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_old', name: 'lookup', input: {} }],
        },
      ],
      model: 'gpt-oss-120b-medium',
      stream: false,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    } as never);

    const body = upstream.calls[0]?.body;
    const historicalToolCall = body?.request.contents[0]?.parts.find((part) => part.functionCall);
    expect(body?.model).toBe('gemini-3-flash');
    expect(historicalToolCall?.thoughtSignature).not.toBe(staleSignature);
    expect(
      SignatureStore.getAt({ model: 'gpt-oss-120b-medium', sessionKey, messageCount: 1 }),
    ).toBeNull();
    expect(SignatureStore.getAt({ model: 'gemini-3-flash', sessionKey, messageCount: 1 })).toBe(
      returnedSignature,
    );
  });

  it('stops after the one repair retry without rotating or penalising', async () => {
    const signatureError = new UpstreamRequestError({
      message: 'Invalid thought signature.',
      status: 400,
    });
    const upstream = createUpstream({
      generate: () => {
        throw signatureError;
      },
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const { anthropicService } = createGateway(upstream, lease);

    await expect(
      anthropicService.handleAnthropicMessages({
        max_tokens: 16,
        messages: [{ content: 'hello', role: 'user' }],
        model: 'claude-sonnet-4-5',
        stream: false,
      } as never),
    ).rejects.toBe(signatureError);

    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls.every((call) => call.accessToken === 'access-acc-1')).toBe(true);
    expect(lease.penalties).toEqual([]);
  });

  it('returns a different recovery failure to the ordinary account policy', async () => {
    let attempt = 0;
    const upstream = createUpstream({
      generate: () => {
        attempt += 1;
        if (attempt === 1) {
          throw new UpstreamRequestError({
            message: 'Invalid thought signature.',
            status: 400,
          });
        }
        if (attempt === 2) {
          throw new UpstreamRequestError({
            message: 'The caller does not have permission',
            status: 403,
          });
        }
        return geminiTextResponse('second account recovered');
      },
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const { anthropicService } = createGateway(upstream, lease);

    const response = await anthropicService.handleAnthropicMessages({
      max_tokens: 16,
      messages: [{ content: 'hello', role: 'user' }],
      model: 'claude-sonnet-4-5',
      stream: false,
    } as never);

    expect(response).toMatchObject({
      content: [{ text: 'second account recovered', type: 'text' }],
    });
    expect(upstream.calls.map((call) => call.accessToken)).toEqual([
      'access-acc-1',
      'access-acc-1',
      'access-acc-2',
    ]);
    expect(lease.penalties).toEqual([{ accountId: 'acc-1', kind: 'forbidden' }]);
  });

  it('repairs a signature failure while establishing a stream, before any client event', async () => {
    const signatureError = new UpstreamRequestError({
      message: 'Invalid thought signature.',
      status: 400,
    });
    const upstream = createUpstream({ streamError: signatureError });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const { anthropicService } = createGateway(upstream, lease);

    await expect(
      anthropicService.handleAnthropicMessages({
        max_tokens: 16,
        messages: [{ content: 'hello', role: 'user' }],
        model: 'claude-sonnet-4-5',
        stream: true,
      } as never),
    ).rejects.toBe(signatureError);

    expect(upstream.calls).toHaveLength(2);
    expect(upstream.calls.every((call) => call.kind === 'stream')).toBe(true);
    expect(upstream.calls.every((call) => call.accessToken === 'access-acc-1')).toBe(true);
    expect(lease.penalties).toEqual([]);
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

    await expect(completion).rejects.toThrow('Invalid thought signature.');
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
