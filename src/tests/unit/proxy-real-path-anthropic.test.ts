import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';

import { AnthropicController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.controller';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
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
