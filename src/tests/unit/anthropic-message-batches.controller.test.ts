import { createBatchHttpApp, batchTestHeaders } from '../helpers/batch-http-app';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { BatchRunnerService } from '@/modules/proxy-gateway/server/modules/batch/batch-runner.service';
import type { BatchExecutionTarget } from '@/modules/proxy-gateway/server/modules/batch/batch-request-executor';
import { BatchService } from '@/modules/proxy-gateway/server/modules/batch/batch.service';

function sent(reply: LightMyRequestResponse): any {
  return String(reply.headers['content-type']).startsWith('application/x-jsonl')
    ? reply.body
    : reply.json();
}

function statusOf(reply: LightMyRequestResponse): number {
  return reply.statusCode;
}

function createTarget(handler: (request: unknown) => Promise<unknown>) {
  return {
    handleChatCompletions: vi.fn(),
    handleAnthropicMessages: vi.fn(handler),
    handleGeminiGenerateContent: vi.fn(),
  } satisfies Record<keyof BatchExecutionTarget, ReturnType<typeof vi.fn>>;
}

async function createController(target: ReturnType<typeof createTarget>, maxConcurrency = 2) {
  const runner = new BatchRunnerService({ maxConcurrency });
  runner.setExecutionTarget(target as unknown as BatchExecutionTarget);
  return { controller: await createBatchHttpApp(new BatchService(runner)), runner };
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
    const { controller, runner } = await createController(target);

    const createReply = await controller.inject({
      method: 'POST',
      url: '/v1/messages/batches',
      headers: batchTestHeaders,
      payload: {
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
    });

    expect(statusOf(createReply)).toBe(200);
    const created = sent(createReply);
    expect(created.id).toMatch(/^msgbatch_/u);
    expect(created.results_url).toBeNull();

    await runner.drain();

    const getReply = await controller.inject({
      method: 'GET',
      url: `/v1/messages/batches/${encodeURIComponent(created.id)}`,
      headers: batchTestHeaders,
    });
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
    const { controller, runner } = await createController(target);

    const createReply = await controller.inject({
      method: 'POST',
      url: '/v1/messages/batches',
      headers: batchTestHeaders,
      payload: {
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
    });
    const created = sent(createReply);
    await runner.drain();

    const resultsReply = await controller.inject({
      method: 'GET',
      url: `/v1/messages/batches/${encodeURIComponent(created.id)}/results`,
      headers: batchTestHeaders,
    });
    expect(statusOf(resultsReply)).toBe(200);
    const jsonl = sent(resultsReply) as string;
    expect({
      contentType: resultsReply.headers['content-type'],
      contentLength: resultsReply.headers['content-length'],
    }).toEqual({
      contentType: 'application/x-jsonl; charset=utf-8',
      contentLength: String(Buffer.byteLength(jsonl, 'utf8')),
    });
    const lines = jsonl
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines.find((line) => line.custom_id === 'good')?.result.type).toBe('succeeded');
    expect(lines.find((line) => line.custom_id === 'bad')?.result.type).toBe('errored');
  });

  it('refuses results before the batch has ended', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target = createTarget(async () => {
      await gate;
      return reply('late');
    });
    const { controller } = await createController(target, 1);

    const createReply = await controller.inject({
      method: 'POST',
      url: '/v1/messages/batches',
      headers: batchTestHeaders,
      payload: {
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
    });
    const created = sent(createReply);

    const resultsReply = await controller.inject({
      method: 'GET',
      url: `/v1/messages/batches/${encodeURIComponent(created.id)}/results`,
      headers: batchTestHeaders,
    });
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
    const { controller, runner } = await createController(target, 1);

    const createReply = await controller.inject({
      method: 'POST',
      url: '/v1/messages/batches',
      headers: batchTestHeaders,
      payload: {
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
    });
    const created = sent(createReply);

    for (
      let attempt = 0;
      attempt < 200 && target.handleAnthropicMessages.mock.calls.length < 1;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const cancelReply = await controller.inject({
      method: 'POST',
      url: `/v1/messages/batches/${encodeURIComponent(created.id)}/cancel`,
      headers: batchTestHeaders,
    });
    expect(sent(cancelReply).processing_status).toBe('canceling');

    release?.();
    await runner.drain();

    const getReply = await controller.inject({
      method: 'GET',
      url: `/v1/messages/batches/${encodeURIComponent(created.id)}`,
      headers: batchTestHeaders,
    });
    const batch = sent(getReply);
    expect(batch.processing_status).toBe('ended');
    expect(batch.request_counts).toMatchObject({ canceled: 2, succeeded: 0 });
  });

  it('deletes an ended batch and returns the Anthropic not-found envelope on later reads', async () => {
    const target = createTarget(async () => reply('done'));
    const { controller, runner } = await createController(target);

    const createReply = await controller.inject({
      method: 'POST',
      url: '/v1/messages/batches',
      headers: batchTestHeaders,
      payload: {
        requests: [
          {
            custom_id: 'line-1',
            params: {
              model: 'claude-3',
              max_tokens: 8,
              messages: [{ role: 'user', content: 'delete me' }],
            },
          },
        ],
      },
    });
    const created = sent(createReply);
    await runner.drain();

    const removeReply = await controller.inject({
      method: 'DELETE',
      url: `/v1/messages/batches/${encodeURIComponent(created.id)}`,
      headers: batchTestHeaders,
    });

    expect(statusOf(removeReply)).toBe(200);
    expect(sent(removeReply)).toEqual({
      id: created.id,
      type: 'message_batch_deleted',
    });

    const getReply = await controller.inject({
      method: 'GET',
      url: `/v1/messages/batches/${encodeURIComponent(created.id)}`,
      headers: batchTestHeaders,
    });

    expect(statusOf(getReply)).toBe(404);
    expect(sent(getReply)).toMatchObject({
      type: 'error',
      error: { type: 'not_found_error' },
    });
  });

  it('answers an unknown batch id with a 404 in the Anthropic error envelope, not an empty success', async () => {
    const target = createTarget(async () => reply('unused'));
    const { controller } = await createController(target);

    const reply2 = await controller.inject({
      method: 'GET',
      url: `/v1/messages/batches/${encodeURIComponent(`msgbatch_${'0'.repeat(24)}`)}`,
      headers: batchTestHeaders,
    });

    expect(statusOf(reply2)).toBe(404);
    expect(sent(reply2)).toMatchObject({ type: 'error', error: { type: 'not_found_error' } });
  });

  it('expires a batch that outlives its completion window', async () => {
    const target = createTarget(async () => reply('unused'));
    const runner = new BatchRunnerService({ maxConcurrency: 1 });
    runner.setExecutionTarget(target as unknown as BatchExecutionTarget);
    const controller = await createBatchHttpApp(new BatchService(runner));

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

    const getReply = await controller.inject({
      method: 'GET',
      url: `/v1/messages/batches/${encodeURIComponent(`msgbatch_${created.id}`)}`,
      headers: batchTestHeaders,
    });
    const batch = sent(getReply);
    expect(batch.processing_status).toBe('ended');
    expect(batch.request_counts.expired).toBe(1);
  });

  describe('list pagination', () => {
    function createJob(runner: BatchRunnerService, createdAtMs: number) {
      return runner.create(
        {
          dialect: 'anthropic',
          endpoint: '/v1/messages',
          requests: [
            { customId: 'line-1', body: { model: 'claude-3', max_tokens: 8, messages: [] } },
          ],
        },
        createdAtMs,
      );
    }

    function makeRunner() {
      const target = createTarget(async () => reply('unused'));
      const runner = new BatchRunnerService({ maxConcurrency: 1 });
      runner.setExecutionTarget(target as unknown as BatchExecutionTarget);
      return runner;
    }

    it('walks forward with after_id, reaches the terminal page, and 404s on an unknown after_id instead of restarting at page one', async () => {
      const runner = makeRunner();
      const controller = await createBatchHttpApp(new BatchService(runner));

      const base = Date.now();
      const jobs = [0, 1, 2].map((i) => createJob(runner, base + i * 1000));
      // `list()` sorts newest-first: job 2 was created last, so it leads.
      const newestFirst = [jobs[2], jobs[1], jobs[0]];

      const page1Reply = await controller.inject({
        method: 'GET',
        url: '/v1/messages/batches',
        headers: batchTestHeaders,
        query: { limit: '2' },
      });
      const page1 = sent(page1Reply);
      expect(page1.data.map((batch: any) => batch.id)).toEqual([
        `msgbatch_${newestFirst[0].id}`,
        `msgbatch_${newestFirst[1].id}`,
      ]);
      expect(page1.has_more).toBe(true);

      const page2Reply = await controller.inject({
        method: 'GET',
        url: '/v1/messages/batches',
        headers: batchTestHeaders,
        query: { limit: '2', after_id: page1.last_id },
      });
      const page2 = sent(page2Reply);
      expect(page2.data.map((batch: any) => batch.id)).toEqual([`msgbatch_${newestFirst[2].id}`]);
      expect(page2.has_more).toBe(false);

      const unknownReply = await controller.inject({
        method: 'GET',
        url: '/v1/messages/batches',
        headers: batchTestHeaders,
        query: { limit: '2', after_id: `msgbatch_${'f'.repeat(24)}` },
      });
      expect(statusOf(unknownReply)).toBe(404);
      expect(sent(unknownReply)).toMatchObject({
        type: 'error',
        error: { type: 'not_found_error' },
      });
    });

    it('walks backward with before_id and reaches the terminal (newest) page', async () => {
      const runner = makeRunner();
      const controller = await createBatchHttpApp(new BatchService(runner));

      const base = Date.now();
      const jobs = [0, 1, 2].map((i) => createJob(runner, base + i * 1000));
      const newestFirst = [jobs[2], jobs[1], jobs[0]];

      const step1Reply = await controller.inject({
        method: 'GET',
        url: '/v1/messages/batches',
        headers: batchTestHeaders,
        query: { limit: '1', before_id: `msgbatch_${newestFirst[2].id}` },
      });
      const step1 = sent(step1Reply);
      expect(step1.data.map((batch: any) => batch.id)).toEqual([`msgbatch_${newestFirst[1].id}`]);
      expect(step1.has_more).toBe(true);

      const step2Reply = await controller.inject({
        method: 'GET',
        url: '/v1/messages/batches',
        headers: batchTestHeaders,
        query: { limit: '1', before_id: `msgbatch_${newestFirst[1].id}` },
      });
      const step2 = sent(step2Reply);
      expect(step2.data.map((batch: any) => batch.id)).toEqual([`msgbatch_${newestFirst[0].id}`]);
      expect(step2.has_more).toBe(false);
    });

    it('rejects after_id and before_id given together', async () => {
      const runner = makeRunner();
      const controller = await createBatchHttpApp(new BatchService(runner));
      const job = createJob(runner, Date.now());

      const reply2 = await controller.inject({
        method: 'GET',
        url: '/v1/messages/batches',
        headers: batchTestHeaders,
        query: { after_id: `msgbatch_${job.id}`, before_id: `msgbatch_${job.id}` },
      });
      expect(statusOf(reply2)).toBe(400);
      expect(sent(reply2)).toMatchObject({ error: { type: 'invalid_request_error' } });
    });

    it('enforces the documented 1-1000 limit range instead of accepting anything', async () => {
      const runner = makeRunner();
      const controller = await createBatchHttpApp(new BatchService(runner));

      const tooLow = await controller.inject({
        method: 'GET',
        url: '/v1/messages/batches',
        headers: batchTestHeaders,
        query: { limit: '0' },
      });
      expect(statusOf(tooLow)).toBe(400);
      expect(sent(tooLow)).toMatchObject({ error: { type: 'invalid_request_error' } });

      const tooHigh = await controller.inject({
        method: 'GET',
        url: '/v1/messages/batches',
        headers: batchTestHeaders,
        query: { limit: '1001' },
      });
      expect(statusOf(tooHigh)).toBe(400);
      expect(sent(tooHigh)).toMatchObject({ error: { type: 'invalid_request_error' } });
    });
  });
});
