/**
 * Runs `worker` over `items` with a hard in-flight limit.
 *
 * Workers receive the shared abort signal. When it fires, no new items are
 * started, in-flight work is allowed to settle, and unfilled result slots stay
 * `undefined` so callers can retain completed work. A worker rejection stops the
 * pool and is rethrown after the remaining in-flight work settles.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal | undefined,
  worker: (item: T, index: number) => Promise<R>,
  onResult?: (index: number, value: R) => void,
): Promise<Array<R | undefined>> {
  const results = new Array<R | undefined>(items.length);
  if (items.length === 0) {
    return results;
  }

  const concurrency = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let nextIndex = 0;
  let stopped = signal?.aborted === true;
  let firstError: unknown;

  const run = async (): Promise<void> => {
    while (!stopped) {
      if (signal?.aborted) {
        stopped = true;
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      try {
        const value = await worker(items[index], index);
        results[index] = value;
        onResult?.(index, value);
      } catch (error) {
        stopped = true;
        if (!signal?.aborted) {
          firstError ??= error;
        }
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => run()));
  if (firstError !== undefined) {
    throw firstError;
  }
  return results;
}
