import { Observable, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { OpenAISessionStore } from '@/modules/proxy-gateway/server/openai-session-store';
import type {
  OpenAIChatRequest,
  OpenAIChatResponse,
} from '@/modules/proxy-gateway/server/interfaces/request-interfaces';

function request(
  messages: OpenAIChatRequest['messages'],
  overrides: Partial<OpenAIChatRequest> = {},
): OpenAIChatRequest {
  return {
    model: 'gemini-3-flash',
    messages,
    session_id: 'session-1',
    ...overrides,
  };
}

function response(content: string): OpenAIChatResponse {
  return {
    id: 'response-1',
    object: 'chat.completion',
    created: 1,
    model: 'gemini-3-flash',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe('OpenAISessionStore', () => {
  it('keeps earlier turns when the client sends only the newest message', async () => {
    const store = new OpenAISessionStore();
    const first = await store.prepareRequest(
      request([{ role: 'user', content: 'first question' }]),
    );
    store.recordResponse(first, response('first answer'));

    const second = await store.prepareRequest(
      request([{ role: 'user', content: 'second question' }]),
    );

    expect(second.request.messages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ]);
    store.abandonRequest(second);
  });

  it('does not duplicate history when the client resends the full conversation', async () => {
    const store = new OpenAISessionStore();
    const first = await store.prepareRequest(
      request([{ role: 'user', content: 'first question' }]),
    );
    store.recordResponse(first, response('first answer'));

    const second = await store.prepareRequest(
      request([
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
      ]),
    );

    expect(second.request.messages).toHaveLength(3);
    store.abandonRequest(second);
  });

  it('resets or disables history only through explicit session controls', async () => {
    const store = new OpenAISessionStore();
    const first = await store.prepareRequest(
      request([{ role: 'user', content: 'first question' }]),
    );
    store.recordResponse(first, response('first answer'));

    const reset = await store.prepareRequest(
      request([{ role: 'user', content: 'new conversation' }], { session_reset: true }),
    );
    const disabled = await store.prepareRequest(
      request([{ role: 'user', content: 'stateless' }], { session_store: false }),
    );

    expect(reset.request.messages).toEqual([{ role: 'user', content: 'new conversation' }]);
    expect(disabled.shouldStore).toBe(false);
    store.abandonRequest(reset);
  });

  it('reconstructs streamed tool calls for the next turn', async () => {
    const store = new OpenAISessionStore();
    const prepared = await store.prepareRequest(
      request([{ role: 'user', content: 'check weather' }]),
    );
    const stream = of(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"weather","arguments":"{\\"city\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Samara\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    );

    await consume(store.recordStreamResponse(prepared, stream));
    const next = await store.prepareRequest(
      request([{ role: 'tool', tool_call_id: 'call-1', content: 'sunny' }]),
    );

    expect(next.request.messages[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'weather', arguments: '{"city":"Samara"}' },
        },
      ],
    });
    store.abandonRequest(next);
  });

  it('keeps stored history within the configured character budget', async () => {
    const store = new OpenAISessionStore({ maxHistoryChars: 120 });
    const first = await store.prepareRequest(
      request([
        { role: 'system', content: 'stable instructions' },
        { role: 'user', content: 'x'.repeat(100) },
      ]),
    );
    store.recordResponse(first, response('y'.repeat(100)));

    const next = await store.prepareRequest(request([{ role: 'user', content: 'latest' }]));
    const serializedLength = next.request.messages.reduce(
      (total, message) => total + JSON.stringify(message).length,
      0,
    );

    expect(serializedLength).toBeLessThanOrEqual(120);
    expect(next.request.messages).toContainEqual({
      role: 'system',
      content: 'stable instructions',
    });
    expect(next.request.messages.at(-1)).toEqual({ role: 'user', content: 'latest' });
    store.abandonRequest(next);
  });

  it('reserves enough history budget for the latest conversation turn', async () => {
    const store = new OpenAISessionStore({ maxHistoryChars: 120 });
    const latestMessage = { role: 'user', content: 'x'.repeat(50) };
    const prepared = await store.prepareRequest(
      request([
        { role: 'system', content: 'a'.repeat(20) },
        { role: 'system', content: 'b'.repeat(20) },
        latestMessage,
      ]),
    );
    const serializedLength = prepared.request.messages.reduce(
      (total, message) => total + JSON.stringify(message).length,
      0,
    );

    expect(serializedLength).toBeLessThanOrEqual(120);
    expect(prepared.request.messages.at(-1)).toEqual(latestMessage);
    store.abandonRequest(prepared);
  });

  it('serializes concurrent turns that use the same session ID', async () => {
    const store = new OpenAISessionStore();
    const first = await store.prepareRequest(
      request([{ role: 'user', content: 'first question' }]),
    );
    const secondStarted = createSignal();
    const secondPromise = (async () => {
      secondStarted.resolve();
      return store.prepareRequest(request([{ role: 'user', content: 'second question' }]));
    })();

    await secondStarted.promise;
    store.recordResponse(first, response('first answer'));
    const second = await secondPromise;

    expect(second.request.messages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ]);
    store.abandonRequest(second);
  });

  it('does not serialize requests from different session IDs', async () => {
    const store = new OpenAISessionStore();
    const first = await store.prepareRequest(request([{ role: 'user', content: 'first session' }]));
    const second = await store.prepareRequest(
      request([{ role: 'user', content: 'second session' }], { session_id: 'session-2' }),
    );

    expect(second.request.messages).toEqual([{ role: 'user', content: 'second session' }]);
    store.abandonRequest(first);
    store.abandonRequest(second);
  });

  it('releases a queued session when a request is abandoned', async () => {
    const store = new OpenAISessionStore();
    const first = await store.prepareRequest(request([{ role: 'user', content: 'failed turn' }]));
    const secondPromise = store.prepareRequest(request([{ role: 'user', content: 'retry turn' }]));

    store.abandonRequest(first);
    const second = await secondPromise;

    expect(second.request.messages).toEqual([{ role: 'user', content: 'retry turn' }]);
    store.abandonRequest(second);
  });

  it('releases a queued session when a stream fails', async () => {
    const store = new OpenAISessionStore();
    const first = await store.prepareRequest(request([{ role: 'user', content: 'stream turn' }]));
    const stream = store.recordStreamResponse(
      first,
      throwError(() => new Error('stream failed')),
    );

    await expect(consume(stream)).rejects.toThrow('stream failed');
    const second = await store.prepareRequest(request([{ role: 'user', content: 'next turn' }]));

    expect(second.request.messages).toEqual([{ role: 'user', content: 'next turn' }]);
    store.abandonRequest(second);
  });
});

function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function consume(stream: Observable<string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.subscribe({ complete: resolve, error: reject });
  });
}
