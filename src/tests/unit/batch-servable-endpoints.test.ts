import { describe, expect, it, vi } from 'vitest';

import {
  ANTHROPIC_SERVABLE_BATCH_ENDPOINT,
  GEMINI_SERVABLE_BATCH_ACTION,
  OPENAI_SERVABLE_BATCH_ENDPOINT,
  SERVABLE_BATCH_ENDPOINTS,
} from '@/modules/proxy-gateway/server/modules/batch/batch-job.types';
import { BatchRunnerService } from '@/modules/proxy-gateway/server/modules/batch/batch-runner.service';
import type { BatchExecutionTarget } from '@/modules/proxy-gateway/server/modules/batch/batch-request-executor';
import { buildGeminiBatchEndpoint } from '@/modules/proxy-gateway/server/modules/batch/gemini-batch-resource';

/** Every advertised endpoint needs a dispatch test proving the Batch runner can execute it. */
function createTarget(handler: (dialect: string, request: unknown) => Promise<unknown>) {
  return {
    handleChatCompletions: vi.fn((request: unknown) => handler('openai', request)),
    handleAnthropicMessages: vi.fn((request: unknown) => handler('anthropic', request)),
    handleGeminiGenerateContent: vi.fn((model: string, request: unknown) =>
      handler('gemini', { model, request }),
    ),
  } satisfies Record<keyof BatchExecutionTarget, ReturnType<typeof vi.fn>>;
}

function createRunner(target: ReturnType<typeof createTarget>): BatchRunnerService {
  const runner = new BatchRunnerService({ maxConcurrency: 1 });
  runner.setExecutionTarget(target as unknown as BatchExecutionTarget);
  return runner;
}

describe('SERVABLE_BATCH_ENDPOINTS', () => {
  it('lists exactly the endpoints with a servable execution path', () => {
    expect(SERVABLE_BATCH_ENDPOINTS).toEqual([
      '/v1/chat/completions',
      '/v1/messages',
      'generateContent',
    ]);
    expect(OPENAI_SERVABLE_BATCH_ENDPOINT).toBe('/v1/chat/completions');
    expect(ANTHROPIC_SERVABLE_BATCH_ENDPOINT).toBe('/v1/messages');
    expect(GEMINI_SERVABLE_BATCH_ACTION).toBe('generateContent');
  });

  it('serves an OpenAI batch aimed at /v1/chat/completions end to end', async () => {
    const target = createTarget(async () => ({
      id: 'chatcmpl-1',
      choices: [{ message: { content: 'ok' } }],
    }));
    const runner = createRunner(target);

    const created = runner.create({
      dialect: 'openai',
      endpoint: OPENAI_SERVABLE_BATCH_ENDPOINT,
      requests: [{ customId: 'line-1', body: { model: 'gpt-4o', messages: [] } }],
    });
    await runner.drain();

    const job = runner.require(created.id);
    expect(job.status).toBe('completed');
    expect(job.requests[0].state).toBe('succeeded');
    expect(target.handleChatCompletions).toHaveBeenCalledTimes(1);
  });

  it('serves an Anthropic batch aimed at /v1/messages end to end', async () => {
    const target = createTarget(async () => ({
      id: 'msg_1',
      type: 'message',
      content: [{ type: 'text', text: 'ok' }],
    }));
    const runner = createRunner(target);

    const created = runner.create({
      dialect: 'anthropic',
      endpoint: ANTHROPIC_SERVABLE_BATCH_ENDPOINT,
      requests: [
        {
          customId: 'line-1',
          body: { model: 'claude-3', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
        },
      ],
    });
    await runner.drain();

    const job = runner.require(created.id);
    expect(job.status).toBe('completed');
    expect(job.requests[0].state).toBe('succeeded');
    expect(target.handleAnthropicMessages).toHaveBeenCalledTimes(1);
  });

  it('serves a Gemini batch dispatched as plain generateContent end to end', async () => {
    const target = createTarget(async () => ({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
    }));
    const runner = createRunner(target);

    const model = 'models/gemini-3-flash';
    const created = runner.create({
      dialect: 'gemini',
      endpoint: buildGeminiBatchEndpoint(model),
      requests: [
        {
          customId: 'line-1',
          body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
          target: model,
        },
      ],
    });
    expect(created.endpoint).toBe(`${model}:generateContent`);
    await runner.drain();

    const job = runner.require(created.id);
    expect(job.status).toBe('completed');
    expect(job.requests[0].state).toBe('succeeded');
    expect(target.handleGeminiGenerateContent).toHaveBeenCalledWith(
      model,
      expect.objectContaining({ contents: expect.any(Array) }),
    );
  });

  it('refuses an OpenAI batch aimed at /v1/responses, naming what it can serve', async () => {
    const { requireServableEndpoint } =
      await import('@/modules/proxy-gateway/server/modules/batch/openai-batch-resource');

    expect(() => requireServableEndpoint('/v1/responses')).toThrow(
      expect.objectContaining({
        code: 'unservable_endpoint',
        httpStatus: 400,
        param: 'endpoint',
        message: expect.stringContaining('/v1/chat/completions'),
      }),
    );
  });

  it('refuses to dispatch a job that already carries /v1/responses', async () => {
    const { executeBatchRequest } =
      await import('@/modules/proxy-gateway/server/modules/batch/batch-request-executor');
    const target = createTarget(async () => ({ id: 'chatcmpl-1', choices: [] }));

    const result = await executeBatchRequest(
      { dialect: 'openai', endpoint: '/v1/responses' } as never,
      { customId: 'line-1', body: { model: 'gpt-4o', messages: [] } } as never,
      target as unknown as BatchExecutionTarget,
    );

    expect(result.outcome).toBe('errored');
    expect(result.outcome === 'errored' && result.error.code).toBe('unservable_endpoint');
    expect(target.handleChatCompletions).not.toHaveBeenCalled();
  });
});
