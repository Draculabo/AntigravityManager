import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import {
  BoundedSqliteWorker,
  type SqliteWorkerFactory,
} from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';

function createWorker(ignoreShutdown = false) {
  const factory = vi.fn<SqliteWorkerFactory>(
    (_filename, options) =>
      new Worker(
        `
        const { parentPort } = require('node:worker_threads');
        parentPort.on('message', (message) => {
          if (message.payload === 'hang') {
            return;
          }
          if (message.operation === 'shutdown' && ${ignoreShutdown}) {
            return;
          }
          setTimeout(() => parentPort.postMessage({
            id: message.id, result: message.operation,
          }), 10);
        });
      `,
        { ...options, eval: true },
      ),
  );
  const owner = new BoundedSqliteWorker({
    databasePath: 'unused-test-database',
    maxPendingBytes: 100_000,
    maxPendingCommands: 20,
    name: 'shutdown-test',
    ownerStartedAt: 1234,
    workerFactory: factory,
    workerPath: 'test-only',
  });
  const nativeWorker = (): Worker => {
    const native = factory.mock.results[0]?.value;
    if (!(native instanceof Worker)) {
      throw new Error('Expected native test worker');
    }
    return native;
  };
  return { factory, nativeWorker, owner };
}

describe('SQLite worker terminal shutdown', () => {
  it('drains only the accepted snapshot while later unrelated work remains admitted', async () => {
    const { owner, factory } = createWorker();
    const old = owner.request({ operation: 'old', payload: null });
    expect(owner.tryWrite({ operation: 'old-write', payload: null }, { priority: 'model' })).toBe(
      true,
    );
    const drained = owner.drainAdmitted();
    const later = owner.request({ operation: 'later-hang', payload: 'hang' });
    const rejected = expect(later).rejects.toThrow();
    try {
      await drained;
      await old;
      expect(owner.getStats().pendingCommands).toBe(1);
      expect(factory).toHaveBeenCalledOnce();
    } finally {
      await expect(owner.close(30)).rejects.toThrow();
      await rejected;
    }
  });
  it('reports a bounded drain timeout without replacing or discarding the live owner', async () => {
    const { owner, factory } = createWorker();
    const pending = owner.request({ operation: 'old-hang', payload: 'hang' });
    const rejected = expect(pending).rejects.toThrow();
    try {
      await expect(owner.drainAdmitted(20)).rejects.toThrow('admitted drain timed out');
      expect(owner.getStats()).toMatchObject({ alive: true, pendingCommands: 1 });
      expect(factory).toHaveBeenCalledOnce();
    } finally {
      await expect(owner.close(30)).rejects.toThrow();
      await rejected;
    }
  });
  it('changes admission limits on the live owner while preserving accepted work and reservations', async () => {
    const { owner, factory } = createWorker();
    try {
      const read = owner.request({ operation: 'accepted-read', payload: null });
      let done!: () => void;
      const written = new Promise<void>((resolve) => {
        done = resolve;
      });
      expect(
        owner.tryWrite(
          { operation: 'accepted-write', payload: null },
          { priority: 'model', onSuccess: done },
        ),
      ).toBe(true);
      expect(owner.getStats().pendingCommands).toBe(2);
      owner.setQueueLimits({ maxPendingCommands: 1, maxPendingBytes: 100000 });
      expect(owner.getStats().pendingCommands).toBe(2);
      expect(owner.tryWrite({ operation: 'refused', payload: null }, { priority: 'model' })).toBe(
        false,
      );
      await Promise.all([read, written]);
      expect(await owner.request({ operation: 'after-drain', payload: null })).toBe('after-drain');
      owner.setQueueLimits({ maxPendingCommands: 20, maxPendingBytes: 128 });
      expect(
        owner.tryWrite(
          { operation: 'too-large', payload: 'x'.repeat(1000) },
          { priority: 'model' },
        ),
      ).toBe(false);
      owner.setQueueLimits({ maxPendingCommands: 20, maxPendingBytes: 100000 });
      expect(await owner.request({ operation: 'after-raise', payload: null })).toBe('after-raise');
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      await owner.close();
    }
  });
  it('drains accepted commands, rejects new admission and terminates once', async () => {
    const { factory, nativeWorker, owner } = createWorker();
    const read = owner.request({ operation: 'read', payload: null });
    const success = vi.fn();
    expect(owner.tryWrite({ operation: 'write', payload: null }, { onSuccess: success })).toBe(
      true,
    );
    const native = nativeWorker();
    const posted = vi.spyOn(native, 'postMessage');
    const terminate = vi.spyOn(native, 'terminate');

    const closing = owner.close();
    expect(owner.close()).toBe(closing);
    expect(owner.tryWrite({ operation: 'late-write', payload: null })).toBe(false);
    await expect(owner.request({ operation: 'late-read', payload: null })).rejects.toThrow(
      'shutdown-test closed',
    );
    await expect(read).resolves.toBe('read');
    await closing;

    expect(success).toHaveBeenCalledOnce();
    expect(posted.mock.calls).toEqual([
      [{ id: 2, operation: 'write', payload: null }],
      [{ id: 3, operation: 'shutdown', payload: null }],
    ]);
    expect(terminate).toHaveBeenCalledOnce();
    expect(owner.getStats()).toEqual({ alive: false, pendingBytes: 0, pendingCommands: 0 });
    expect(() => owner.start()).toThrow('shutdown-test closed');
    await owner.close();
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]?.[1].workerData).toEqual({
      databasePath: 'unused-test-database',
      ownerStartedAt: 1234,
    });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('bounds a missing shutdown acknowledgement and reports failure after termination', async () => {
    const { factory, nativeWorker, owner } = createWorker(true);
    await owner.request({ operation: 'ready', payload: null });
    const terminate = vi.spyOn(nativeWorker(), 'terminate');
    const closing = owner.close(30);

    await expect(closing).rejects.toThrow('shutdown-test shutdown failed');
    expect(terminate).toHaveBeenCalledOnce();
    expect(owner.getStats()).toEqual({ alive: false, pendingBytes: 0, pendingCommands: 0 });
    await expect(owner.close()).rejects.toThrow('shutdown-test shutdown failed');
    expect(terminate).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
  });

  it('terminates a stalled accepted read and settles it without reopening admission', async () => {
    const { factory, nativeWorker, owner } = createWorker();
    const read = owner.request({ operation: 'read', payload: 'hang' });
    const readOutcome = read.catch((error: unknown) => error);
    const terminate = vi.spyOn(nativeWorker(), 'terminate');

    await expect(owner.close(30)).rejects.toThrow('shutdown-test shutdown failed');
    expect(await readOutcome).toEqual(new Error('shutdown-test closed'));
    expect(terminate).toHaveBeenCalledOnce();
    expect(owner.getStats()).toEqual({ alive: false, pendingBytes: 0, pendingCommands: 0 });
    expect(factory).toHaveBeenCalledOnce();
  });

  it('clears pending requests and preserves a termination failure', async () => {
    const { nativeWorker, owner } = createWorker(true);
    await owner.request({ operation: 'ready', payload: null });
    const native = nativeWorker();
    const terminateNative = native.terminate.bind(native);
    const failure = new Error('termination failed');
    vi.spyOn(native, 'terminate').mockImplementation(async () => {
      await terminateNative();
      throw failure;
    });

    const result = await owner.close(30).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    if (!(result instanceof AggregateError)) {
      throw new Error('Expected shutdown failure');
    }
    expect(result.errors).toContain(failure);
    expect(owner.getStats()).toEqual({ alive: false, pendingBytes: 0, pendingCommands: 0 });
    expect(owner.tryWrite({ operation: 'late', payload: null })).toBe(false);
  });

  it('does not lazily create a worker after an unused owner closes', async () => {
    const { factory, owner } = createWorker();
    await owner.close();
    expect(() => owner.start()).toThrow('shutdown-test closed');
    await expect(owner.request({ operation: 'read', payload: null })).rejects.toThrow(
      'shutdown-test closed',
    );
    expect(owner.tryWrite({ operation: 'write', payload: null })).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });
});
