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

/**
 * `SERVABLE_BATCH_ENDPOINTS` documents exactly the endpoints this proxy's
 * batch runner can genuinely execute. It used to be `['/v1/chat/completions']`
 * only, from a time this branch had no Files API and so no way to build the
 * OpenAI batch surface end to end. Now that the Files API and all three
 * protocol surfaces exist, the list grew to include Anthropic's Messages
 * endpoint and the Gemini action every batch line is dispatched to.
 *
 * This is a narrowing the brief explicitly calls out for widening: each
 * *added* entry must carry its own dedicated test proving a batch actually
 * completes against it, not just that the constant contains the string.
 */
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
  return new BatchRunnerService({ maxConcurrency: 1 }, target as unknown as BatchExecutionTarget);
}

describe('SERVABLE_BATCH_ENDPOINTS', () => {
  it('lists exactly the endpoints this port wires up a servable execution path for', () => {
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
});
