import { createBatchHttpApp, batchTestHeaders } from '../helpers/batch-http-app';
import type { LightMyRequestResponse } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAnthropicCompleteHttpApp,
  completionTestHeaders,
} from '../helpers/anthropic-complete-http-app';
import {
  normalizeAnthropicCompleteRequest,
  toAnthropicCompletionResponse,
  toAnthropicMessagesRequest,
} from '@/modules/proxy-gateway/server/modules/anthropic/anthropic-text-completion';
import {
  toAnthropicMessageBatch,
  type AnthropicProcessingStatus,
} from '@/modules/proxy-gateway/server/modules/batch/anthropic-batch-resource';
import type { BatchExecutionTarget } from '@/modules/proxy-gateway/server/modules/batch/batch-request-executor';
import { BatchRunnerService } from '@/modules/proxy-gateway/server/modules/batch/batch-runner.service';
import { BatchService } from '@/modules/proxy-gateway/server/modules/batch/batch.service';
import {
  type BatchJobRecord,
  type BatchStatus,
} from '@/modules/proxy-gateway/server/modules/batch/batch-job.types';
import { respondGeminiBatchGenerateContent } from '@/modules/proxy-gateway/server/modules/batch/gemini-batch-submit';
import { toGeminiOperation } from '@/modules/proxy-gateway/server/modules/batch/gemini-batch-resource';
import { toOpenAIBatchObject } from '@/modules/proxy-gateway/server/modules/batch/openai-batch-resource';
import { FileContentStore } from '@/modules/proxy-gateway/server/modules/files/file-content-store.service';
import { FilesService } from '@/modules/proxy-gateway/server/modules/files/files.service';
import { OPENAI_FILE_ID_PREFIX } from '@/modules/proxy-gateway/server/modules/files/openai-file-resource';

/**
 * Conformance across the three batch protocol surfaces (OpenAI, Anthropic,
 * Gemini) and the legacy `/v1/complete` adapter -- properties none of the
 * per-controller unit tests can see because each of those only knows its own
 * dialect.
 */

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

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
  }
});

function createFileStore(): FileContentStore {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'agm-batch-conformance-'));
  roots.push(rootDirectory);
  return new FileContentStore({ rootDirectory, sweepIntervalMs: 0 });
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

// ---------------------------------------------------------------------------
// 1. One job, three dialects
// ---------------------------------------------------------------------------

function createSharedTarget() {
  return {
    handleChatCompletions: vi.fn(async () => ({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    })),
    handleAnthropicMessages: vi.fn(async () => ({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
    })),
    handleGeminiGenerateContent: vi.fn(async () => ({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
    })),
  } satisfies Record<keyof BatchExecutionTarget, ReturnType<typeof vi.fn>>;
}

function createRunner(target: BatchExecutionTarget, maxConcurrency: number): BatchRunnerService {
  const runner = new BatchRunnerService({ maxConcurrency });
  runner.setExecutionTarget(target);
  return runner;
}

