import { describe, expect, it, vi } from 'vitest';

import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { OpenAIResponsesSessionService } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.service';
import { OpenAIResponsesStoreController } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-store.controller';

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

function createSurface(...answers: unknown[]) {
  const responsesSessions = new OpenAIResponsesSessionService({});
  const handleChatCompletions = vi.fn();
  for (const answer of answers) {
    handleChatCompletions.mockResolvedValueOnce(answer);
  }
  return {
    chat: new OpenAIOperations(
      { handleChatCompletions } as never,
      undefined,
      undefined,
      responsesSessions,
    ),
    store: new OpenAIResponsesStoreController(responsesSessions),
  };
}

describe('OpenAIResponsesStoreController', () => {
  it('replays the response the create call answered with', async () => {
    const { chat, store } = createSurface(chatResponse('resp_kept', 'the answer'));
    const created = createReplyMock();
    await chat.responses({ input: 'a question', model: 'gpt-4o' }, created as never);
    const retrieved = createReplyMock();
    const answered = (created.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      id: string;
    };

    store.getResponse(answered.id, retrieved as never);

    expect(retrieved.status).toHaveBeenCalledWith(200);
    expect((retrieved.send as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(answered);
  });

  it('reports an unknown id as not found, in the OpenAI envelope', () => {
    const { store } = createSurface();
    const reply = createReplyMock();

    store.getResponse('resp_missing', reply as never);

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'response_not_found',
        message: "Response with id 'resp_missing' not found.",
        param: 'id',
        type: 'invalid_request_error',
      },
    });
  });

  it('never retains a response the caller asked not to store', async () => {
    const { chat, store } = createSurface(
      chatResponse('resp_transient', 'gone'),
      chatResponse('resp_next', 'must not run'),
    );
    const created = createReplyMock();
    await chat.responses({ input: 'a question', model: 'gpt-4o', store: false }, created as never);
    const responseId = (
      (created.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string }
    ).id;
    const retrieved = createReplyMock();

    store.getResponse(responseId, retrieved as never);

    expect(retrieved.status).toHaveBeenCalledWith(404);

    const continued = createReplyMock();
    await chat.responses(
      { input: 'continue', previous_response_id: responseId },
      continued as never,
    );
    expect(continued.status).toHaveBeenCalledWith(404);
  });

  it('retains responses when store is omitted or explicitly true', async () => {
    for (const storeValue of [undefined, true]) {
      const { chat, store } = createSurface(chatResponse('resp_kept', 'kept'));
      const created = createReplyMock();
      await chat.responses(
        { input: 'question', model: 'gpt-4o', store: storeValue },
        created as never,
      );
      const responseId = (
        (created.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string }
      ).id;
      const retrieved = createReplyMock();

      store.getResponse(responseId, retrieved as never);

      expect(retrieved.status).toHaveBeenCalledWith(200);
    }
  });

  it('does not create continuation state for an incomplete non-stream response', async () => {
    const incomplete = chatResponse('resp_incomplete', 'truncated');
    incomplete.choices[0].finish_reason = 'length';
    const { chat, store } = createSurface(incomplete);
    const created = createReplyMock();
    await chat.responses({ input: 'a question', model: 'gpt-4o' }, created as never);
    const responseId = (
      (created.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string }
    ).id;
    const retrieved = createReplyMock();

    store.getResponse(responseId, retrieved as never);

    expect(retrieved.status).toHaveBeenCalledWith(404);
  });

  it('deletes a stored response once and reports it missing after that', async () => {
    const { chat, store } = createSurface(chatResponse('resp_doomed', 'the answer'));
    const created = createReplyMock();
    await chat.responses({ input: 'a question', model: 'gpt-4o' }, created as never);
    const responseId = (
      (created.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string }
    ).id;
    const first = createReplyMock();
    const second = createReplyMock();

    store.deleteResponse(responseId, first as never);
    store.deleteResponse(responseId, second as never);

    expect(first.status).toHaveBeenCalledWith(200);
    expect(first.send).toHaveBeenCalledWith({
      id: responseId,
      object: 'response',
      deleted: true,
    });
    expect(second.status).toHaveBeenCalledWith(404);
  });

  it('forgets the continuation history of a deleted response', async () => {
    const { chat, store } = createSurface(
      chatResponse('resp_chain', 'the answer'),
      chatResponse('resp_chain_2', 'the second answer'),
    );
    const created = createReplyMock();
    await chat.responses({ input: 'a question', model: 'gpt-4o' }, created as never);
    const responseId = (
      (created.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string }
    ).id;
    store.deleteResponse(responseId, createReplyMock() as never);
    const continuation = createReplyMock();

    await chat.responses(
      { input: 'and another', previous_response_id: responseId },
      continuation as never,
    );

    expect(continuation.status).toHaveBeenCalledWith(404);
  });
});
