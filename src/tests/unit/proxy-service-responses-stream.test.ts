import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';
import { lastValueFrom, Observable, toArray } from 'rxjs';

import { MAX_SSE_EVENT_BYTES } from '@/modules/proxy-gateway/antigravity/internal-sse';
import { OpenAIService as ProxyService } from '@/server/gateway/modules/openai/openai.service';
import { createAccount } from './proxy-real-path.harness';

function parseEvent(serializedEvent: string): Record<string, unknown> {
  const dataLine = serializedEvent.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) {
    throw new Error(`Missing SSE data line: ${serializedEvent}`);
  }
  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
}

function createResponsesStream(
  service: ProxyService,
  upstreamStream: NodeJS.ReadableStream,
  successContext?: { accountId: string; model: string },
  imagePermit?: { release: () => void },
  responseId?: string,
): Observable<unknown> {
  const method: unknown = Reflect.get(service, 'processResponsesStreamResponse');
  if (typeof method !== 'function') {
    throw new Error('Responses stream processor is unavailable');
  }

  const result: unknown = Reflect.apply(method, service, [
    upstreamStream,
    'gemini-3-pro',
    undefined,
    undefined,
    successContext?.model,
    undefined,
    undefined,
    successContext ? createAccount(successContext.accountId) : undefined,
    imagePermit,
    responseId,
  ]);
  if (!(result instanceof Observable)) {
    throw new Error('Responses stream processor did not return an Observable');
  }
  return result;
}

describe('ProxyService Responses streaming', () => {
  it.each([
    ['incomplete UTF-8', Buffer.from([0xe2, 0x82]), 'stream_decode_error'],
    [
      'oversized unterminated line',
      Buffer.from(`data: ${'x'.repeat(MAX_SSE_EVENT_BYTES)}`),
      'stream_decode_error',
    ],
    ['invalid provider JSON', Buffer.from('data: not json\n\n'), 'invalid_upstream_response'],
  ])('reports %s as a decoding failure', async (_label, bytes, errorCode) => {
    const service = new ProxyService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const upstreamStream = new PassThrough();
    const chunks: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      createResponsesStream(service, upstreamStream).subscribe({
        complete: resolve,
        error: reject,
        next: (event) => chunks.push(String(event)),
      });
    });

    upstreamStream.end(bytes);
    await completed;

    const events = chunks.filter((chunk) => chunk.includes('data: ')).map(parseEvent);
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.failed',
    ]);
    expect(events.at(-1)).toMatchObject({ response: { error: { code: errorCode } } });
  });

  it('uses the caller-owned response id for every lifecycle event', async () => {
    const service = new ProxyService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const upstreamStream = Readable.from([
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}}\n\n',
      ),
    ]);
    const responseId = 'resp_caller_owned';

    const serializedEvents = await lastValueFrom(
      createResponsesStream(service, upstreamStream, undefined, undefined, responseId).pipe(
        toArray(),
      ),
    );
    const lifecycle = serializedEvents
      .map((event) => parseEvent(String(event)))
      .filter((event) =>
        ['response.created', 'response.in_progress', 'response.completed'].includes(
          String(event.type),
        ),
      );

    expect(lifecycle).toHaveLength(3);
    expect(lifecycle.map((event) => Reflect.get(event.response as object, 'id'))).toEqual([
      responseId,
      responseId,
      responseId,
    ]);
  });

  it('keeps an otherwise idle Responses connection alive with SSE comments', async () => {
    vi.useFakeTimers();
    try {
      const service = new ProxyService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
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
    const service = new ProxyService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
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
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events[14]).toMatchObject({ delta: expect.stringContaining('Gemini API') });
    expect(events.at(-1)).toMatchObject({
      response: {
        output: [
          expect.objectContaining({ phase: 'commentary', type: 'message' }),
          expect.objectContaining({ call_id: 'call_search_1', type: 'function_call' }),
          expect.objectContaining({ phase: 'commentary', type: 'message' }),
        ],
      },
    });
  });

  it('clears image retry state only for image data followed by a clean upstream end', async () => {
    const markUpstreamSuccess = vi.fn();
    const eligibility = {
      isLeaseEligible: vi.fn(() => true),
      acceptLeaseCompletion: vi.fn(() => true),
    };
    const service = new ProxyService(
      eligibility as never,
      {} as never,
      {} as never,
      {} as never,
      { markUpstreamSuccess } as never,
      {} as never,
    );
    const imageFrame = Buffer.from(
      'data: {"response":{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"AQ=="}}]},"finishReason":"STOP"}]}}\n\n',
    );
    const successfulStream = Readable.from([imageFrame]);
    const successfulPermit = { release: vi.fn() };

    await lastValueFrom(
      createResponsesStream(
        service,
        successfulStream,
        {
          accountId: 'acc-openai-image',
          model: 'gemini-3-pro-image',
        },
        successfulPermit,
      ).pipe(toArray()),
    );

    expect(markUpstreamSuccess).toHaveBeenCalledWith(
      'acc-openai-image',
      'gemini-3-pro-image',
      expect.any(Function),
    );
    expect(markUpstreamSuccess.mock.calls[0][2]()).toBe(true);
    expect(eligibility.acceptLeaseCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'acc-openai-image' }),
    );
    expect(successfulPermit.release).toHaveBeenCalled();

    markUpstreamSuccess.mockClear();
    const failedStream = Readable.from([
      imageFrame,
      Buffer.from('data: {"error":{"message":"generation failed"}}\n\n'),
    ]);
    const failedPermit = { release: vi.fn() };
    await lastValueFrom(
      createResponsesStream(
        service,
        failedStream,
        {
          accountId: 'acc-openai-image',
          model: 'gemini-3-pro-image',
        },
        failedPermit,
      ).pipe(toArray()),
    );

    expect(markUpstreamSuccess).not.toHaveBeenCalled();
    expect(failedPermit.release).toHaveBeenCalled();
  });

  it('releases an image permit when a Responses subscriber disconnects', () => {
    const service = new ProxyService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const upstreamStream = new PassThrough();
    const permit = { release: vi.fn() };
    const subscription = createResponsesStream(
      service,
      upstreamStream,
      { accountId: 'acc-openai-image', model: 'gemini-3-pro-image' },
      permit,
    ).subscribe();

    subscription.unsubscribe();

    expect(permit.release).toHaveBeenCalledTimes(1);
    expect(upstreamStream.destroyed).toBe(true);
  });
});
