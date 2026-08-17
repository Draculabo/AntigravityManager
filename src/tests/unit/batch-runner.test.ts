import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  countBatchRequests,
  type BatchJobRecord,
} from '@/modules/proxy-gateway/server/modules/batch/batch-job.types';
import { BatchRunnerService } from '@/modules/proxy-gateway/server/modules/batch/batch-runner.service';
import type { BatchExecutionTarget } from '@/modules/proxy-gateway/server/modules/batch/batch-request-executor';

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
}

function deferred(): Deferred {
  let resolve: (value: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const tempDirs: string[] = [];

function stateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agm-batches-'));
  tempDirs.push(dir);
  return join(dir, 'batches.json');
}

afterEach(() => {
  // Windows keeps a handle for a moment after the last write resolves.
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
  }
});

/** A batch-execution-target stand-in; only the Anthropic handler is exercised by default. */
function createTarget(handler: (request: unknown) => Promise<unknown>) {
  return {
    handleChatCompletions: vi.fn(),
    handleAnthropicMessages: vi.fn(handler),
    handleGeminiGenerateContent: vi.fn(),
  } satisfies Record<keyof BatchExecutionTarget, ReturnType<typeof vi.fn>>;
}

function createRunner(
  filePath: string | undefined,
  target: ReturnType<typeof createTarget>,
  maxConcurrency = 1,
): BatchRunnerService {
  return new BatchRunnerService(
    { ...(filePath ? { filePath } : {}), maxConcurrency },
    target as unknown as BatchExecutionTarget,
  );
}

function anthropicRequests(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    customId: `line-${index + 1}`,
    body: {
      model: 'conformance-model',
      max_tokens: 16,
      messages: [{ role: 'user', content: `question ${index + 1}` }],
    },
  }));
}

