import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';

import { AnthropicCompleteController } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic-complete.controller';

function createReplyMock() {
  const reply: Record<string, unknown> = {};
  reply.status = vi.fn(() => reply);
  reply.header = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply;
}

function sent(reply: Record<string, unknown>): any {
  return (reply.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
}

function statusOf(reply: Record<string, unknown>): unknown {
  return (reply.status as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
}

describe('AnthropicCompleteController', () => {
  it('adapts a legacy prompt into a Messages call and renders the old response shape', async () => {
    const proxyService = {
      handleAnthropicMessages: vi.fn(async (request: any) => {
        expect(request.messages).toEqual([{ role: 'user', content: 'Hello there' }]);
        expect(request.max_tokens).toBe(64);
        return {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-3',
          content: [{ type: 'text', text: 'Hi! How can I help?' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 5 },
        };
      }),
    };
    const controller = new AnthropicCompleteController(proxyService as any);
    const reply = createReplyMock();

    await controller.complete(
      {
        model: 'claude-3',
        prompt: '\n\nHuman: Hello there\n\nAssistant:',
        max_tokens_to_sample: 64,
      },
      reply as never,
    );

    expect(statusOf(reply)).toBe(200);
    expect(sent(reply)).toMatchObject({
      type: 'completion',
      completion: ' Hi! How can I help?',
      stop_reason: 'end_turn',
      model: 'claude-3',
    });
    expect(reply.header).toHaveBeenCalledWith('request-id', expect.stringMatching(/^req_/u));
  });

  it('keeps a prefilled assistant turn from the old prompt format', async () => {
    const proxyService = {
      handleAnthropicMessages: vi.fn(async (request: any) => {
        expect(request.messages).toEqual([
          { role: 'user', content: 'Continue this story' },
          { role: 'assistant', content: 'Once upon a time' },
        ]);
        return {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          model: 'claude-3',
          content: [{ type: 'text', text: ', there was a proxy.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }),
    };
    const controller = new AnthropicCompleteController(proxyService as any);
    const reply = createReplyMock();

    await controller.complete(
      {
        model: 'claude-3',
        prompt: '\n\nHuman: Continue this story\n\nAssistant: Once upon a time',
        max_tokens_to_sample: 32,
      },
      reply as never,
    );

    expect(statusOf(reply)).toBe(200);
  });

  it('rejects a streaming request with 400 rather than half-serving Messages SSE', async () => {
    const proxyService = { handleAnthropicMessages: vi.fn() };
    const controller = new AnthropicCompleteController(proxyService as any);
    const reply = createReplyMock();

    await controller.complete(
      { model: 'claude-3', prompt: 'hi', max_tokens_to_sample: 16, stream: true },
      reply as never,
    );

    expect(statusOf(reply)).toBe(400);
    expect(proxyService.handleAnthropicMessages).not.toHaveBeenCalled();
    expect(sent(reply)).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
  });

  it('rejects a body missing max_tokens_to_sample', async () => {
    const proxyService = { handleAnthropicMessages: vi.fn() };
    const controller = new AnthropicCompleteController(proxyService as any);
    const reply = createReplyMock();

    await controller.complete({ model: 'claude-3', prompt: 'hi' }, reply as never);

    expect(statusOf(reply)).toBe(400);
    expect(proxyService.handleAnthropicMessages).not.toHaveBeenCalled();
  });

  it('refuses an Observable answer instead of forwarding a stream from upstream', async () => {
    const proxyService = {
      handleAnthropicMessages: vi.fn(async () => of('data: unexpected\n\n')),
    };
    const controller = new AnthropicCompleteController(proxyService as any);
    const reply = createReplyMock();

    await controller.complete(
      { model: 'claude-3', prompt: 'hi', max_tokens_to_sample: 16 },
      reply as never,
    );

    expect(statusOf(reply)).toBe(400);
  });

  it('propagates an upstream failure through the Anthropic error envelope', async () => {
    const proxyService = {
      handleAnthropicMessages: vi.fn(async () => {
        throw Object.assign(new Error('no available accounts'), { httpStatus: 429 });
      }),
    };
    const controller = new AnthropicCompleteController(proxyService as any);
    const reply = createReplyMock();

    await controller.complete(
      { model: 'claude-3', prompt: 'hi', max_tokens_to_sample: 16 },
      reply as never,
    );

    expect(statusOf(reply)).toBe(429);
    expect(sent(reply)).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } });
  });
});
