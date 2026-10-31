import { describe, expect, it } from 'vitest';
import { runBounded } from '@/modules/proxy-gateway/playground/bounded-pool';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('runBounded', () => {
  it('never exceeds the in-flight limit', async () => {
    let active = 0;
    let peak = 0;
    const results = await runBounded([1, 2, 3, 4, 5, 6, 7], 3, undefined, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return item * 2;
    });

    expect(peak).toBe(3);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });

  it('stops starting new work on abort and keeps completed results', async () => {
    const controller = new AbortController();
    const completed: number[] = [];
    const gate = deferred<void>();

    const run = runBounded(
      [0, 1, 2, 3],
      1,
      controller.signal,
      async (item) => {
        if (item === 1) {
          await gate.promise;
        }
        return item;
      },
      (index) => completed.push(index),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    gate.resolve();
    const results = await run;

    expect(completed).toEqual([0, 1]);
    expect(results).toEqual([0, 1, undefined, undefined]);
  });

  it('keeps finished results and rethrows the first worker failure', async () => {
    const failure = new Error('worker failed');
    await expect(
      runBounded([1, 2, 3], 1, undefined, async (item) => {
        if (item === 2) {
          throw failure;
        }
        return item;
      }),
    ).rejects.toBe(failure);
  });

  it('does not report an abort rejection as a worker failure', async () => {
    const controller = new AbortController();
    controller.abort();
    const results = await runBounded([1, 2], 2, controller.signal, async () => {
      throw new Error('should not run');
    });

    expect(results).toEqual([undefined, undefined]);
  });

  it('returns an empty result for an empty input', async () => {
    await expect(runBounded([], 4, undefined, async () => 1)).resolves.toEqual([]);
  });
});