function reply(text: string) {
  return {
    id: 'msg_1',
    type: 'message',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

describe('batch runner', () => {
  it('reports request_counts honestly as the batch progresses', async () => {
    const gate = deferred();
    const target = createTarget(async (request) => {
      const first = JSON.stringify(request).includes('question 1');
      if (first) {
        await gate.promise;
      }
      return reply('ok');
    });
    const runner = createRunner(undefined, target, 2);

    const created = runner.create({
      dialect: 'anthropic',
      endpoint: '/v1/messages',
      requests: anthropicRequests(2),
    });
    expect(countBatchRequests(created)).toMatchObject({ total: 2, processing: 2, succeeded: 0 });

    await waitFor(() => runner.require(created.id).requests[0].state === 'running');
    expect(runner.require(created.id).status).toBe('in_progress');

    gate.resolve(undefined);
    await runner.drain();

    const finished = runner.require(created.id);
    expect(finished.status).toBe('completed');
    expect(countBatchRequests(finished)).toMatchObject({
      total: 2,
      processing: 0,
      succeeded: 2,
      errored: 0,
    });
  });

  it('records a failing request against its custom_id without aborting the batch', async () => {
    const target = createTarget(async (request) => {
      if (JSON.stringify(request).includes('question 2')) {
        throw Object.assign(new Error('upstream said no'), { status: 429, code: 'rate_limit' });
      }
      return reply('fine');
    });
    const runner = createRunner(undefined, target, 2);

    const created = runner.create({
      dialect: 'anthropic',
      endpoint: '/v1/messages',
      requests: anthropicRequests(3),
    });
    await runner.drain();

    const job = runner.require(created.id);
    expect(job.status).toBe('completed');
    expect(job.requests.map((request) => request.state)).toEqual([
      'succeeded',
      'errored',
      'succeeded',
    ]);
    const failed = job.requests[1];
    expect(failed.customId).toBe('line-2');
    expect(failed.error).toMatchObject({ httpStatus: 429, message: 'upstream said no' });
    expect(failed.response).toBeUndefined();
  });

  it('never runs more requests at once than the concurrency ceiling allows', async () => {
    const gates = [deferred(), deferred(), deferred()];
    let concurrent = 0;
    let maxObservedConcurrent = 0;
    const target = createTarget(async (request) => {
      concurrent += 1;
      maxObservedConcurrent = Math.max(maxObservedConcurrent, concurrent);
      const index = Number(/question (\d)/u.exec(JSON.stringify(request))?.[1]) - 1;
      await gates[index]?.promise;
      concurrent -= 1;
      return reply('ok');
    });
    const runner = createRunner(undefined, target, 2);

    const created = runner.create({
      dialect: 'anthropic',
      endpoint: '/v1/messages',
      requests: anthropicRequests(3),
    });

    await waitFor(() => runner.require(created.id).requests[1].state === 'running');
    // The third request must still be waiting: two in flight is the ceiling.
    expect(runner.require(created.id).requests[2].state).toBe('pending');
    expect(maxObservedConcurrent).toBe(2);

    gates[0]?.resolve(undefined);
    await waitFor(() => runner.require(created.id).requests[2].state === 'running');
    expect(maxObservedConcurrent).toBe(2);

    gates[1]?.resolve(undefined);
    gates[2]?.resolve(undefined);
    await runner.drain();

    expect(runner.require(created.id).status).toBe('completed');
  });

  it('cancels a batch that is already mid-flight', async () => {
    const gate = deferred();
    const target = createTarget(async () => {
      await gate.promise;
      return reply('too late');
    });
    const runner = createRunner(undefined, target, 1);

    const created = runner.create({
      dialect: 'anthropic',
      endpoint: '/v1/messages',
      requests: anthropicRequests(3),
    });
    await waitFor(() => runner.require(created.id).requests[0].state === 'running');

    const cancelling = runner.cancel(created.id);
    expect(cancelling.status).toBe('cancelling');
    // Everything not yet dispatched is cancelled at once; the in-flight one waits.
    expect(cancelling.requests.map((request) => request.state)).toEqual([
      'running',
      'canceled',
      'canceled',
    ]);

    gate.resolve(undefined);
    await runner.drain();

    const job = runner.require(created.id);
    expect(job.status).toBe('cancelled');
    expect(job.requests.every((request) => request.state === 'canceled')).toBe(true);
    // The answer arrived after cancellation, so it is not reported.
    expect(job.requests[0].response).toBeUndefined();
    expect(target.handleAnthropicMessages).toHaveBeenCalledTimes(1);
  });

  it('resumes a batch that died mid-flight when a fresh runner opens the same file', async () => {
    const filePath = stateFile();
    const neverSettles = deferred();
    const firstTarget = createTarget(async (request) => {
      if (JSON.stringify(request).includes('question 2')) {
        // Stands in for the process dying with this request in flight.
        await neverSettles.promise;
      }
      return reply('from the first process');
    });
    const first = createRunner(filePath, firstTarget, 1);
    const created = first.create({
      dialect: 'anthropic',
      endpoint: '/v1/messages',
      requests: anthropicRequests(3),
    });

    await waitFor(() => first.require(created.id).requests[1].state === 'running');
    await first.flushState();
    const beforeRestart = first.require(created.id);
    expect(beforeRestart.requests.map((request) => request.state)).toEqual([
      'succeeded',
      'running',
      'pending',
    ]);

    // A genuinely new runner over the same directory: nothing in memory carries over.
    const secondTarget = createTarget(async () => reply('from the second process'));
    const second = createRunner(filePath, secondTarget, 1);
    const resumed = second.require(created.id);
    expect(resumed.requests[0].state).toBe('succeeded');
    expect(resumed.requests[0].response).toMatchObject({
      content: [{ text: 'from the first process' }],
    });

    await second.drain();
    const finished = second.require(created.id);
    expect(finished.status).toBe('completed');
    expect(countBatchRequests(finished)).toMatchObject({ total: 3, succeeded: 3, processing: 0 });
    // The interrupted request was retried from the top by the new process.
    expect(secondTarget.handleAnthropicMessages).toHaveBeenCalledTimes(2);
    expect(finished.requests[1].response).toMatchObject({
      content: [{ text: 'from the second process' }],
    });

    neverSettles.resolve(undefined);
  });

  it('expires a batch that outlives its completion window', async () => {
    const gate = deferred();
    const target = createTarget(async () => {
      await gate.promise;
      return reply('ok');
    });
    const runner = createRunner(undefined, target, 1);
    const created = runner.create(
      {
        dialect: 'anthropic',
        endpoint: '/v1/messages',
        requests: anthropicRequests(2),
        completionWindowMs: 1,
      },
      Date.now() - 10_000,
    );

    const expired: BatchJobRecord = runner.require(created.id);
    expect(expired.status).toBe('expired');
    expect(expired.requests.every((request) => request.state === 'expired')).toBe(true);

    gate.resolve(undefined);
    await runner.drain();
  });

  it('refuses duplicate custom_ids at creation', () => {
    const runner = createRunner(
      undefined,
      createTarget(async () => reply('ok')),
    );
    expect(() =>
      runner.create({
        dialect: 'anthropic',
        endpoint: '/v1/messages',
        requests: [
          { customId: 'same', body: {} },
          { customId: 'same', body: {} },
        ],
      }),
    ).toThrow(/appears more than once/u);
  });

  it('refuses an OpenAI-dialect batch aimed at an endpoint this runner cannot serve', async () => {
    const target = createTarget(async () => reply('unused'));
    const runner = createRunner(undefined, target, 1);

    const created = runner.create({
      dialect: 'openai',
      endpoint: '/v1/responses',
      requests: [{ customId: 'line-1', body: { model: 'gpt-4o', messages: [] } }],
    });
    await runner.drain();

    const job = runner.require(created.id);
    expect(job.status).toBe('completed');
    expect(job.requests[0].state).toBe('errored');
    expect(job.requests[0].error).toMatchObject({ code: 'unservable_endpoint', httpStatus: 400 });
    expect(target.handleChatCompletions).not.toHaveBeenCalled();
  });
});
