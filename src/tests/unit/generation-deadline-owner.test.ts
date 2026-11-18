import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { Observable } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admitUpstreamGenerationSend,
  runGenerationWithDeadline,
  generationAttemptTimeout,
  GenerationDeadlineScope,
} from '@/server/gateway/common/generation-deadline';
import { FlowControlledSseStream } from '@/server/gateway/common/flow-controlled-sse-stream';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Logical generation deadline ownership', () => {
  it('shares admitted sends with nested recovery and only limits large current bodies', async () => {
    const threshold = 4 * 1024 * 1024;
    await runGenerationWithDeadline(1000, undefined, async (signal) => {
      admitUpstreamGenerationSend(signal, threshold - 1);
      admitUpstreamGenerationSend(signal, threshold - 1);
      await runGenerationWithDeadline(1000, signal, async (retrySignal) => {
        admitUpstreamGenerationSend(retrySignal, threshold);
        expect(() => admitUpstreamGenerationSend(retrySignal, threshold)).toThrow(
          'The generation replay limit for large upstream requests was reached.',
        );
        expect(() => admitUpstreamGenerationSend(retrySignal, threshold - 1)).not.toThrow();
      });
    });
    await runGenerationWithDeadline(1000, undefined, async (signal) => {
      expect(() => admitUpstreamGenerationSend(signal, threshold)).not.toThrow();
    });
  });

  it('does not round the transport timeout ahead of the owning deadline', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const owner = new GenerationDeadlineScope(1000);
    try {
      now.mockReturnValue(1000.25);
      expect(generationAttemptTimeout(owner.signal, 5000)).toBe(1000);
    } finally {
      owner.dispose();
    }
  });
  it('destroys late output from a nested generation waiter', async () => {
    const late = new PassThrough();
    let release: (value: PassThrough) => void = () => undefined;
    const pending = new Promise<PassThrough>((resolve) => {
      release = resolve;
    });
    const result = runGenerationWithDeadline(1000, undefined, (signal) =>
      runGenerationWithDeadline(60_000, signal, () => pending),
    );
    const expired = expect(result).rejects.toMatchObject({
      name: 'GenerationDeadlineExceededError',
    });
    await vi.advanceTimersByTimeAsync(1001);
    await expired;
    release(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('destroys a late direct stream result after its deadline waiter has ended', async () => {
    let resolve: (value: PassThrough) => void = () => undefined;
    const pending = new Promise<PassThrough>((done) => {
      resolve = done;
    });
    const late = new PassThrough();
    const result = runGenerationWithDeadline(1000, undefined, async (_signal, owner) => {
      const stream = await pending;
      return owner ? owner.retainReadable(stream) : stream;
    });
    const failure = expect(result).rejects.toMatchObject({
      name: 'GenerationDeadlineExceededError',
    });
    await vi.advanceTimersByTimeAsync(1001);
    await failure;
    resolve(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves flow control while a paused stream spends the business deadline', async () => {
    const parent = new AbortController();
    const added = vi.spyOn(parent.signal, 'addEventListener');
    const removed = vi.spyOn(parent.signal, 'removeEventListener');
    const upstream = new PassThrough();
    let teardown = 0;
    const source = new FlowControlledSseStream(upstream, () => () => {
      teardown += 1;
    });
    const result = await runGenerationWithDeadline(1000, parent.signal, async (_signal, owner) =>
      owner ? owner.retainObservable(source) : source,
    );
    expect(result).toBeInstanceOf(FlowControlledSseStream);
    if (!(result instanceof FlowControlledSseStream)) {
      throw new Error('Flow control must remain visible to the HTTP writer');
    }
    const errors: unknown[] = [];
    result.subscribe({ error: (error: unknown) => errors.push(error) });
    result.pause();
    expect(upstream.isPaused()).toBe(true);

    await vi.advanceTimersByTimeAsync(1001);

    expect(errors).toMatchObject([{ name: 'GenerationDeadlineExceededError', code: 'ETIMEDOUT' }]);
    expect(teardown).toBe(1);
    expect(upstream.destroyed).toBe(true);
    expect(new Set(removed.mock.calls.map((call) => call[1]))).toEqual(
      new Set(added.mock.calls.map((call) => call[1])),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases the timer and parent listener at unary and synchronous stream success', async () => {
    const parent = new AbortController();
    const added = vi.spyOn(parent.signal, 'addEventListener');
    const removed = vi.spyOn(parent.signal, 'removeEventListener');
    expect(
      await runGenerationWithDeadline(1000, parent.signal, async () => ({ done: true })),
    ).toEqual({ done: true });
    const source = new Observable<string>((subscriber) => {
      subscriber.next('done');
      subscriber.complete();
    });
    const result = await runGenerationWithDeadline(1000, parent.signal, async (_signal, owner) =>
      owner ? owner.retainObservable(source) : source,
    );
    const output: string[] = [];
    result.subscribe((chunk) => output.push(chunk));
    expect(output).toEqual(['done']);
    expect(vi.getTimerCount()).toBe(0);
    expect(new Set(removed.mock.calls.map((call) => call[1]))).toEqual(
      new Set(added.mock.calls.map((call) => call[1])),
    );
  });

  it('reuses an existing owner and cannot reset its budget through nesting', async () => {
    await runGenerationWithDeadline(1000, undefined, async (signal) => {
      await runGenerationWithDeadline(60_000, signal, async (nested, owner) => {
        expect(nested).toBe(signal);
        expect(owner).toBeNull();
        expect(generationAttemptTimeout(nested, 60_000)).toBeLessThanOrEqual(1000);
      });
      expect(vi.getTimerCount()).toBe(1);
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposes an unconsumed stream when the caller disconnects', async () => {
    const parent = new AbortController();
    const added = vi.spyOn(parent.signal, 'addEventListener');
    const removed = vi.spyOn(parent.signal, 'removeEventListener');
    const upstream = new PassThrough();
    const source = new FlowControlledSseStream(upstream, () => undefined);
    await runGenerationWithDeadline(1000, parent.signal, async (_signal, owner) =>
      owner ? owner.retainObservable(source) : source,
    );
    parent.abort();
    expect(upstream.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(new Set(removed.mock.calls.map((call) => call[1]))).toEqual(
      new Set(added.mock.calls.map((call) => call[1])),
    );
  });

  it('keeps client cancellation distinct from a business timeout', async () => {
    const parent = new AbortController();
    let finish: () => void = () => undefined;
    const request = runGenerationWithDeadline(
      1000,
      parent.signal,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const observed = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    parent.abort();
    await observed;
    finish();
    expect(vi.getTimerCount()).toBe(0);
  });
});
