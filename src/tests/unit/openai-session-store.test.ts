import { Observable, of } from 'rxjs';
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
  it('keeps earlier turns when the client sends only the newest message', () => {
    const store = new OpenAISessionStore();
    const first = store.prepareRequest(request([{ role: 'user', content: 'first question' }]));
    store.recordResponse(first, response('first answer'));

    const second = store.prepareRequest(request([{ role: 'user', content: 'second question' }]));

    expect(second.request.messages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ]);
  });

  it('does not duplicate history when the client resends the full conversation', () => {
    const store = new OpenAISessionStore();
    const first = store.prepareRequest(request([{ role: 'user', content: 'first question' }]));
    store.recordResponse(first, response('first answer'));

    const second = store.prepareRequest(
      request([
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
      ]),
    );

    expect(second.request.messages).toHaveLength(3);
  });

  it('resets or disables history only through explicit session controls', () => {
    const store = new OpenAISessionStore();
    const first = store.prepareRequest(request([{ role: 'user', content: 'first question' }]));
    store.recordResponse(first, response('first answer'));

    const reset = store.prepareRequest(
      request([{ role: 'user', content: 'new conversation' }], { session_reset: true }),
    );
    const disabled = store.prepareRequest(
      request([{ role: 'user', content: 'stateless' }], { session_store: false }),
    );

    expect(reset.request.messages).toEqual([{ role: 'user', content: 'new conversation' }]);
    expect(disabled.shouldStore).toBe(false);
  });

  it('reconstructs streamed tool calls for the next turn', async () => {
    const store = new OpenAISessionStore();
    const prepared = store.prepareRequest(request([{ role: 'user', content: 'check weather' }]));
    const stream = of(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"weather","arguments":"{\\"city\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Samara\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    );

    await consume(store.recordStreamResponse(prepared, stream));
    const next = store.prepareRequest(
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
  });

  it('keeps stored history within the configured character budget', () => {
    const store = new OpenAISessionStore({ maxHistoryChars: 120 });
    const first = store.prepareRequest(
      request([
        { role: 'system', content: 'stable instructions' },
        { role: 'user', content: 'x'.repeat(100) },
      ]),
    );
    store.recordResponse(first, response('y'.repeat(100)));

    const next = store.prepareRequest(request([{ role: 'user', content: 'latest' }]));
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
  });
});

async function consume(stream: Observable<string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.subscribe({ complete: resolve, error: reject });
  });
}
