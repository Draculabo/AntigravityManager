import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { lastValueFrom, Observable, toArray } from 'rxjs';

import { parseInternalSseChunk } from '@/modules/proxy-gateway/antigravity/internal-sse';
import { ProxyService } from '@/modules/proxy-gateway/server/proxy.service';

describe('parseInternalSseChunk', () => {
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

    const result = parseInternalSseChunk(raw);

    expect(result).not.toBeNull();
    expect(result?.candidates).toEqual([{ content: { role: 'model', parts: [{ text: 'PONG' }] } }]);
    expect(result?.usageMetadata).toEqual({ promptTokenCount: 9, candidatesTokenCount: 2 });
    expect(result?.modelVersion).toBe('gemini-3-flash');
    expect(result?.responseId).toBe('xmJrapmCPdC5vdIP1t_bwA8');
  });

  it('returns an already-bare chunk unchanged', () => {
    const bare = {
      candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 1 },
      modelVersion: 'gemini-3-pro',
      responseId: 'resp_1',
    };

    const result = parseInternalSseChunk(JSON.stringify(bare));

    expect(result).toEqual(bare);
  });

  it('does not double-unwrap a payload carrying both response and a top-level candidates', () => {
    const raw = JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'top-level' }] } }],
      response: {
        candidates: [{ content: { role: 'model', parts: [{ text: 'nested' }] } }],
      },
    });

    const result = parseInternalSseChunk(raw);

    expect(result?.candidates).toEqual([
      { content: { role: 'model', parts: [{ text: 'top-level' }] } },
    ]);
  });

  it('is total: malformed JSON, [DONE], and empty strings never throw', () => {
    expect(() => parseInternalSseChunk('not json')).not.toThrow();
    expect(parseInternalSseChunk('not json')).toBeNull();

    expect(() => parseInternalSseChunk('[DONE]')).not.toThrow();
    expect(parseInternalSseChunk('[DONE]')).toBeNull();

    expect(() => parseInternalSseChunk('')).not.toThrow();
    expect(parseInternalSseChunk('')).toBeNull();

    expect(() => parseInternalSseChunk('   ')).not.toThrow();
    expect(parseInternalSseChunk('   ')).toBeNull();

    expect(() => parseInternalSseChunk('42')).not.toThrow();
    expect(parseInternalSseChunk('42')).toBeNull();

    expect(() => parseInternalSseChunk('[1,2,3]')).not.toThrow();
    expect(parseInternalSseChunk('[1,2,3]')).toBeNull();
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
    const service = new ProxyService({} as never, {} as never);
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
      message: expect.objectContaining({ id: 'resp_wrapped', model: 'gemini-3-flash' }),
    });
  });

  it('still routes undecodable payloads through the parse-error recovery', async () => {
    const service = new ProxyService({} as never, {} as never);
    const upstreamStream = Readable.from(
      Array.from({ length: 5 }, () => Buffer.from('data: {"response":\n\n')),
    );

    const serializedEvents = await lastValueFrom(
      createAnthropicStream(service, upstreamStream).pipe(toArray()),
    );
    const events = serializedEvents.map((event) => parseEvent(String(event)));

    // StreamingState only emits this once its consecutive-error counter passes
    // its threshold, so seeing it proves handleParseError still runs for
    // payloads the helper resolves to null instead of throwing on.
    const errorEvent = events.find((event) => event.type === 'error');
    expect(errorEvent).toMatchObject({
      error: expect.objectContaining({ code: 'stream_decode_error' }),
    });
  });

  it('emits a message_delta for a wrapped finishReason-only chunk', async () => {
    const service = new ProxyService({} as never, {} as never);
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
