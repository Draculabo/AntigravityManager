import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ThoughtHydrationQueue,
  ThoughtHydrationAdmissionError,
} from '@/modules/proxy-gateway/thought-store/thought-hydration-queue';
import type { ThoughtRecord } from '@/modules/proxy-gateway/thought-store/thought-store.types';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('cold hydration admission', () => {
  it('removes aborted waiting work and keeps an executing read occupying its slot until settlement', async () => {
    const queue = new ThoughtHydrationQueue();
    let finish!: (records: ThoughtRecord[]) => void;
    const activeController = new AbortController();
    const first = queue.run(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      activeController.signal,
    );
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const waitingController = new AbortController();
    const abandoned = vi.fn(async () => []);
    const waiting = queue.run(abandoned, waitingController.signal);
    const waitingCancelled = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    waitingController.abort();
    activeController.abort();
    await Promise.all([cancelled, waitingCancelled]);
    const next = vi.fn(async () => []);
    const pending = queue.run(next);
    await vi.advanceTimersByTimeAsync(0);
    expect(next).not.toHaveBeenCalled();
    finish([]);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(next).toHaveBeenCalledOnce();
    expect(abandoned).not.toHaveBeenCalled();
  });
  it('checks the deadline before issuing a load even if the timer callback was delayed', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const queue = new ThoughtHydrationQueue();
      let finish!: (records: ThoughtRecord[]) => void;
      const first = queue.run(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const load = vi.fn(async () => []);
      const waiting = queue.run(load);
      const outcome = waiting.then(
        () => 'executed',
        (error: unknown) => {
          if (error instanceof ThoughtHydrationAdmissionError) {
            return error.reason;
          }
          throw error;
        },
      );
      clock.mockReturnValue(6_000);
      finish([]);
      await first;
      const fresh = queue.run(async () => []);
      await vi.advanceTimersByTimeAsync(0);
      await fresh;
      expect(await outcome).toBe('timeout');
      expect(load).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it('issues one load and yields before starting the next queued load in order', async () => {
    const queue = new ThoughtHydrationQueue();
    let finish!: (records: ThoughtRecord[]) => void;
    const calls: string[] = [];
    const first = queue.run(() => {
      calls.push('first');
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const second = queue.run(async () => {
      calls.push('second');
      return [];
    });
    expect(calls).toEqual(['first']);
    finish([]);
    await first;
    expect(calls).toEqual(['first']);
    await vi.advanceTimersByTimeAsync(0);
    await second;
    expect(calls).toEqual(['first', 'second']);
  });

  it('removes expired waiting loads without executing or retrying them', async () => {
    const queue = new ThoughtHydrationQueue();
    let finish!: (records: ThoughtRecord[]) => void;
    const first = queue.run(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const load = vi.fn(async () => []);
    const waiting = queue.run(load);
    const failure = expect(waiting).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(5_000);
    await failure;
    finish([]);
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(load).not.toHaveBeenCalled();
    expect(await queue.run(load)).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('bounds a burst, releases unissued closures on pause, and resumes fresh work', async () => {
    const queue = new ThoughtHydrationQueue();
    let finish!: (records: ThoughtRecord[]) => void;
    const first = queue.run(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const load = vi.fn(async () => []);
    const outcomes = Promise.allSettled(Array.from({ length: 100 }, () => queue.run(load)));
    queue.pause();
    finish([]);
    await first;
    const results = await outcomes;
    const reasons = results.map((result) => {
      expect(result.status).toBe('rejected');
      if (
        result.status !== 'rejected' ||
        !(result.reason instanceof ThoughtHydrationAdmissionError)
      ) {
        throw new Error('Expected a typed admission failure');
      }
      return result.reason.reason;
    });
    expect(reasons).toContain('capacity');
    expect(reasons).toContain('closed');
    expect(load).not.toHaveBeenCalled();
    queue.resume();
    expect(await queue.run(load)).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reports an executing load failure once and continues other queued work', async () => {
    const queue = new ThoughtHydrationQueue();
    const error = new Error('synthetic decode failure');
    const failed = vi.fn().mockRejectedValue(error);
    const successful = vi.fn(async () => []);
    const first = queue.run(failed);
    const second = queue.run(successful);
    await expect(first).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(await second).toEqual([]);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(successful).toHaveBeenCalledTimes(1);
  });
});
