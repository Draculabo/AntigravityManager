import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { EMPTY, Observable, Subject, throwError } from 'rxjs';
import { PassThrough } from 'node:stream';
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
vi.mock('@/server/gateway/common/proxy-response-timing', () => ({
  buildProxyResponseTimingHeaders: () => ({
    'X-Test-TTFT': mocks.events.includes('first-byte') ? 'ready' : 'missing',
  }),
  markProxyUpstreamFirstByte: mocks.markFirstByte,
  setProxyResponseTimingHeaders: vi.fn(),
}));

import { writeProxySseResponse } from '@/server/gateway/common/proxy-sse-response';
import { registerObservableFlowControl } from '@/server/gateway/common/observable-flow-control';
import { FlowControlledSseStream } from '@/server/gateway/common/flow-controlled-sse-stream';

function createReply() {
  let onClose: (() => void) | undefined;
  let onDrain: (() => void) | undefined;
  const request = {} as FastifyRequest;
  const raw = {
    writableLength: 0,
    destroyed: false,
    destroy: vi.fn(() => {
      raw.destroyed = true;
      onClose?.();
      return raw;
    }),
    writableEnded: false,
    writableFinished: false,
    writeHead: vi.fn((_status: number, _headers: Record<string, string>) => {
      mocks.events.push('headers');
    }),
    write: vi.fn((_chunk: string | Buffer) => {
      mocks.events.push('write');
      return true;
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
      if (event === 'drain') {
        onDrain = listener;
      }
      return raw;
    }),
    removeListener: vi.fn(),
  };
  const reply = {
    raw,
    request,
    hijack: vi.fn(),
    header: vi.fn(),
    send: vi.fn(),
  } as unknown as FastifyReply;
  return { reply, request, raw, close: () => onClose?.(), drain: () => onDrain?.() };
}

describe('proxy SSE response writer', () => {
  it.each([false, true])(
    'sanitizes a terminal exception and retains its diagnostic cause (flow=%s)',
    (flow) => {
      const subject = new Subject<string>();
      const source = new PassThrough();
      const stream = flow
        ? new FlowControlledSseStream(source, (subscriber) => subject.subscribe(subscriber))
        : subject;
      const { reply, request, raw } = createReply();
      const error = new Error('Tool read_file failed: token=synthetic-writer-secret');
      writeProxySseResponse(reply, stream);
      subject.next('data: earlier\n\n');
      subject.error(error);
      const output = raw.write.mock.calls.map(([chunk]) => chunk.toString()).join('');
      expect(output).toBe(
        'data: earlier\n\ndata: {"error":{"message":"Tool read_file failed: token=[REDACTED]","type":"server_error"}}\n\n',
      );
      expect(raw.writeHead).toHaveBeenCalledOnce();
      expect(raw.end).toHaveBeenCalledOnce();
      expect(mocks.complete).toHaveBeenCalledWith(request, reply, { error, partial: true });
      expect(error.message).toBe('Tool read_file failed: token=synthetic-writer-secret');
      source.destroy();
    },
  );

  it('drains queued output and its error frame in order while retaining partial completion', () => {
    const source = new PassThrough();
    const subject = new Subject<string>();
    const stream = new FlowControlledSseStream(source, (subscriber) =>
      subject.subscribe(subscriber),
    );
    const { reply, request, raw, drain } = createReply();
    raw.write.mockReturnValue(false);
    writeProxySseResponse(reply, stream);
    subject.next('data: earlier\n\n');
    subject.error(undefined);
    expect(raw.end).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    raw.write.mockReturnValue(true);
    drain();
    const output = raw.write.mock.calls.map(([chunk]) => chunk.toString()).join('');
    expect(output).toBe(
      'data: earlier\n\ndata: {"error":{"message":"undefined","type":"server_error"}}\n\n',
    );
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(request, reply, {
      error: undefined,
      partial: true,
    });
    expect(raw.end).toHaveBeenCalledOnce();
    source.destroy();
  });
  it('keeps writing a long stream when the socket drains between events', () => {
    const { reply, raw } = createReply();
    const source = new Subject<string>();
    writeProxySseResponse(reply, source);
    for (let index = 0; index < 1000; index++) {
      raw.writableLength = 0;
      source.next('data: ' + 'x'.repeat(64 * 1024) + '\n\n');
    }
    source.complete();
    expect(raw.write).toHaveBeenCalledTimes(1000);
    expect(raw.destroy).not.toHaveBeenCalled();
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it('does not append an error frame to an already full socket', () => {
    const { reply, raw } = createReply();
    raw.writableLength = 16 * 1024 * 1024;
    writeProxySseResponse(
      reply,
      throwError(() => new Error('synthetic error')),
    );
    expect(raw.write).not.toHaveBeenCalled();
    expect(raw.destroy).toHaveBeenCalledOnce();
    expect(raw.end).not.toHaveBeenCalled();
  });
  it('bounds a synchronous producer when the downstream never drains', () => {
    const { reply, raw } = createReply();
    raw.write.mockImplementation((chunk) => {
      raw.writableLength += Buffer.byteLength(chunk);
      return false;
    });
    let emitted = 0,
      teardown = false;
    const source = new Observable<string>((subscriber) => {
      for (let index = 0; index < 1000 && !subscriber.closed; index++) {
        emitted++;
        subscriber.next('data: ' + 'x'.repeat(64 * 1024) + '\n\n');
      }
      return () => {
        teardown = true;
      };
    });
    writeProxySseResponse(reply, source);
    expect(raw.writableLength).toBeLessThanOrEqual(17 * 1024 * 1024);
    expect(emitted).toBeLessThan(1000);
    expect(raw.destroy).toHaveBeenCalledOnce();
    expect(teardown).toBe(true);
    expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), reply, {
      error: expect.objectContaining({ message: expect.stringContaining('backpressure') }),
      partial: true,
    });
  });
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

  it('pauses the owned upstream on backpressure and resumes after drain', () => {
    const stream = new Subject<string>();
    const pause = vi.fn();
    const resume = vi.fn();
    const raw = new EventEmitter() as EventEmitter & {
      writableEnded: boolean;
      writableFinished: boolean;
      writableNeedDrain: boolean;
      writeHead: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    raw.writableEnded = false;
    raw.writableFinished = false;
    raw.writableNeedDrain = false;
    raw.writeHead = vi.fn();
    raw.write = vi.fn(() => {
      raw.writableNeedDrain = true;
      return false;
    });
    raw.end = vi.fn();
    const reply = {
      raw,
      request: {} as FastifyRequest,
      hijack: vi.fn(),
      header: vi.fn(),
      send: vi.fn(),
    } as unknown as FastifyReply;
    registerObservableFlowControl(stream, { pause, resume });

    writeProxySseResponse(reply, stream);
    stream.next('data: blocked\n\n');
    expect(pause).toHaveBeenCalledOnce();

    raw.writableNeedDrain = false;
    raw.emit('drain');
    expect(resume).toHaveBeenCalledOnce();
    raw.emit('close');
  });
});
