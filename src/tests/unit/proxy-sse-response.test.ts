import type { FastifyReply, FastifyRequest } from 'fastify';
import { EMPTY, Subject, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  capture: vi.fn(),
  complete: vi.fn(),
  markFirstByte: vi.fn(),
}));

vi.mock('@/modules/proxy-gateway/audit/traffic-audit-context', () => ({
  captureHijackedHttpResponseChunk: mocks.capture,
  completeHijackedHttpResponse: mocks.complete,
  getProxyResponseTimingContext: () => ({ proxyTiming: {} }),
}));
vi.mock('@/modules/proxy-gateway/server/common/proxy-response-timing', () => ({
  buildProxyResponseTimingHeaders: () => ({
    'X-Test-TTFT': mocks.events.includes('first-byte') ? 'ready' : 'missing',
  }),
  markProxyUpstreamFirstByte: mocks.markFirstByte,
  setProxyResponseTimingHeaders: vi.fn(),
}));

import { writeProxySseResponse } from '@/modules/proxy-gateway/server/common/proxy-sse-response';

function createReply() {
  let onClose: (() => void) | undefined;
  const request = {} as FastifyRequest;
  const raw = {
    writableEnded: false,
    writableFinished: false,
    writeHead: vi.fn((_status: number, _headers: Record<string, string>) => {
      mocks.events.push('headers');
    }),
    write: vi.fn((_chunk: string) => {
      mocks.events.push('write');
    }),
    end: vi.fn(() => {
      mocks.events.push('end');
      raw.writableEnded = true;
      raw.writableFinished = true;
    }),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'close') {
        onClose = listener;
      }
      return raw;
    }),
  };
  const reply = {
    raw,
    request,
    hijack: vi.fn(),
    header: vi.fn(),
    send: vi.fn(),
  } as unknown as FastifyReply;
  return { reply, request, raw, close: () => onClose?.() };
}

describe('proxy SSE response writer', () => {
  beforeEach(() => {
    mocks.events.length = 0;
    mocks.capture.mockReset();
    mocks.complete.mockReset();
    mocks.markFirstByte.mockReset();
    mocks.markFirstByte.mockImplementation(() => mocks.events.push('first-byte'));
  });

  it('writes timed headers after the first byte and only once', () => {
    const stream = new Subject<string>();
    const { reply, request, raw } = createReply();

    writeProxySseResponse(reply, stream, { includeTiming: true, request });
    expect(raw.writeHead).not.toHaveBeenCalled();

    stream.next('data: first\n\n');
    stream.next('data: second\n\n');
    stream.complete();

    expect(mocks.events).toEqual(['first-byte', 'headers', 'write', 'first-byte', 'write', 'end']);
    expect(raw.writeHead).toHaveBeenCalledOnce();
    expect(raw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'X-Test-TTFT': 'ready' }),
    );
    expect(mocks.capture.mock.calls).toEqual([
      [request, 'data: first\n\n'],
      [request, 'data: second\n\n'],
    ]);
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it('writes untimed headers immediately and finishes an empty stream once', () => {
    const { reply, raw } = createReply();

    writeProxySseResponse(reply, EMPTY);

    expect(raw.writeHead).toHaveBeenCalledOnce();
    expect(raw.write).not.toHaveBeenCalled();
    expect(raw.end).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it('writes timed headers once for an error before any chunk', () => {
    const { reply, request, raw } = createReply();
    const error = new Error('upstream failed');

    writeProxySseResponse(
      reply,
      throwError(() => error),
      { includeTiming: true, request },
    );

    expect(raw.writeHead).toHaveBeenCalledOnce();
    expect(raw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'X-Test-TTFT': 'missing' }),
    );
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.capture.mock.calls[0]?.[1]).toContain('upstream failed');
    expect(mocks.complete).toHaveBeenCalledWith(request, reply, { error, partial: true });
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it('records a partial response when the client closes before completion', () => {
    const stream = new Subject<string>();
    const { reply, request, close } = createReply();

    writeProxySseResponse(reply, stream, { includeTiming: true, request });
    close();

    expect(mocks.complete).toHaveBeenCalledWith(request, reply, { partial: true });
    expect(stream.observed).toBe(false);
  });
});
