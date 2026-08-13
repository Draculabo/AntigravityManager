import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BatchRunnerService } from '@/modules/proxy-gateway/server/modules/batch/batch-runner.service';
import type { BatchExecutionTarget } from '@/modules/proxy-gateway/server/modules/batch/batch-request-executor';
import { OpenAIBatchesController } from '@/modules/proxy-gateway/server/modules/batch/openai-batches.controller';
import { FileContentStore } from '@/modules/proxy-gateway/server/modules/files/file-content-store.service';
import { OPENAI_FILE_ID_PREFIX } from '@/modules/proxy-gateway/server/modules/files/openai-file-resource';

function createReplyMock() {
  const reply: Record<string, unknown> = {};
  reply.status = vi.fn(() => reply);
  reply.header = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply;
}

function sent(reply: Record<string, unknown>): any {
  return (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
}

function statusOf(reply: Record<string, unknown>): unknown {
  return (reply.status as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
}

function createTarget(handler: (request: unknown) => Promise<unknown>) {
  return {
    handleChatCompletions: vi.fn(handler),
    handleAnthropicMessages: vi.fn(),
    handleGeminiGenerateContent: vi.fn(),
  } satisfies Record<keyof BatchExecutionTarget, ReturnType<typeof vi.fn>>;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
  }
});

function createFileStore(): FileContentStore {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'agm-batch-files-'));
  roots.push(rootDirectory);
  return new FileContentStore({ rootDirectory, sweepIntervalMs: 0 });
}

function createController(
  target: ReturnType<typeof createTarget>,
  files?: FileContentStore,
  maxConcurrency = 2,
) {
  const runner = new BatchRunnerService(
    { maxConcurrency },
    target as unknown as BatchExecutionTarget,
  );
  const controller = new OpenAIBatchesController(runner, files);
  return { controller, runner };
}

async function uploadJsonl(files: FileContentStore, lines: unknown[]): Promise<string> {
  const content = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  const record = await files.put({
    bytes: Buffer.from(content, 'utf-8'),
    declaredMimeType: 'application/jsonl',
    displayName: 'batch-input.jsonl',
    purpose: 'batch',
  });
  return `${OPENAI_FILE_ID_PREFIX}${record.id}`;
}

