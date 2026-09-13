import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastValueFrom, Observable, of, toArray } from 'rxjs';

import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
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

function getSentResponseId(reply: Record<string, unknown>): string {
  const send = reply.send as ReturnType<typeof vi.fn>;
  const response = send.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  if (typeof response?.id !== 'string') {
    throw new Error('Expected a Responses payload with an id');
  }
  return response.id;
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
  let stores: OpenAIResponsesSessionService[] = [];

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-responses-sessions-'));
    filePath = path.join(directory, 'openai-responses-sessions.json');
    stores = [];
  });

  afterEach(async () => {
    await Promise.all(stores.map((store) => store.flush()));
    // Windows keeps a handle for a moment after the last write resolves.
    fs.rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
  });

  function createStore(maxSessions = 10) {
    const store = new OpenAIResponsesSessionService({ filePath, maxSessions, ttlMs: HOUR_MS });
    stores.push(store);
    return store;
  }

  function createController(store: OpenAIResponsesSessionService, ...answers: unknown[]) {
    const handleChatCompletions = vi.fn();
    for (const answer of answers) {
      handleChatCompletions.mockResolvedValueOnce(answer);
    }
    const controller = new OpenAIOperations(
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
    const beforeReply = createReplyMock();
    await before.controller.responses(
      { input: 'remember the number 41', model: 'gpt-4o' },
      beforeReply as never,
    );
    await writer.flush();
    const previousResponseId = getSentResponseId(beforeReply);
    expect(previousResponseId).not.toBe('resp_restart');
    expect(before.handleChatCompletions.mock.calls[0]?.[3]).toEqual({
      requestSessionId: previousResponseId,
      responseId: previousResponseId,
    });

    const after = createController(createStore(), chatResponse('resp_restart_2', 'It is 42'));
    const afterReply = createReplyMock();
    await after.controller.responses(
      { input: 'add one to it', previous_response_id: previousResponseId },
      afterReply as never,
    );

    expect(after.handleChatCompletions).toHaveBeenCalledTimes(1);
    expect(after.handleChatCompletions.mock.calls[0][0]).toMatchObject({ model: 'gpt-4o' });
    expect(after.handleChatCompletions.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'remember the number 41' },
      { role: 'assistant', content: 'It is 41' },
      { role: 'user', content: 'add one to it' },
    ]);
    const childResponseId = getSentResponseId(afterReply);
    expect(after.handleChatCompletions.mock.calls[0]?.[3]).toEqual({
      requestSessionId: previousResponseId,
      responseId: childResponseId,
    });
    expect(childResponseId).not.toBe(previousResponseId);
  });

  it('stores only replay deltas while sibling HTTP branches remain isolated', async () => {
    const store = createStore();
    const rootController = createController(store, chatResponse('chat_root', 'root answer'));
    const rootReply = createReplyMock();
    await rootController.controller.responses(
      { input: 'root request', model: 'gpt-4o' },
      rootReply as never,
    );
    const rootResponseId = getSentResponseId(rootReply);
    const rootHistory = store.get(rootResponseId)?.inputItems;
    if (!rootHistory) {
      throw new Error('Expected root Responses history');
    }

    const branchA = createController(store, chatResponse('chat_a', 'branch a answer'));
    const branchAReply = createReplyMock();
    await branchA.controller.responses(
      {
        input: [
          ...structuredClone(rootHistory),
          { id: 'msg_branch_a', type: 'message', role: 'user', content: 'branch a request' },
        ],
        previous_response_id: rootResponseId,
      },
      branchAReply as never,
    );

    const branchB = createController(store, chatResponse('chat_b', 'branch b answer'));
    const branchBReply = createReplyMock();
    await branchB.controller.responses(
      { input: 'branch b request', previous_response_id: rootResponseId },
      branchBReply as never,
    );

    const branchAHistory = JSON.stringify(store.get(getSentResponseId(branchAReply))?.inputItems);
    const branchBHistory = JSON.stringify(store.get(getSentResponseId(branchBReply))?.inputItems);
    expect(branchAHistory.match(/root request/g)).toHaveLength(1);
    expect(branchAHistory).toContain('branch a request');
    expect(branchAHistory).not.toContain('branch b request');
    expect(branchBHistory).toContain('branch b request');
    expect(branchBHistory).not.toContain('branch a request');
  });

  it('ignores legacy inputs during previous_response_id continuation without rewriting them', async () => {
    const writer = createStore();
    const inputItems = [
      { type: '', role: 'user', content: 'Ignored empty-type history.' },
      { type: 'message', role: 'user', content: { legacy: 'Ignored object history.' } },
      { role: 'user', content: 'Remember 41.' },
    ];
    writer.save('resp_legacy', { model: 'gpt-4o', inputItems });
    await writer.flush();

    const restarted = createStore();
    const after = createController(restarted, chatResponse('resp_continued', '42'));
    await after.controller.responses(
      { previous_response_id: 'resp_legacy', input: 'Add one.' },
      createReplyMock() as never,
    );
    await restarted.flush();

    expect(after.handleChatCompletions).toHaveBeenCalledTimes(1);
    expect(after.handleChatCompletions.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: '' },
      { role: 'user', content: 'Remember 41.' },
      { role: 'user', content: 'Add one.' },
    ]);
    expect(createStore().get('resp_legacy')?.inputItems).toEqual(inputItems);
  });

  it('persists placeholders rather than inline media across a restart', async () => {
    const writer = createStore();
    const inputItems = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQ==' }],
      },
      {
        type: 'function_call_output',
        call_id: 'call_image',
        output: [{ type: 'input_image', image_url: 'data:image/png;base64,Ag==' }],
      },
    ];
    writer.save('resp_media', { model: 'gpt-4o', inputItems });
    await writer.flush();

    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('data:image/');
    expect(createStore().get('resp_media')?.inputItems).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '[historical image omitted]' }],
      },
      {
        type: 'function_call_output',
        call_id: 'call_image',
        output: [{ type: 'input_text', text: '[historical image omitted]' }],
      },
    ]);
    expect(inputItems[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQ==' }],
    });
  });

  it('bounds raw inline media from a pre-upgrade durable record before continuation', async () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            key: 'resp_pre_media_bound',
            updatedAt: Date.now(),
            value: {
              model: 'gpt-4o',
              inputItems: [
                {
                  type: 'message',
                  role: 'user',
                  content: [
                    { type: 'input_image', image_url: 'data:image/png;base64,AQ==' },
                    {
                      type: 'audio_url',
                      audio_url: { url: 'data:audio/wav;base64,Ag==' },
                    },
                  ],
                },
              ],
            },
          },
        ],
      }),
      'utf8',
    );
    const restarted = createStore();
    const after = createController(restarted, chatResponse('resp_post_media_bound', 'done'));

    await after.controller.responses(
      { previous_response_id: 'resp_pre_media_bound', input: 'Continue safely.' },
      createReplyMock() as never,
    );

    expect(after.handleChatCompletions).toHaveBeenCalledTimes(1);
    const request = after.handleChatCompletions.mock.calls[0]?.[0];
    expect(JSON.stringify(request)).not.toContain('data:image/');
    expect(JSON.stringify(request)).not.toContain('data:audio/');
    expect(request.messages).toEqual([
      {
        role: 'user',
        content: '[historical image omitted]\n[historical audio omitted]',
      },
      { role: 'user', content: 'Continue safely.' },
    ]);
  });

  it('bounds inline media saved by the non-stream completion path', async () => {
    const writer = createStore();
    const { controller } = createController(writer, chatResponse('resp_media_http', 'done'));
    const reply = createReplyMock();

    await controller.responses(
      {
        model: 'gpt-4o',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQ==' }],
          },
        ],
      },
      reply as never,
    );
    await writer.flush();

    const stored = createStore().get(getSentResponseId(reply));
    expect(JSON.stringify(stored?.inputItems)).not.toContain('data:image/');
    expect(stored?.inputItems[0]).toMatchObject({
      content: [{ type: 'input_text', text: '[historical image omitted]' }],
    });
  });

  it('bounds inline media saved after a streaming response.completed event', async () => {
    const writer = createStore();
    const handleChatCompletions = vi.fn(
      (
        _request: unknown,
        _protocol: unknown,
        _signal: unknown,
        context: { responseId: string },
      ) => {
        const completed = {
          id: context.responseId,
          output: [{ type: 'message', role: 'assistant', content: 'done' }],
        };
        return Promise.resolve(
          of(`data: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`),
        );
      },
    );
    const controller = new OpenAIOperations(
      { handleChatCompletions } as never,
      undefined,
      undefined,
      writer,
    );
    const reply = createReplyMock();

    await controller.responses(
      {
        model: 'gpt-4o',
        stream: true,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQ==' }],
          },
        ],
      },
      reply as never,
    );
    const responseStream = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (!(responseStream instanceof Observable)) {
      throw new Error('Expected a Responses stream');
    }
    await lastValueFrom(responseStream.pipe(toArray()));
    await writer.flush();

    const responseId = (
      handleChatCompletions.mock.calls[0]?.[3] as { responseId: string } | undefined
    )?.responseId;
    if (!responseId) {
      throw new Error('Expected a caller-owned Responses id');
    }
    const stored = createStore().get(responseId);
    expect(JSON.stringify(stored?.inputItems)).not.toContain('data:image/');
    expect(stored?.inputItems[0]).toMatchObject({
      content: [{ type: 'input_text', text: '[historical image omitted]' }],
    });
  });

  it('answers an id the restart aged out, not one it invented', async () => {
    const writer = createStore();
    const before = createController(writer, chatResponse('resp_stale', 'stale answer'));
    const beforeReply = createReplyMock();
    await before.controller.responses({ input: 'first', model: 'gpt-4o' }, beforeReply as never);
    await writer.flush();
    const previousResponseId = getSentResponseId(beforeReply);

    const expired = new OpenAIResponsesSessionService({ filePath, maxSessions: 10, ttlMs: 1 });
    stores.push(expired);
    const after = createController(expired);
    const reply = createReplyMock();
    await after.controller.responses(
      { input: 'second', previous_response_id: previousResponseId },
      reply as never,
    );

    expect(after.handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(404);
  });

  it('keeps the stored history bounded and the file its only artifact', async () => {
    const writer = createStore(3);
    const { controller } = createController(
      writer,
      ...[0, 1, 2, 3].map((index) => chatResponse(`resp_${index}`, `answer ${index}`)),
    );
    const responseIds: string[] = [];
    for (const index of [0, 1, 2, 3]) {
      const reply = createReplyMock();
      await controller.responses({ input: `turn ${index}`, model: 'gpt-4o' }, reply as never);
      responseIds.push(getSentResponseId(reply));
    }
    await writer.flush();

    const evicted = createController(createStore(3));
    const evictedReply = createReplyMock();
    await evicted.controller.responses(
      { input: 'continue', previous_response_id: responseIds[0] },
      evictedReply as never,
    );

    const kept = createController(createStore(3), chatResponse('resp_kept', 'kept'));
    await kept.controller.responses(
      { input: 'continue', previous_response_id: responseIds[3] },
      createReplyMock() as never,
    );

    expect(evictedReply.status).toHaveBeenCalledWith(404);
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
    expect(damagedReply.status).toHaveBeenCalledWith(404);
    expect(intact.handleChatCompletions).toHaveBeenCalledTimes(1);
  });

  it('writes nothing outside an explicit path while the tests run', () => {
    expect(defaultOpenAIResponsesSessionStoreOptions().filePath).toBeUndefined();
  });
});
