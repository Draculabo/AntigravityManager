import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';

import { OpenAIController } from '@/modules/proxy-gateway/server/modules/openai/openai.controller';
import {
  defaultOpenAIChatCompletionStoreOptions,
  OpenAIChatCompletionService,
} from '@/modules/proxy-gateway/server/modules/openai/chat/openai-chat-completion.service';

const HOUR_MS = 60 * 60 * 1000;

function createReplyMock() {
  const reply: Record<string, unknown> = {};
  reply.status = vi.fn(() => reply);
  reply.header = vi.fn(() => reply);
  reply.raw = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn(), on: vi.fn() };
  reply.send = vi.fn(() => reply);
  return reply;
}

function chatResponse(id: string, content: string) {
  return {
    id,
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe('stored chat completions', () => {
  let directory = '';
  let filePath = '';

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-stored-completions-'));
    filePath = path.join(directory, 'openai-chat-completions.json');
  });

  afterEach(() => {
    // Windows keeps a handle for a moment after the last write resolves.
    fs.rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
  });

  function createStore(maxCompletions = 10) {
    return new OpenAIChatCompletionService({ filePath, maxCompletions, ttlMs: HOUR_MS });
  }

  function createController(store: OpenAIChatCompletionService, ...answers: unknown[]) {
    const handleChatCompletions = vi.fn();
    for (const answer of answers) {
      handleChatCompletions.mockResolvedValueOnce(answer);
    }
    const controller = new OpenAIController(
      { handleChatCompletions } as never,
      undefined,
      undefined,
      undefined,
      store,
    );
    return { controller, handleChatCompletions };
  }

  it('replays the completion it answered with, after a restart', async () => {
    const writer = createStore();
    const created = createReplyMock();
    const { controller } = createController(writer, chatResponse('chatcmpl_kept', 'the answer'));
    await controller.chatCompletions(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'a question' }], store: true },
      created as never,
    );
    await writer.flush();

    const after = createController(createStore());
    const replayed = createReplyMock();
    after.controller.getStoredChatCompletion('chatcmpl_kept', replayed as never);

    const answered = (created.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(replayed.status).toHaveBeenCalledWith(200);
    expect((replayed.send as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(answered);
  });

  it('keeps nothing when the request did not ask it to', async () => {
    const store = createStore();
    const { controller } = createController(store, chatResponse('chatcmpl_transient', 'gone'));
    await controller.chatCompletions(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'a question' }] },
      createReplyMock() as never,
    );
    const reply = createReplyMock();

    controller.getStoredChatCompletion('chatcmpl_transient', reply as never);

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'completion_not_found',
        message: "Completion with id 'chatcmpl_transient' not found.",
        param: 'completion_id',
        type: 'invalid_request_error',
      },
    });
  });

  it('refuses store on a streamed request instead of quietly keeping nothing', async () => {
    const store = createStore();
    const { controller, handleChatCompletions } = createController(store, of('data: {}\n\n'));
    const reply = createReplyMock();

    await controller.chatCompletions(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'a question' }],
        store: true,
        stream: true,
      },
      reply as never,
    );

    expect(handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'unsupported_parameter',
        message: expect.stringContaining('store is not supported together with stream'),
        param: 'store',
        type: 'invalid_request_error',
      },
    });
  });

  it('drops a stored completion whose shape it no longer understands', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          { key: 'chatcmpl_damaged', updatedAt: Date.now(), value: { id: 'chatcmpl_damaged' } },
          {
            key: 'chatcmpl_intact',
            updatedAt: Date.now(),
            value: chatResponse('chatcmpl_intact', 'kept'),
          },
        ],
      }),
      'utf-8',
    );
    const { controller } = createController(createStore());
    const damaged = createReplyMock();
    const intact = createReplyMock();

    controller.getStoredChatCompletion('chatcmpl_damaged', damaged as never);
    controller.getStoredChatCompletion('chatcmpl_intact', intact as never);

    expect(damaged.status).toHaveBeenCalledWith(404);
    expect(intact.status).toHaveBeenCalledWith(200);
  });

  it('bounds what it keeps, oldest first', async () => {
    const writer = createStore(2);
    const { controller } = createController(
      writer,
      ...[0, 1, 2].map((index) => chatResponse(`chatcmpl_${index}`, `answer ${index}`)),
    );
    for (const index of [0, 1, 2]) {
      await controller.chatCompletions(
        { model: 'gpt-4o', messages: [{ role: 'user', content: `turn ${index}` }], store: true },
        createReplyMock() as never,
      );
    }
    await writer.flush();

    const after = createController(createStore(2));
    const evicted = createReplyMock();
    const kept = createReplyMock();
    after.controller.getStoredChatCompletion('chatcmpl_0', evicted as never);
    after.controller.getStoredChatCompletion('chatcmpl_2', kept as never);

    expect(evicted.status).toHaveBeenCalledWith(404);
    expect(kept.status).toHaveBeenCalledWith(200);
    expect(fs.readdirSync(directory)).toEqual(['openai-chat-completions.json']);
  });

  it('writes nothing outside an explicit path while the tests run', () => {
    expect(defaultOpenAIChatCompletionStoreOptions().filePath).toBeUndefined();
  });
});