describe('OpenAIBatchesController', () => {
  it('reads its input through the Files API rather than a stubbed body', async () => {
    const files = createFileStore();
    const target = createTarget(async (request) => ({
      id: 'chatcmpl-1',
      choices: [
        {
          message: {
            content: `echo:${(request as { messages: Array<{ content: string }> }).messages[0].content}`,
          },
        },
      ],
    }));
    const { controller, runner } = createController(target, files);

    const inputFileId = await uploadJsonl(files, [
      {
        custom_id: 'line-1',
        method: 'POST',
        url: '/v1/chat/completions',
        body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'from-the-file' }] },
      },
    ]);

    const reply = createReplyMock();
    await controller.create(
      {
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
        input_file_id: inputFileId,
      },
      reply as never,
    );

    expect(statusOf(reply)).toBe(200);
    const batch = sent(reply);
    // `create()` pumps synchronously, so the first request may already have
    // been claimed by the time the response is built.
    expect(['validating', 'in_progress']).toContain(batch.status);
    expect(batch.input_file_id).toBe(inputFileId);

    await runner.drain();
    expect(target.handleChatCompletions).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'from-the-file' }],
      }),
    );

    const finished = runner.require(batch.id.replace(/^batch_/u, ''));
    expect(finished.requests[0].response).toMatchObject({
      choices: [{ message: { content: 'echo:from-the-file' } }],
    });
  });

  it('rejects a request whose input_file_id was never issued by this proxy', async () => {
    const files = createFileStore();
    const target = createTarget(async () => ({ id: 'unused' }));
    const { controller } = createController(target, files);

    const reply = createReplyMock();
    await controller.create(
      {
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
        input_file_id: `file-${'0'.repeat(30)}ff`,
      },
      reply as never,
    );

    expect(statusOf(reply)).toBe(404);
    expect(sent(reply)).toMatchObject({ error: { type: 'invalid_request_error' } });
  });

  it('isolates one bad custom_id from the rest of the batch', async () => {
    const files = createFileStore();
    const target = createTarget(async (request) => {
      const message = (request as { messages: Array<{ content: string }> }).messages[0].content;
      if (message === 'bad') {
        throw Object.assign(new Error('upstream rejected this line'), { status: 400 });
      }
      return { id: 'chatcmpl-ok', choices: [{ message: { content: 'fine' } }] };
    });
    const { controller, runner } = createController(target, files, 2);

    const inputFileId = await uploadJsonl(files, [
      {
        custom_id: 'good-1',
        url: '/v1/chat/completions',
        body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'ok' }] },
      },
      {
        custom_id: 'bad-1',
        url: '/v1/chat/completions',
        body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'bad' }] },
      },
      {
        custom_id: 'good-2',
        url: '/v1/chat/completions',
        body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'ok' }] },
      },
    ]);

    const createReply = createReplyMock();
    await controller.create(
      { endpoint: '/v1/chat/completions', completion_window: '24h', input_file_id: inputFileId },
      createReply as never,
    );
    const created = sent(createReply);
    await runner.drain();

    const job = runner.require(created.id.replace(/^batch_/u, ''));
    expect(job.status).toBe('completed');
    expect(job.requests.map((request) => request.state)).toEqual([
      'succeeded',
      'errored',
      'succeeded',
    ]);

    const getReply = createReplyMock();
    controller.get(created.id, getReply as never);
    const batch = sent(getReply);
    expect(batch.request_counts).toEqual({ total: 3, completed: 2, failed: 1 });
    expect(batch.output_file_id).toEqual(expect.stringMatching(/^file-/u));
    expect(batch.error_file_id).toEqual(expect.stringMatching(/^file-/u));

    const output = await files!.get(batch.output_file_id.replace(/^file-/u, ''));
    expect(output.bytes.toString('utf-8')).toContain('"custom_id":"good-1"');
    expect(output.bytes.toString('utf-8')).toContain('"custom_id":"good-2"');
    const errors = await files!.get(batch.error_file_id.replace(/^file-/u, ''));
    expect(errors.bytes.toString('utf-8')).toContain('"custom_id":"bad-1"');
  });

  it('cancels a mid-flight batch, discarding the answer of the request already dispatched', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const files = createFileStore();
    const target = createTarget(async () => {
      await gate;
      return { id: 'chatcmpl-late', choices: [{ message: { content: 'too late' } }] };
    });
    const { controller, runner } = createController(target, files, 1);

    const inputFileId = await uploadJsonl(files, [
      { custom_id: 'a', url: '/v1/chat/completions', body: { model: 'gpt-4o', messages: [] } },
      { custom_id: 'b', url: '/v1/chat/completions', body: { model: 'gpt-4o', messages: [] } },
    ]);

    const createReply = createReplyMock();
    await controller.create(
      { endpoint: '/v1/chat/completions', completion_window: '24h', input_file_id: inputFileId },
      createReply as never,
    );
    const created = sent(createReply);

    for (
      let attempt = 0;
      attempt < 200 && target.handleChatCompletions.mock.calls.length < 1;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const cancelReply = createReplyMock();
    controller.cancel(created.id, cancelReply as never);
    expect(sent(cancelReply).status).toBe('cancelling');

    release?.();
    await runner.drain();

    const getReply = createReplyMock();
    controller.get(created.id, getReply as never);
    const batch = sent(getReply);
    expect(batch.status).toBe('cancelled');
    expect(batch.request_counts.total).toBe(2);
  });

  it('answers an unknown batch id with a 404 in the OpenAI error envelope, not an empty success', async () => {
    const files = createFileStore();
    const target = createTarget(async () => ({ id: 'unused' }));
    const { controller } = createController(target, files);

    const reply = createReplyMock();
    controller.get('batch_000000000000000000000000', reply as never);

    expect(statusOf(reply)).toBe(404);
    expect(sent(reply)).toMatchObject({
      error: { message: expect.any(String), type: 'invalid_request_error' },
    });
  });

  it('expires a batch that outlives its completion window before anything ran', () => {
    const files = createFileStore();
    const target = createTarget(async () => ({ id: 'unused' }));
    const runner = new BatchRunnerService(
      { maxConcurrency: 1 },
      target as unknown as BatchExecutionTarget,
    );
    const controller = new OpenAIBatchesController(runner, files);

    const created = runner.create(
      {
        dialect: 'openai',
        endpoint: '/v1/chat/completions',
        requests: [{ customId: 'line-1', body: { model: 'gpt-4o', messages: [] } }],
        completionWindowMs: 1,
      },
      Date.now() - 10_000,
    );

    const reply = createReplyMock();
    controller.get(`batch_${created.id}`, reply as never);
    const batch = sent(reply);
    expect(batch.status).toBe('expired');
    expect(batch.request_counts).toEqual({ total: 1, completed: 0, failed: 1 });
  });
});
