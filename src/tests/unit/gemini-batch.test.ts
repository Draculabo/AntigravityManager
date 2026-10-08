import { createBatchHttpApp, batchTestHeaders } from '../helpers/batch-http-app';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { BatchRunnerService } from '@/modules/proxy-gateway/server/modules/batch/batch-runner.service';
import type { BatchExecutionTarget } from '@/modules/proxy-gateway/server/modules/batch/batch-request-executor';
import { BatchService } from '@/modules/proxy-gateway/server/modules/batch/batch.service';
import { respondGeminiBatchGenerateContent } from '@/modules/proxy-gateway/server/modules/batch/gemini-batch-submit';
import { GeminiController } from '@/modules/proxy-gateway/server/modules/gemini/gemini.controller';

interface ReplyMock {
  status: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

function createReplyMock(): ReplyMock {
  const reply: ReplyMock = {
    status: vi.fn(),
    header: vi.fn(),
    send: vi.fn(),
  };
  reply.status.mockImplementation(() => reply);
  reply.header.mockImplementation(() => reply);
  reply.send.mockImplementation(() => reply);
  return reply;
}

function sent(reply: ReturnType<typeof createReplyMock> | LightMyRequestResponse): any {
  if ('json' in reply) {
    return String(reply.headers['content-type']).startsWith('application/x-jsonl')
      ? reply.body
      : reply.json();
  }
  return reply.send.mock.calls.at(-1)?.[0];
}

function statusOf(reply: ReturnType<typeof createReplyMock> | LightMyRequestResponse): unknown {
  if ('statusCode' in reply) {
    return reply.statusCode;
  }
  return reply.status.mock.calls.at(-1)?.[0];
}

function createTarget(handler: (model: string, request: unknown) => Promise<unknown>) {
  return {
    handleChatCompletions: vi.fn(),
    handleAnthropicMessages: vi.fn(),
    handleGeminiGenerateContent: vi.fn(handler),
  } satisfies Record<keyof BatchExecutionTarget, ReturnType<typeof vi.fn>>;
}

function createRunner(target: ReturnType<typeof createTarget>, maxConcurrency = 2) {
  const runner = new BatchRunnerService({ maxConcurrency });
  runner.setExecutionTarget(target as unknown as BatchExecutionTarget);
  return runner;
}

function geminiReply(text: string) {
  return { candidates: [{ content: { role: 'model', parts: [{ text }] } }] };
}

describe('Gemini :batchGenerateContent and /v1beta/batches', () => {
  it('answers 501 UNIMPLEMENTED when no batch runner is wired', async () => {
    const reply = createReplyMock();
    await respondGeminiBatchGenerateContent(
      undefined,
      'models/gemini-3-flash',
      { requests: [{ request: {} }] },
      reply as never,
    );
    expect(statusOf(reply)).toBe(501);
    expect(sent(reply)).toMatchObject({ error: { status: 'UNIMPLEMENTED' } });
  });

  it('submits batchGenerateContent through the Batch service injected into GeminiController', async () => {
    const target = createTarget(async () => geminiReply('ok'));
    const runner = createRunner(target);
    const controller = new GeminiController(
      {} as never,
      undefined,
      undefined,
      new BatchService(runner),
    );
    const reply = createReplyMock();

    await controller.modelAction(
      'gemini-3-flash:batchGenerateContent',
      { requests: [{ request: { contents: [] }, metadata: { key: 'line-1' } }] } as never,
      reply as never,
    );

    expect(statusOf(reply)).toBe(200);
    expect(sent(reply)).toMatchObject({
      name: expect.stringMatching(/^batches\/[0-9a-f]{24}$/u),
      done: false,
    });
    await runner.drain();
  });

  it('submits an inlined-requests batch and runs it to completion', async () => {
    const target = createTarget(async () => geminiReply('ok'));
    const runner = createRunner(target);
    const operations = await createBatchHttpApp(new BatchService(runner));

    const submitReply = createReplyMock();
    await respondGeminiBatchGenerateContent(
      new BatchService(runner),
      'models/gemini-3-flash',
      {
        batch: {
          displayName: 'my-batch',
          inputConfig: {
            requests: { requests: [{ request: { contents: [] }, metadata: { key: 'line-1' } }] },
          },
        },
      },
      submitReply as never,
    );

    expect(statusOf(submitReply)).toBe(200);
    const operation = sent(submitReply);
    expect(operation.name).toMatch(/^batches\//u);
    expect(operation.done).toBe(false);
    expect(operation.metadata.model).toBe('models/gemini-3-flash');

    await runner.drain();

    const getReply = await operations.inject({
      method: 'GET',
      url: `/v1beta/batches/${encodeURIComponent(operation.name.replace(/^batches\//u, ''))}`,
      headers: batchTestHeaders,
    });
    const finished = sent(getReply);
    expect(finished.done).toBe(true);
    expect(finished.response.inlinedResponses.inlinedResponses).toEqual([
      { metadata: { key: 'line-1' }, response: geminiReply('ok') },
    ]);
  });

  it('isolates a failing request line inside the operation response', async () => {
    const target = createTarget(async (_model, request) => {
      const isBad = JSON.stringify(request).includes('bad');
      if (isBad) {
        throw Object.assign(new Error('upstream said no'), { status: 400 });
      }
      return geminiReply('ok');
    });
    const runner = createRunner(target);
    const operations = await createBatchHttpApp(new BatchService(runner));

    const submitReply = createReplyMock();
    await respondGeminiBatchGenerateContent(
      new BatchService(runner),
      'models/gemini-3-flash',
      {
        requests: [
          {
            request: { contents: [{ role: 'user', parts: [{ text: 'ok' }] }] },
            metadata: { key: 'good' },
          },
          {
            request: { contents: [{ role: 'user', parts: [{ text: 'bad' }] }] },
            metadata: { key: 'bad' },
          },
        ],
      },
      submitReply as never,
    );
    const operation = sent(submitReply);
    await runner.drain();

    const getReply = await operations.inject({
      method: 'GET',
      url: `/v1beta/batches/${encodeURIComponent(operation.name.replace(/^batches\//u, ''))}`,
      headers: batchTestHeaders,
    });
    const finished = sent(getReply);
    const lines = finished.response.inlinedResponses.inlinedResponses;
    expect(lines.find((line: any) => line.metadata.key === 'good').response).toBeDefined();
    expect(lines.find((line: any) => line.metadata.key === 'bad').error).toMatchObject({
      code: 400,
    });
  });

  it('rejects a batch with no inlined requests instead of accepting a file-input form', async () => {
    const target = createTarget(async () => geminiReply('unused'));
    const runner = createRunner(target);

    const reply = createReplyMock();
    await respondGeminiBatchGenerateContent(
      new BatchService(runner),
      'models/gemini-3-flash',
      {},
      reply as never,
    );
    expect(statusOf(reply)).toBe(400);
    expect(sent(reply)).toMatchObject({ error: { status: 'INVALID_ARGUMENT' } });
  });

  it('answers an unknown operation name with 404 in the Gemini error envelope, not an empty success', async () => {
    const target = createTarget(async () => geminiReply('unused'));
    const runner = createRunner(target);
    const operations = await createBatchHttpApp(new BatchService(runner));

    const reply = await operations.inject({
      method: 'GET',
      url: `/v1beta/batches/${encodeURIComponent(`batches/${'0'.repeat(24)}`.replace(/^batches\//u, ''))}`,
      headers: batchTestHeaders,
    });
    expect(statusOf(reply)).toBe(404);
    expect(sent(reply)).toMatchObject({ error: { status: 'NOT_FOUND' } });
  });

  it('expires a Gemini batch that outlives its completion window, reported through the operation', async () => {
    const target = createTarget(async () => geminiReply('unused'));
    const runner = createRunner(target, 1);
    const operations = await createBatchHttpApp(new BatchService(runner));

    const created = runner.create(
      {
        dialect: 'gemini',
        endpoint: 'models/gemini-3-flash:generateContent',
        requests: [{ customId: 'line-1', body: { contents: [] }, target: 'models/gemini-3-flash' }],
        completionWindowMs: 1,
      },
      Date.now() - 10_000,
    );

    const getReply = await operations.inject({
      method: 'GET',
      url: `/v1beta/batches/${encodeURIComponent(`batches/${created.id}`.replace(/^batches\//u, ''))}`,
      headers: batchTestHeaders,
    });
    const operation = sent(getReply);
    expect(operation.done).toBe(true);
    expect(operation.error).toMatchObject({ status: 'DEADLINE_EXCEEDED' });
  });

  it('pages newest first and preserves the first page for an aged-out well-formed token', async () => {
    const target = createTarget(async () => geminiReply('unused'));
    const runner = createRunner(target, 1);
    const operations = await createBatchHttpApp(new BatchService(runner));

    const now = Date.now();
    const makeJob = (id: string, createdAtMs: number) =>
      runner.create(
        {
          dialect: 'gemini',
          endpoint: 'models/gemini-3-flash:generateContent',
          requests: [{ customId: id, body: { contents: [] }, target: 'models/gemini-3-flash' }],
        },
        createdAtMs,
      );
    const oldest = makeJob('oldest', now - 2000);
    const middle = makeJob('middle', now - 1000);
    const newest = makeJob('newest', now);

    const page1Reply = await operations.inject({
      method: 'GET',
      url: '/v1beta/batches',
      headers: batchTestHeaders,
      query: { pageSize: '1' },
    });
    const page1 = sent(page1Reply);
    expect(page1.batches).toHaveLength(1);
    expect(page1.batches[0].name).toBe(`batches/${newest.id}`);
    expect(page1.nextPageToken).toBe(`batches/${newest.id}`);

    const page2Reply = await operations.inject({
      method: 'GET',
      url: '/v1beta/batches',
      headers: batchTestHeaders,
      query: { pageSize: '1', pageToken: page1.nextPageToken },
    });
    const page2 = sent(page2Reply);
    expect(page2.batches).toHaveLength(1);
    expect(page2.batches[0].name).toBe(`batches/${middle.id}`);
    expect(page2.nextPageToken).toBe(`batches/${middle.id}`);

    const page3Reply = await operations.inject({
      method: 'GET',
      url: '/v1beta/batches',
      headers: batchTestHeaders,
      query: { pageSize: '1', pageToken: page2.nextPageToken },
    });
    const page3 = sent(page3Reply);
    expect(page3.batches).toHaveLength(1);
    expect(page3.batches[0].name).toBe(`batches/${oldest.id}`);
    expect(page3.nextPageToken).toBeUndefined();

    const agedOutReply = await operations.inject({
      method: 'GET',
      url: '/v1beta/batches',
      headers: batchTestHeaders,
      query: { pageSize: '1', pageToken: `batches/${'f'.repeat(24)}` },
    });
    expect(sent(agedOutReply)).toEqual({
      batches: [page1.batches[0]],
      nextPageToken: page1.nextPageToken,
    });
  });

  it('rejects an unrecognized pageToken with the Gemini error envelope', async () => {
    const target = createTarget(async () => geminiReply('unused'));
    const runner = createRunner(target);
    const operations = await createBatchHttpApp(new BatchService(runner));

    const reply = await operations.inject({
      method: 'GET',
      url: '/v1beta/batches',
      headers: batchTestHeaders,
      query: { pageToken: 'not-a-real-token' },
    });
    expect(statusOf(reply)).toBe(400);
    expect(sent(reply)).toMatchObject({ error: { status: 'INVALID_ARGUMENT' } });
  });
});
