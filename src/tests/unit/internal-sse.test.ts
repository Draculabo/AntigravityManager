import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { lastValueFrom, Observable, toArray } from 'rxjs';

import { decodeInternalSseData } from '@/modules/proxy-gateway/antigravity/internal-sse';
import { AnthropicService as ProxyService } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.service';

describe('decodeInternalSseData', () => {
  it('unwraps a v1internal-wrapped chunk so candidates/usage/model/id are reachable at the top level', () => {
    const raw = JSON.stringify({
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'PONG' }] } }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
        modelVersion: 'gemini-3-flash',
        responseId: 'xmJrapmCPdC5vdIP1t_bwA8',
      },
      traceId: 'e75ed3b3774f95a3',
      metadata: {},
    });

    const result = decodeInternalSseData(raw);

    expect(result).toEqual({
      kind: 'response',
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'PONG' }] } }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
        modelVersion: 'gemini-3-flash',
        responseId: 'xmJrapmCPdC5vdIP1t_bwA8',
      },
    });
  });

  it('returns an already-bare chunk unchanged', () => {
    const bare = {
      candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 1 },
      modelVersion: 'gemini-3-pro',
      responseId: 'resp_1',
    };

    const result = decodeInternalSseData(JSON.stringify(bare));

    expect(result).toEqual({ kind: 'response', response: bare });
  });

  it('does not double-unwrap a payload carrying both response and a top-level candidates', () => {
    const payload = {
      candidates: [{ content: { role: 'model', parts: [{ text: 'top-level' }] } }],
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'nested' }] } }],
      },
    };

    const result = decodeInternalSseData(JSON.stringify(payload));

    expect(result).toEqual({ kind: 'response', response: payload });
  });

  it('keeps valid response metadata when a chunk has no candidates', () => {
    const payload = {
      usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 },
      modelVersion: 'gemini-3-flash',
      responseId: 'metadata-only',
    };

    expect(decodeInternalSseData(JSON.stringify(payload))).toEqual({
      kind: 'response',
      response: payload,
    });
  });

  it('ignores terminal markers and empty payloads', () => {
    expect(decodeInternalSseData('[DONE]')).toEqual({ kind: 'ignored' });
    expect(decodeInternalSseData('')).toEqual({ kind: 'ignored' });
    expect(decodeInternalSseData('   ')).toEqual({ kind: 'ignored' });
  });

  it('classifies malformed and non-object payloads as invalid without throwing', () => {
    expect(decodeInternalSseData('not json')).toEqual({ kind: 'invalid' });
    expect(decodeInternalSseData('null')).toEqual({ kind: 'invalid' });
    expect(decodeInternalSseData('42')).toEqual({ kind: 'invalid' });
    expect(decodeInternalSseData('[1,2,3]')).toEqual({ kind: 'invalid' });
  });
});

function parseEvent(serializedEvent: string): Record<string, unknown> {
  const dataLine = serializedEvent.split('\n').find((line) => line.startsWith('data: '));
  if (!dataLine) {
    throw new Error(`No data line found in event: ${serializedEvent}`);
  }
  return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
}

function createAnthropicStream(
  service: ProxyService,
  upstreamStream: NodeJS.ReadableStream,
): Observable<unknown> {
  const method: unknown = Reflect.get(service, 'processAnthropicInternalStream');
  if (typeof method !== 'function') {
    throw new Error('Anthropic stream processor is unavailable');
  }

  const result: unknown = Reflect.apply(method, service, [upstreamStream, 'gemini-3-pro']);
  if (!(result instanceof Observable)) {
    throw new Error('Anthropic stream processor did not return an Observable');
  }
  return result;
}

describe('ProxyService Anthropic streaming envelope handling', () => {
  it('unwraps a wrapped two-part chunk and does not drop the second part', async () => {
    const service = new ProxyService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const upstreamStream = Readable.from([
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"thoughtSignature":"c2ln","text":"first"},{"text":"second"}]}}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2},"modelVersion":"gemini-3-flash","responseId":"resp_wrapped"}}\n\n',
      ),
      Buffer.from('data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n'),
    ]);

    const serializedEvents = await lastValueFrom(
      createAnthropicStream(service, upstreamStream).pipe(toArray()),
    );
    const events = serializedEvents.map((event) => parseEvent(String(event)));

    const deltaEvents = events.filter((event) => event.type === 'content_block_delta');
    const texts = deltaEvents
      .map((event) => (event.delta as Record<string, unknown>)?.text)
      .filter((text): text is string => typeof text === 'string');

    expect(texts).toContain('first');
    expect(texts).toContain('second');

    const messageStart = events.find((event) => event.type === 'message_start');
    expect(messageStart).toMatchObject({
      message: expect.objectContaining({ id: 'msg_resp_wrapped', model: 'gemini-3-flash' }),
    });
  });

  it('still routes undecodable payloads through the parse-error recovery', async () => {
    const service = new ProxyService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const upstreamStream = Readable.from(
      Array.from({ length: 5 }, () => Buffer.from('data: {"response":\n\n')),
    );

    const serializedEvents = await lastValueFrom(
      createAnthropicStream(service, upstreamStream).pipe(toArray()),
    );
    const events = serializedEvents.map((event) => parseEvent(String(event)));

    // StreamingState only emits this once its consecutive-error counter passes
    // its threshold, so seeing it proves handleParseError still runs for
    // payloads the decoder classifies as invalid without throwing.
    const errorEvent = events.find((event) => event.type === 'error');
    expect(errorEvent).toMatchObject({
      error: expect.objectContaining({ code: 'stream_decode_error' }),
    });
  });

  it('emits a message_delta for a wrapped finishReason-only chunk', async () => {
    const service = new ProxyService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const upstreamStream = Readable.from([
      Buffer.from('data: {"response":{"candidates":[{"finishReason":"STOP"}]}}\n\n'),
    ]);

    const serializedEvents = await lastValueFrom(
      createAnthropicStream(service, upstreamStream).pipe(toArray()),
    );
    const events = serializedEvents.map((event) => parseEvent(String(event)));
    expect(events.some((event) => event.type === 'message_delta')).toBe(true);
  });
});