describe('one job, three dialects', () => {
  it('reaches the same runner and answers each dialect in its own vendor envelope', async () => {
    const files = createFileStore();
    const target = createSharedTarget();
    const runner = createRunner(target as unknown as BatchExecutionTarget, 3);
    const batches = new BatchService(runner, new FilesService(files));
    const openai = await createBatchHttpApp(batches);
    const anthropic = await createBatchHttpApp(batches);
    const operations = await createBatchHttpApp(batches);

    const inputFileId = await uploadJsonl(files, [
      {
        custom_id: 'line-1',
        url: '/v1/chat/completions',
        body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      },
    ]);

    const openaiCreate = await openai.inject({
      method: 'POST',
      url: '/v1/batches',
      headers: batchTestHeaders,
      payload: {
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
        input_file_id: inputFileId,
      },
    });
    const openaiCreated = sent(openaiCreate);

    const anthropicCreate = await anthropic.inject({
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
    const anthropicCreated = sent(anthropicCreate);

    const geminiCreate = createReplyMock();
    await respondGeminiBatchGenerateContent(
      batches,
      'models/gemini-3-flash',
      {
        requests: [
          {
            request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
            metadata: { key: 'line-1' },
          },
        ],
      },
      geminiCreate as never,
    );
    const geminiCreated = sent(geminiCreate);

    await runner.drain();

    // The same runner instance ran all three jobs -- one dispatch per dialect,
    // through that dialect's own handler and no other.
    expect(target.handleChatCompletions).toHaveBeenCalledTimes(1);
    expect(target.handleAnthropicMessages).toHaveBeenCalledTimes(1);
    expect(target.handleGeminiGenerateContent).toHaveBeenCalledTimes(1);
    expect(
      runner
        .list()
        .map((job) => job.dialect)
        .sort(),
    ).toEqual(['anthropic', 'gemini', 'openai']);

    // Ids are prefixed the way each vendor prefixes them.
    expect(openaiCreated.id).toMatch(/^batch_[0-9a-f]{24}$/u);
    expect(anthropicCreated.id).toMatch(/^msgbatch_[0-9a-f]{24}$/u);
    expect(geminiCreated.name).toMatch(/^batches\/[0-9a-f]{24}$/u);

    const openaiGet = await openai.inject({
      method: 'GET',
      url: `/v1/batches/${encodeURIComponent(openaiCreated.id)}`,
      headers: batchTestHeaders,
    });
    const openaiBatch = sent(openaiGet);

    const anthropicGet = await anthropic.inject({
      method: 'GET',
      url: `/v1/messages/batches/${encodeURIComponent(anthropicCreated.id)}`,
      headers: batchTestHeaders,
    });
    const anthropicBatch = sent(anthropicGet);

    const geminiGet = await operations.inject({
      method: 'GET',
      url: `/v1beta/batches/${encodeURIComponent(geminiCreated.name.replace(/^batches\//u, ''))}`,
      headers: batchTestHeaders,
    });
    const geminiOperation = sent(geminiGet);

    // Status vocabulary: each dialect's own set, not another's.
    expect(openaiBatch.status).toBe('completed');
    expect(anthropicBatch.processing_status).toBe('ended');
    expect(geminiOperation.metadata.state).toBe('BATCH_STATE_SUCCEEDED');

    // No field from one dialect's envelope leaks into another's.
    expect(openaiBatch).not.toHaveProperty('processing_status');
    expect(openaiBatch).not.toHaveProperty('name');
    expect(openaiBatch).not.toHaveProperty('done');
    expect(anthropicBatch).not.toHaveProperty('object');
    expect(anthropicBatch).not.toHaveProperty('input_file_id');
    expect(anthropicBatch).not.toHaveProperty('name');
    expect(anthropicBatch).not.toHaveProperty('done');
    expect(geminiOperation).not.toHaveProperty('object');
    expect(geminiOperation).not.toHaveProperty('processing_status');
    expect(geminiOperation).not.toHaveProperty('id');

    // request_counts is shaped per vendor, not shared verbatim.
    expect(Object.keys(openaiBatch.request_counts).sort()).toEqual([
      'completed',
      'failed',
      'total',
    ]);
    expect(Object.keys(anthropicBatch.request_counts).sort()).toEqual([
      'canceled',
      'errored',
      'expired',
      'processing',
      'succeeded',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Status vocabulary is total
// ---------------------------------------------------------------------------

function baseJob(overrides: Partial<BatchJobRecord>): BatchJobRecord {
  const now = Date.now();
  return {
    id: '0'.repeat(24),
    dialect: 'openai',
    endpoint: '/v1/chat/completions',
    status: 'validating',
    requests: [],
    createdAtMs: now,
    expiresAtMs: now + 60_000,
    ...overrides,
  };
}

/** Runtime status list, kept exhaustive against the erased `BatchStatus` union below. */
const ALL_BATCH_STATUSES = [
  'validating',
  'in_progress',
  'finalizing',
  'completed',
  'failed',
  'cancelling',
  'cancelled',
  'expired',
] as const satisfies readonly BatchStatus[];

type _MissingStatus = Exclude<BatchStatus, (typeof ALL_BATCH_STATUSES)[number]>;
const _ExhaustiveBatchStatusCheck: _MissingStatus extends never
  ? true
  : ['ALL_BATCH_STATUSES is missing a BatchStatus member', _MissingStatus] = true;
void _ExhaustiveBatchStatusCheck;

const ANTHROPIC_STATUS_VALUES: readonly AnthropicProcessingStatus[] = [
  'in_progress',
  'canceling',
  'ended',
];
const GEMINI_STATE_VALUES = [
  'BATCH_STATE_PENDING',
  'BATCH_STATE_RUNNING',
  'BATCH_STATE_SUCCEEDED',
  'BATCH_STATE_FAILED',
  'BATCH_STATE_CANCELLED',
  'BATCH_STATE_EXPIRED',
] as const;

const EXPECTED_ANTHROPIC_STATUS: Record<BatchStatus, AnthropicProcessingStatus> = {
  validating: 'in_progress',
  in_progress: 'in_progress',
  finalizing: 'in_progress',
  completed: 'ended',
  failed: 'ended',
  cancelling: 'canceling',
  cancelled: 'ended',
  expired: 'ended',
};

const EXPECTED_GEMINI_STATE: Record<BatchStatus, (typeof GEMINI_STATE_VALUES)[number]> = {
  validating: 'BATCH_STATE_PENDING',
  in_progress: 'BATCH_STATE_RUNNING',
  finalizing: 'BATCH_STATE_RUNNING',
  completed: 'BATCH_STATE_SUCCEEDED',
  failed: 'BATCH_STATE_FAILED',
  cancelling: 'BATCH_STATE_CANCELLED',
  cancelled: 'BATCH_STATE_CANCELLED',
  expired: 'BATCH_STATE_EXPIRED',
};

describe('status vocabulary is total, driven from BatchStatus', () => {
  it.each(ALL_BATCH_STATUSES)(
    "maps internal status %s to OpenAI's own vocabulary verbatim",
    (status) => {
      const object = toOpenAIBatchObject(baseJob({ status }));
      expect(object.status).toBe(status);
      expect(ALL_BATCH_STATUSES).toContain(object.status);
    },
  );

  it.each(ALL_BATCH_STATUSES)(
    "maps internal status %s onto Anthropic's three-value vocabulary",
    (status) => {
      const batch = toAnthropicMessageBatch(baseJob({ status }));
      expect(batch.processing_status).toBeDefined();
      expect(ANTHROPIC_STATUS_VALUES).toContain(batch.processing_status);
      expect(batch.processing_status).toBe(EXPECTED_ANTHROPIC_STATUS[status]);
    },
  );

  it.each(ALL_BATCH_STATUSES)(
    "maps internal status %s onto Gemini's BatchState vocabulary, never UNSPECIFIED",
    (status) => {
      const operation = toGeminiOperation(baseJob({ status }));
      expect(operation.metadata.state).toBeDefined();
      expect(GEMINI_STATE_VALUES).toContain(
        operation.metadata.state as (typeof GEMINI_STATE_VALUES)[number],
      );
      expect(operation.metadata.state).toBe(EXPECTED_GEMINI_STATE[status]);
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Errors stay in the caller's dialect
// ---------------------------------------------------------------------------

function createFailingTarget(handler: keyof BatchExecutionTarget) {
  const fail = vi.fn(async () => {
    throw Object.assign(new Error('upstream rejected this line'), {
      status: 400,
      code: 'invalid_request_error',
    });
  });
  const target = {
    handleChatCompletions: vi.fn(),
    handleAnthropicMessages: vi.fn(),
    handleGeminiGenerateContent: vi.fn(),
  } satisfies Record<keyof BatchExecutionTarget, ReturnType<typeof vi.fn>>;
  (target[handler] as ReturnType<typeof vi.fn>) = fail;
  return target;
}

describe("errors stay in the caller's dialect", () => {
  it("a failed request line renders only in the calling dialect's own result shape", async () => {
    const files = createFileStore();

    // OpenAI
    const openaiTarget = createFailingTarget('handleChatCompletions');
    const openaiRunner = createRunner(openaiTarget as unknown as BatchExecutionTarget, 1);
    const openaiController = await createBatchHttpApp(
      new BatchService(openaiRunner, new FilesService(files)),
    );
    const inputFileId = await uploadJsonl(files, [
      { custom_id: 'bad', url: '/v1/chat/completions', body: { model: 'gpt-4o', messages: [] } },
    ]);

    const openaiCreateReply = await openaiController.inject({
      method: 'POST',
      url: '/v1/batches',
      headers: batchTestHeaders,
      payload: {
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
        input_file_id: inputFileId,
      },
    });
    await openaiRunner.drain();

    const openaiGetReply = await openaiController.inject({
      method: 'GET',
      url: `/v1/batches/${encodeURIComponent(sent(openaiCreateReply).id)}`,
      headers: batchTestHeaders,
    });
    const openaiErrorFileId = sent(openaiGetReply).error_file_id.replace(/^file-/u, '');
    const openaiErrorLine = JSON.parse(
      (await files.get(openaiErrorFileId)).bytes.toString('utf-8').trim(),
    );
    expect(openaiErrorLine).toEqual({
      id: expect.any(String),
      custom_id: 'bad',
      response: null,
      error: { code: 'invalid_request_error', message: 'upstream rejected this line' },
    });

    // Anthropic
    const anthropicTarget = createFailingTarget('handleAnthropicMessages');
    const anthropicRunner = createRunner(anthropicTarget as unknown as BatchExecutionTarget, 1);
    const anthropicController = await createBatchHttpApp(new BatchService(anthropicRunner));

    const anthropicCreateReply = await anthropicController.inject({
      method: 'POST',
      url: '/v1/messages/batches',
      headers: batchTestHeaders,
      payload: {
        requests: [
          { custom_id: 'bad', params: { model: 'claude-3', max_tokens: 8, messages: [] } },
        ],
      },
    });
    await anthropicRunner.drain();

    const anthropicResultsReply = await anthropicController.inject({
      method: 'GET',
      url: `/v1/messages/batches/${encodeURIComponent(sent(anthropicCreateReply).id)}/results`,
      headers: batchTestHeaders,
    });
    const anthropicLine = JSON.parse((sent(anthropicResultsReply) as string).trim());
    expect(anthropicLine).toEqual({
      custom_id: 'bad',
      result: {
        type: 'errored',
        error: {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'upstream rejected this line' },
        },
      },
    });

    // Gemini
    const geminiTarget = createFailingTarget('handleGeminiGenerateContent');
    const geminiRunner = createRunner(geminiTarget as unknown as BatchExecutionTarget, 1);
    const geminiOperations = await createBatchHttpApp(new BatchService(geminiRunner));
    const geminiCreateReply = createReplyMock();
    await respondGeminiBatchGenerateContent(
      new BatchService(geminiRunner),
      'models/gemini-3-flash',
      { requests: [{ request: { contents: [] }, metadata: { key: 'bad' } }] },
      geminiCreateReply as never,
    );
    await geminiRunner.drain();

    const geminiGetReply = await geminiOperations.inject({
      method: 'GET',
      url: `/v1beta/batches/${encodeURIComponent(sent(geminiCreateReply).name.replace(/^batches\//u, ''))}`,
      headers: batchTestHeaders,
    });
    const geminiLine = sent(geminiGetReply).response.inlinedResponses.inlinedResponses[0];
    expect(geminiLine).toEqual({
      metadata: { key: 'bad' },
      error: { code: 400, message: 'upstream rejected this line', status: 'UNKNOWN' },
    });

    // No dialect's error line carries another dialect's own-named fields.
    expect(openaiErrorLine.error).not.toHaveProperty('type');
    expect(openaiErrorLine).not.toHaveProperty('result');
    expect(anthropicLine.result.error).not.toHaveProperty('code');
    expect(anthropicLine).not.toHaveProperty('response');
    expect(geminiLine.error).not.toHaveProperty('type');
    expect(geminiLine).not.toHaveProperty('custom_id');
  });

  it('a rejected submission answers in the envelope of the surface that was called', async () => {
    const files = createFileStore();
    const target = createSharedTarget();
    const runner = createRunner(target as unknown as BatchExecutionTarget, 1);
    const batches = new BatchService(runner, new FilesService(files));
    const openaiController = await createBatchHttpApp(batches);
    const anthropicController = await createBatchHttpApp(batches);

    const openaiReply = await openaiController.inject({
      method: 'POST',
      url: '/v1/batches',
      headers: batchTestHeaders,
      payload: { endpoint: '/v1/chat/completions', completion_window: '24h' },
    });
    expect(statusOf(openaiReply)).toBe(400);
    const openaiBody = sent(openaiReply);
    expect(openaiBody).toEqual({
      error: {
        code: 'invalid_request',
        message: expect.any(String),
        param: 'input_file_id',
        type: 'invalid_request_error',
      },
    });

    const anthropicReply = await anthropicController.inject({
      method: 'POST',
      url: '/v1/messages/batches',
      headers: batchTestHeaders,
      payload: { requests: [] },
    });
    expect(statusOf(anthropicReply)).toBe(400);
    const anthropicBody = sent(anthropicReply);
    expect(anthropicBody).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: expect.any(String) },
    });

    const geminiReply = createReplyMock();
    await respondGeminiBatchGenerateContent(
      batches,
      'models/gemini-3-flash',
      {},
      geminiReply as never,
    );
    expect(statusOf(geminiReply)).toBe(400);
    const geminiBody = sent(geminiReply);
    expect(geminiBody).toEqual({
      error: { code: 400, message: expect.any(String), status: 'INVALID_ARGUMENT' },
    });

    // Cross-dialect shape checks: each is only its own vendor's envelope.
    expect(openaiBody).not.toHaveProperty('type');
    expect(anthropicBody.error).not.toHaveProperty('code');
    expect(anthropicBody.error).not.toHaveProperty('param');
    expect(geminiBody).not.toHaveProperty('type');
    expect(geminiBody.error).not.toHaveProperty('type');
    expect(geminiBody.error).not.toHaveProperty('param');
  });

  it("answers a batch id created by a different dialect with 404 in the calling surface's own envelope", async () => {
    const files = createFileStore();
    const target = createSharedTarget();
    const runner = createRunner(target as unknown as BatchExecutionTarget, 1);
    const batches = new BatchService(runner, new FilesService(files));
    const openaiController = await createBatchHttpApp(batches);
    const anthropicController = await createBatchHttpApp(batches);

    const anthropicCreateReply = await anthropicController.inject({
      method: 'POST',
      url: '/v1/messages/batches',
      headers: batchTestHeaders,
      payload: {
        requests: [
          {
            custom_id: 'x',
            params: {
              model: 'claude-3',
              max_tokens: 8,
              messages: [{ role: 'user', content: 'hi' }],
            },
          },
        ],
      },
    });
    const anthropicId = sent(anthropicCreateReply).id;
    const bareId = anthropicId.replace(/^msgbatch_/u, '');

    // The same id, fetched through the OpenAI surface, is 404 in the OpenAI
    // envelope -- not the Anthropic envelope, and not an empty 200.

    const openaiGetReply = await openaiController.inject({
      method: 'GET',
      url: `/v1/batches/${encodeURIComponent(`batch_${bareId}`)}`,
      headers: batchTestHeaders,
    });
    expect(statusOf(openaiGetReply)).toBe(404);
    expect(sent(openaiGetReply)).toEqual({
      error: {
        code: 'not_found',
        message: expect.any(String),
        param: null,
        type: 'invalid_request_error',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 4. /v1/complete round-trip fidelity
// ---------------------------------------------------------------------------

describe('/v1/complete round-trip fidelity', () => {
  const cases: Array<{
    name: string;
    prompt: string;
    expectedMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  }> = [
    {
      name: 'a plain prompt',
      prompt: '\n\nHuman: Hello there\n\nAssistant:',
      expectedMessages: [{ role: 'user', content: 'Hello there' }],
    },
    {
      name: 'a prompt with a prefilled assistant turn',
      prompt: '\n\nHuman: Continue this story\n\nAssistant: Once upon a time',
      expectedMessages: [
        { role: 'user', content: 'Continue this story' },
        { role: 'assistant', content: 'Once upon a time' },
      ],
    },
    {
      name: 'a prompt with no Human:/Assistant: markers at all',
      prompt: 'just a raw prompt, no markers',
      expectedMessages: [{ role: 'user', content: 'just a raw prompt, no markers' }],
    },
  ];

  it.each(cases)(
    'parses $name into the documented turns, and renders the reply back with the leading space restored',
    ({ prompt, expectedMessages }) => {
      const request = normalizeAnthropicCompleteRequest({
        model: 'claude-3',
        prompt,
        max_tokens_to_sample: 32,
      });
      const messagesRequest = toAnthropicMessagesRequest(request);
      expect(messagesRequest.messages).toEqual(expectedMessages);
      expect(messagesRequest.max_tokens).toBe(32);

      const rendered = toAnthropicCompletionResponse(
        {
          id: 'msg_x',
          type: 'message',
          role: 'assistant',
          model: 'claude-3',
          content: [{ type: 'text', text: 'reply text' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
        } as any,
        'claude-3',
        'compl_x',
      );
      expect(rendered).toEqual({
        type: 'completion',
        id: 'compl_x',
        completion: ' reply text',
        stop_reason: 'end_turn',
        stop: null,
        model: 'claude-3',
      });
    },
  );

  it('refuses a streaming request with the documented Anthropic 400 shape, not merely a non-200', async () => {
    const proxyService = { handleAnthropicMessages: vi.fn() };
    const app = await createAnthropicCompleteHttpApp(proxyService);
    const reply = await app.inject({
      method: 'POST',
      url: '/v1/complete',
      headers: completionTestHeaders,
      payload: { model: 'claude-3', prompt: 'hi', max_tokens_to_sample: 16, stream: true },
    });

    expect(statusOf(reply)).toBe(400);
    expect(proxyService.handleAnthropicMessages).not.toHaveBeenCalled();
    expect(sent(reply)).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: expect.stringContaining('stream') },
      request_id: expect.stringMatching(/^req_/u),
    });
  });
});
