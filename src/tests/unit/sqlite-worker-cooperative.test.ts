import { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import {
  BoundedSqliteWorker,
  type SqliteWorkerFactory,
} from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';

function fixture() {
  const factory = vi.fn<SqliteWorkerFactory>(
    (_filename, options) =>
      new Worker(
        `
        const { parentPort } = require('node:worker_threads');
        const slices = new Map();
        parentPort.on('message', (command) => {
          if (command.operation === 'maintenance') {
            const slice = (slices.get(command.id) ?? 0) + 1;
            slices.set(command.id, slice);
            if (slice === 1 || command.payload === 'stall') {
              parentPort.postMessage({ id: command.id, yielded: true });
            } else if (command.payload === 'fail') {
              parentPort.postMessage({ id: command.id, error: 'maintenance failed after partial work' });
            } else {
              parentPort.postMessage({ id: command.id, result: { slices: slice } });
            }
          } else {
            parentPort.postMessage({ id: command.id, result: command.operation });
          }
        });
        `,
        { ...options, eval: true },
      ),
  );
  const owner = new BoundedSqliteWorker({
    databasePath: 'unused-cooperative-database',
    maxPendingBytes: 100_000,
    maxPendingCommands: 100,
    name: 'cooperative-test',
    workerFactory: factory,
    workerPath: 'test-only',
  });
  return { owner, factory };
}

describe('SQLite cooperative command scheduling', () => {
  it('serves a queued read before resuming maintenance and retains accounting until completion', async () => {
    const { owner } = fixture();
    const events: string[] = [];
    try {
      const maintenance = owner
        .request({ operation: 'maintenance', payload: null })
        .then((result) => {
          events.push('maintenance');
          return result;
        });
      const read = owner.request({ operation: 'stats', payload: null }).then((result) => {
        events.push('stats');
        expect(owner.getStats()).toMatchObject({ alive: true, pendingCommands: 1 });
        expect(owner.getStats().pendingBytes).toBeGreaterThan(0);
        return result;
      });
      await expect(read).resolves.toBe('stats');
      await expect(maintenance).resolves.toEqual({ slices: 2 });
      expect(events).toEqual(['stats', 'maintenance']);
      expect(owner.getStats()).toEqual({ alive: true, pendingBytes: 0, pendingCommands: 0 });
    } finally {
      await owner.close();
    }
  });

  it('drains every accepted slice before shutdown and never reopens admission', async () => {
    const { owner, factory } = fixture();
    const maintenance = owner.request({ operation: 'maintenance', payload: null });
    const closing = owner.close();
    expect(owner.close()).toBe(closing);
    await expect(owner.request({ operation: 'late', payload: null })).rejects.toThrow('closed');
    await expect(maintenance).resolves.toEqual({ slices: 2 });
    await closing;
    expect(owner.getStats()).toEqual({ alive: false, pendingBytes: 0, pendingCommands: 0 });
    expect(factory).toHaveBeenCalledOnce();
  });

  it('preserves a final maintenance error after yielding and keeps later reads usable', async () => {
    const { owner } = fixture();
    try {
      await expect(owner.request({ operation: 'maintenance', payload: 'fail' })).rejects.toThrow(
        'maintenance failed after partial work',
      );
      await expect(owner.request({ operation: 'stats', payload: null })).resolves.toBe('stats');
    } finally {
      await owner.close();
    }
  });

  it('reports a stalled continuation when the existing close deadline expires', async () => {
    const { owner } = fixture();
    const maintenance = owner.request({ operation: 'maintenance', payload: 'stall' });
    const outcome = maintenance.catch((error: unknown) => error);
    await expect(owner.close(100)).rejects.toThrow('shutdown failed');
    expect(await outcome).toEqual(new Error('cooperative-test closed'));
    expect(owner.getStats()).toEqual({ alive: false, pendingBytes: 0, pendingCommands: 0 });
  });
});
