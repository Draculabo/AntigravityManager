import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenAIController } from '@/modules/proxy-gateway/server/modules/openai/openai.controller';
import {
  defaultOpenAIResponsesSessionStoreOptions,
  OpenAIResponsesSessionService,
} from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.service';

const HOUR_MS = 60 * 60 * 1000;

function createReplyMock() {
  const reply: Record<string, unknown> = {};
  reply.status = vi.fn(() => reply);
  reply.header = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply;
}

function chatResponse(id: string, content: string) {
  return {
    id,
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [{ index: 0, finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe('Responses continuation across a restart', () => {
  let directory = '';
  let filePath = '';

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-responses-sessions-'));
    filePath = path.join(directory, 'openai-responses-sessions.json');
  });

  afterEach(() => {
    // Windows keeps a handle for a moment after the last write resolves.
    fs.rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
  });

  function createStore(maxSessions = 10) {
    return new OpenAIResponsesSessionService({ filePath, maxSessions, ttlMs: HOUR_MS });
  }

  function createController(store: OpenAIResponsesSessionService, ...answers: unknown[]) {
    const handleChatCompletions = vi.fn();
    for (const answer of answers) {
      handleChatCompletions.mockResolvedValueOnce(answer);
    }
    const controller = new OpenAIController(
      { handleChatCompletions } as never,
      undefined,
      undefined,
      store,
    );
    return { controller, handleChatCompletions };
  }

  it('resolves a previous_response_id handed out before the process went away', async () => {
    const writer = createStore();
    const before = createController(writer, chatResponse('resp_restart', 'It is 41'));
    await before.controller.responses(
      { input: 'remember the number 41', model: 'gpt-4o' },
      createReplyMock() as never,
    );
    await writer.flush();

    const after = createController(createStore(), chatResponse('resp_restart_2', 'It is 42'));
    await after.controller.responses(
      { input: 'add one to it', previous_response_id: 'resp_restart' },
      createReplyMock() as never,
    );

    expect(after.handleChatCompletions).toHaveBeenCalledTimes(1);
    expect(after.handleChatCompletions.mock.calls[0][0]).toMatchObject({ model: 'gpt-4o' });
    expect(after.handleChatCompletions.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'remember the number 41' },
      { role: 'assistant', content: 'It is 41' },
      { role: 'user', content: 'add one to it' },
    ]);
  });

  it('answers an id the restart aged out, not one it invented', async () => {
    const writer = createStore();
    const before = createController(writer, chatResponse('resp_stale', 'stale answer'));
    await before.controller.responses(
      { input: 'first', model: 'gpt-4o' },
      createReplyMock() as never,
    );
    await writer.flush();

    const expired = new OpenAIResponsesSessionService({ filePath, maxSessions: 10, ttlMs: 1 });
    const after = createController(expired);
    const reply = createReplyMock();
    await after.controller.responses(
      { input: 'second', previous_response_id: 'resp_stale' },
      reply as never,
    );

    expect(after.handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it('keeps the stored history bounded and the file its only artifact', async () => {
    const writer = createStore(3);
    const { controller } = createController(
      writer,
      ...[0, 1, 2, 3].map((index) => chatResponse(`resp_${index}`, `answer ${index}`)),
    );
    for (const index of [0, 1, 2, 3]) {
      await controller.responses(
        { input: `turn ${index}`, model: 'gpt-4o' },
        createReplyMock() as never,
      );
    }
    await writer.flush();

    const evicted = createController(createStore(3));
    const evictedReply = createReplyMock();
    await evicted.controller.responses(
      { input: 'continue', previous_response_id: 'resp_0' },
      evictedReply as never,
    );

    const kept = createController(createStore(3), chatResponse('resp_kept', 'kept'));
    await kept.controller.responses(
      { input: 'continue', previous_response_id: 'resp_3' },
      createReplyMock() as never,
    );

    expect(evictedReply.status).toHaveBeenCalledWith(400);
    expect(kept.handleChatCompletions).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(directory)).toEqual(['openai-responses-sessions.json']);
  });

  it('drops a session whose stored shape it no longer understands', async () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            key: 'resp_damaged',
            updatedAt: Date.now(),
            value: { instructions: 'no input items and no model' },
          },
          {
            key: 'resp_intact',
            updatedAt: Date.now(),
            value: { inputItems: [], model: 'gpt-4o' },
          },
        ],
      }),
      'utf-8',
    );

    const damaged = createController(createStore());
    const damagedReply = createReplyMock();
    await damaged.controller.responses(
      { input: 'go on', previous_response_id: 'resp_damaged' },
      damagedReply as never,
    );

    const intact = createController(createStore(), chatResponse('resp_intact_2', 'still here'));
    await intact.controller.responses(
      { input: 'go on', previous_response_id: 'resp_intact' },
      createReplyMock() as never,
    );

    expect(damaged.handleChatCompletions).not.toHaveBeenCalled();
    expect(damagedReply.status).toHaveBeenCalledWith(400);
    expect(intact.handleChatCompletions).toHaveBeenCalledTimes(1);
  });

  it('writes nothing outside an explicit path while the tests run', () => {
    expect(defaultOpenAIResponsesSessionStoreOptions().filePath).toBeUndefined();
  });
});
