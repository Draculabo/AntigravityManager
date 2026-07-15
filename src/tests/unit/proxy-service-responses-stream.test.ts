import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';
import { lastValueFrom, Observable, toArray } from 'rxjs';

import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

function parseEvent(serializedEvent: string): Record<string, unknown> {
  return JSON.parse(serializedEvent.slice('data: '.length)) as Record<string, unknown>;
}

function createResponsesStream(service: ProxyService, upstreamStream: NodeJS.ReadableStream): Observable<unknown> {
  const method: unknown = Reflect.get(service, 'processResponsesStreamResponse');
  if (typeof method !== 'function') {
    throw new Error('Responses stream processor is unavailable');
  }

  const result: unknown = Reflect.apply(method, service, [upstreamStream, 'gemini-3-pro']);
  if (!(result instanceof Observable)) {
    throw new Error('Responses stream processor did not return an Observable');
  }
  return result;
}

describe('ProxyService Responses streaming', () => {
  it('keeps an otherwise idle Responses connection alive with SSE comments', async () => {
    vi.useFakeTimers();
    try {
      const service = new ProxyService({} as never, {} as never);
      const upstreamStream = new PassThrough();
      const events: string[] = [];
      const subscription = createResponsesStream(service, upstreamStream).subscribe((event) => {
        events.push(String(event));
      });

      await vi.advanceTimersByTimeAsync(15_000);

      expect(events).toContain(': ping\n\n');
      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('converts nested Gemini SSE payloads into Responses events', async () => {
    const service = new ProxyService({} as never, {} as never);
    const upstreamStream = Readable.from([
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Checking docs"},{"functionCall":{"id":"call_search_1","name":"search_docs","args":{"query":"Gemini API"}}}]},"groundingMetadata":{"webSearchQueries":["Gemini API"]}}]}}\n\n',
      ),
      Buffer.from('data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n'),
    ]);

    const serializedEvents = await lastValueFrom(
      createResponsesStream(service, upstreamStream).pipe(toArray()),
    );
    const events = serializedEvents.map((event) => parseEvent(String(event)));

    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events[8]).toMatchObject({ delta: expect.stringContaining('Gemini API') });
    expect(events.at(-1)).toMatchObject({
      response: {
        output: [
          expect.objectContaining({ type: 'message' }),
          expect.objectContaining({ call_id: 'call_search_1', type: 'function_call' }),
        ],
      },
    });
  });
});
