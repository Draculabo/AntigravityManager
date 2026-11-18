import { WebSocket } from 'ws';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { ResponsesWebSocketOutput } from '@/server/gateway/modules/openai/responses/responses-websocket-output';
import { FlowControlledSseStream } from '@/server/gateway/common/flow-controlled-sse-stream';
import {
  SseOutputPump,
  getSseOutputRetainedBytes,
} from '@/server/gateway/common/sse-output-pump';

function harness() {
  const flow = new FlowControlledSseStream({ pause: vi.fn(), resume: vi.fn() }, () => {});
  const send = vi.fn(
    (_data: Buffer, _options: { binary: boolean }, _done: (error?: Error) => void) => {},
  );
  const socket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
  const fail = vi.fn();
  return { flow, send, fail, output: new ResponsesWebSocketOutput(socket, flow, fail) };
}

afterEach(() => {
  vi.useRealTimers();
  expect(getSseOutputRetainedBytes()).toBe(0);
});

describe('Responses WebSocket output ownership', () => {
  it('encodes canonical JSON once and shares the queued Buffer with the sender', () => {
    const { send, output } = harness();
    const first = '{"type":"response.output_text.delta","delta":"first 😀"}';
    const second = '{"type":"response.output_text.delta","delta":"second 😀"}';
    const from = vi.spyOn(Buffer, 'from');
    try {
      output.enqueueSerialized(first);
      output.enqueueSerialized(second);
      const payloads = from.mock.results.map((result) => result.value);
      expect(from.mock.calls).toEqual([
        [first, 'utf8'],
        [second, 'utf8'],
      ]);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][0]).toBe(payloads[0]);
      from.mockRestore();
      send.mock.calls[0][2]();
      expect(send.mock.calls[1][0]).toBe(payloads[1]);
      send.mock.calls[1][2]();
    } finally {
      from.mockRestore();
      output.stop();
    }
  });

  it('preserves whole JSON messages and waits for send completion before finishing', () => {
    const { flow, send, fail, output } = harness();
    const finish = vi.fn();
    const event = { type: 'response.output_text.delta', delta: '😀世界' };
    output.enqueue(event);
    output.end(finish);
    expect(flow.isPaused).toBe(true);
    expect(send.mock.calls[0][0].toString()).toBe(JSON.stringify(event));
    expect(send.mock.calls[0][1]).toEqual({ binary: false });
    expect(finish).not.toHaveBeenCalled();
    send.mock.calls[0][2]();
    expect(finish).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
  });

  it('releases send reservations on timeout and ignores a late acknowledgement', () => {
    vi.useFakeTimers();
    const { send, fail, output } = harness();
    output.enqueue({ type: 'response.output_text.delta', delta: 'stalled' });
    expect(getSseOutputRetainedBytes()).toBeGreaterThan(0);
    vi.advanceTimersByTime(30_000);
    expect(fail).toHaveBeenCalledWith(new Error('Responses WebSocket send timed out'));
    expect(getSseOutputRetainedBytes()).toBe(0);
    send.mock.calls[0][2]();
    expect(getSseOutputRetainedBytes()).toBe(0);
  });

  it('uses one global budget with HTTP SSE and rejects only the overflowing output', () => {
    const a = harness();
    const b = harness();
    const pump = new SseOutputPump({
      write: () => false,
      pause: () => {},
      resume: () => {},
      finish: () => {},
      fail: vi.fn(),
    });
    try {
      pump.enqueue('x'.repeat(32 * 1024 * 1024));
      a.output.enqueue({ type: 'response.output_text.delta', delta: 'x'.repeat(32 * 1024 * 1024) });
      const prior = getSseOutputRetainedBytes();
      b.output.enqueue({ type: 'response.output_text.delta', delta: 'x'.repeat(32 * 1024 * 1024) });
      expect(b.fail).toHaveBeenCalledWith(new Error('Responses WebSocket output budget exceeded'));
      expect(a.fail).not.toHaveBeenCalled();
      expect(getSseOutputRetainedBytes()).toBe(prior);
    } finally {
      pump.stop();
      a.output.stop();
      b.output.stop();
    }
  });
});
