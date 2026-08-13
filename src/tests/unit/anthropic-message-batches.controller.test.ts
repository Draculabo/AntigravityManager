import { describe, expect, it, vi } from 'vitest';

import { AnthropicMessageBatchesController } from '@/modules/proxy-gateway/server/modules/batch/anthropic-message-batches.controller';
import { BatchRunnerService } from '@/modules/proxy-gateway/server/modules/batch/batch-runner.service';
import type { BatchExecutionTarget } from '@/modules/proxy-gateway/server/modules/batch/batch-request-executor';

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

function createTarget(handler: (request: unknown) => Promise<unknown>) {
  return {
    handleChatCompletions: vi.fn(),
    handleAnthropicMessages: vi.fn(handler),
    handleGeminiGenerateContent: vi.fn(),
  } satisfies Record<keyof BatchExecutionTarget, ReturnType<typeof vi.fn>>;
}

function createController(target: ReturnType<typeof createTarget>, maxConcurrency = 2) {
  const runner = new BatchRunnerService(
    { maxConcurrency },
    target as unknown as BatchExecutionTarget,
  );
  return { controller: new AnthropicMessageBatchesController(runner), runner };
}

function reply(text: string) {
  return {
    id: 'msg_1',
    type: 'message',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  };
}

describe('AnthropicMessageBatchesController', () => {
  it('creates a batch from inline requests and runs it to completion', async () => {
    const target = createTarget(async () => reply('ok'));
    const { controller, runner } = createController(target);

    const createReply = createReplyMock();
    controller.create(
      {
        requests: [
          {
            custom_id: 'line-1',
            params: {
              model: 'claude-3',
              max_tokens: 16,
              messages: [{ role: 'user', content: 'hi' }],
            },
          },
        ],
      },
      createReply as never,
    );

    expect(statusOf(createReply)).toBe(200);
    const created = sent(createReply);
    expect(created.id).toMatch(/^msgbatch_/u);
    expect(created.results_url).toBeNull();

    await runner.drain();

    const getReply = createReplyMock();
    controller.get(created.id, getReply as never);
    const batch = sent(getReply);
    expect(batch.processing_status).toBe('ended');
    expect(batch.request_counts).toMatchObject({ succeeded: 1, errored: 0 });
    expect(batch.results_url).toBe(`/v1/messages/batches/${created.id}/results`);
  });

  it('isolates a failing request from the rest of the batch and streams JSONL results', async () => {
    const target = createTarget(async (request) => {
      const content = (request as { messages: Array<{ content: string }> }).messages[0].content;
      if (content === 'bad') {
        throw Object.assign(new Error('upstream rejected'), {
          status: 400,
          code: 'invalid_request_error',
        });
      }
      return reply(`echo:${content}`);
    });
    const { controller, runner } = createController(target);

    const createReply = createReplyMock();
    controller.create(
      {
        requests: [
          {
            custom_id: 'good',
            params: {
              model: 'claude-3',
              max_tokens: 8,
              messages: [{ role: 'user', content: 'ok' }],
            },
          },
          {
            custom_id: 'bad',
            params: {
              model: 'claude-3',
              max_tokens: 8,
              messages: [{ role: 'user', content: 'bad' }],
            },
          },
        ],
      },
      createReply as never,
    );
    const created = sent(createReply);
    await runner.drain();

    const resultsReply = createReplyMock();
    controller.results(created.id, resultsReply as never);
    expect(statusOf(resultsReply)).toBe(200);
    const jsonl = sent(resultsReply) as string;
    const lines = jsonl
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines.find((line) => line.custom_id === 'good')?.result.type).toBe('succeeded');
    expect(lines.find((line) => line.custom_id === 'bad')?.result.type).toBe('errored');
  });

  it('refuses results before the batch has ended', () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target = createTarget(async () => {
      await gate;
      return reply('late');
    });
    const { controller } = createController(target, 1);

    const createReply = createReplyMock();
    controller.create(
      {
        requests: [
          {
            custom_id: 'line-1',
            params: {
              model: 'claude-3',
              max_tokens: 8,
              messages: [{ role: 'user', content: 'hi' }],
            },
          },
        ],
      },
      createReply as never,
    );
    const created = sent(createReply);

    const resultsReply = createReplyMock();
    controller.results(created.id, resultsReply as never);
    expect(statusOf(resultsReply)).toBe(400);

    release?.();
  });

  it('cancels a mid-flight batch, discarding the answer of the request already in flight', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target = createTarget(async () => {
      await gate;
      return reply('too late');
    });
    const { controller, runner } = createController(target, 1);

    const createReply = createReplyMock();
    controller.create(
      {
        requests: [
          {
            custom_id: 'a',
            params: {
              model: 'claude-3',
              max_tokens: 8,
              messages: [{ role: 'user', content: 'a' }],
            },
          },
          {
            custom_id: 'b',
            params: {
              model: 'claude-3',
              max_tokens: 8,
              messages: [{ role: 'user', content: 'b' }],
            },
          },
        ],
      },
      createReply as never,
    );
    const created = sent(createReply);

    for (
      let attempt = 0;
      attempt < 200 && target.handleAnthropicMessages.mock.calls.length < 1;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const cancelReply = createReplyMock();
    controller.cancel(created.id, cancelReply as never);
    expect(sent(cancelReply).processing_status).toBe('canceling');

    release?.();
    await runner.drain();

    const getReply = createReplyMock();
    controller.get(created.id, getReply as never);
    const batch = sent(getReply);
    expect(batch.processing_status).toBe('ended');
    expect(batch.request_counts).toMatchObject({ canceled: 2, succeeded: 0 });
  });

  it('answers an unknown batch id with a 404 in the Anthropic error envelope, not an empty success', () => {
    const target = createTarget(async () => reply('unused'));
    const { controller } = createController(target);

    const reply2 = createReplyMock();
    controller.get(`msgbatch_${'0'.repeat(24)}`, reply2 as never);

    expect(statusOf(reply2)).toBe(404);
    expect(sent(reply2)).toMatchObject({ type: 'error', error: { type: 'not_found_error' } });
  });

  it('expires a batch that outlives its completion window', () => {
    const target = createTarget(async () => reply('unused'));
    const runner = new BatchRunnerService(
      { maxConcurrency: 1 },
      target as unknown as BatchExecutionTarget,
    );
    const controller = new AnthropicMessageBatchesController(runner);

    const created = runner.create(
      {
        dialect: 'anthropic',
        endpoint: '/v1/messages',
        requests: [
          { customId: 'line-1', body: { model: 'claude-3', max_tokens: 8, messages: [] } },
        ],
        completionWindowMs: 1,
      },
      Date.now() - 10_000,
    );

    const getReply = createReplyMock();
    controller.get(`msgbatch_${created.id}`, getReply as never);
    const batch = sent(getReply);
    expect(batch.processing_status).toBe('ended');
    expect(batch.request_counts.expired).toBe(1);
  });
});
