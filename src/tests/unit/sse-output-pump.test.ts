import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SseOutputPump,
  getSseOutputRetainedBytes,
} from '@/server/gateway/common/sse-output-pump';

describe('SSE output retention and drain', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    expect(getSseOutputRetainedBytes()).toBe(0);
  });

  it('segments a large Unicode event and waits for the final drain before completing', () => {
    const parts: string[] = [];
    const pause = vi.fn(),
      resume = vi.fn(),
      finish = vi.fn(),
      fail = vi.fn();
    let blocked = true;
    const pump = new SseOutputPump({
      write: (text) => {
        parts.push(text);
        return !blocked;
      },
      pause,
      resume,
      finish,
      fail,
    });
    const event = 'x'.repeat(16383) + '😀世界' + 'y'.repeat(32 * 1024 * 1024);
    pump.enqueue(event);
    pump.end();
    expect(pause).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
    expect(getSseOutputRetainedBytes()).toBeGreaterThan(0);
    blocked = false;
    pump.drain();
    expect(parts.join('')).toBe(event);
    expect(parts.every((part) => !part.endsWith('\ud83d'))).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
  });

  it('accounts aggregate retention and rejects excess without losing another stream', () => {
    const active: SseOutputPump[] = [];
    const failures: Error[] = [];
    const text = 'x'.repeat(32 * 1024 * 1024);
    for (let index = 0; index < 4; index++) {
      const pump = new SseOutputPump({
        write: () => false,
        pause: () => {},
        resume: () => {},
        finish: () => {},
        fail: (error) => failures.push(error),
      });
      active.push(pump);
      pump.enqueue(text);
    }
    expect(failures.map((error) => error.message)).toEqual(['SSE retained output budget exceeded']);
    expect(getSseOutputRetainedBytes()).toBeLessThanOrEqual(256 * 1024 * 1024);
    active[0].stop();
    expect(getSseOutputRetainedBytes()).toBeGreaterThan(0);
    active.forEach((pump) => pump.stop());
  });

  it('times out a stalled downstream and releases all retained frames', async () => {
    const failure = vi.fn();
    const pump = new SseOutputPump({
      write: () => false,
      pause: () => {},
      resume: () => {},
      finish: () => {},
      fail: failure,
    });
    pump.enqueue('data: stalled\n\n');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'SSE downstream drain timed out' }),
    );
    expect(getSseOutputRetainedBytes()).toBe(0);
    pump.drain();
    pump.stop();
  });
});
