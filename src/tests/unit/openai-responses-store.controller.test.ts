import { describe, expect, it, vi } from 'vitest';

import { OpenAIController } from '@/modules/proxy-gateway/server/modules/openai/openai.controller';
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
    chat: new OpenAIController(
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

    store.getResponse('resp_kept', retrieved as never);

    const answered = (created.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
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
      chatResponse('resp_next', 'still chained'),
    );
    await chat.responses(
      { input: 'a question', model: 'gpt-4o', store: false },
      createReplyMock() as never,
    );
    const retrieved = createReplyMock();

    store.getResponse('resp_transient', retrieved as never);

    expect(retrieved.status).toHaveBeenCalledWith(404);
  });

  it('deletes a stored response once and reports it missing after that', async () => {
    const { chat, store } = createSurface(chatResponse('resp_doomed', 'the answer'));
    await chat.responses({ input: 'a question', model: 'gpt-4o' }, createReplyMock() as never);
    const first = createReplyMock();
    const second = createReplyMock();

    store.deleteResponse('resp_doomed', first as never);
    store.deleteResponse('resp_doomed', second as never);

    expect(first.status).toHaveBeenCalledWith(200);
    expect(first.send).toHaveBeenCalledWith({
      id: 'resp_doomed',
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
    await chat.responses({ input: 'a question', model: 'gpt-4o' }, createReplyMock() as never);
    store.deleteResponse('resp_chain', createReplyMock() as never);
    const continuation = createReplyMock();

    await chat.responses(
      { input: 'and another', previous_response_id: 'resp_chain' },
      continuation as never,
    );

    expect(continuation.status).toHaveBeenCalledWith(404);
  });
});
