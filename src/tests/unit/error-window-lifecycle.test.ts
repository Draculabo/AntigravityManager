import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  SqliteWorkerCommand,
  SqliteWorkerWriteCallbacks,
} from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';
import { ErrorWindowService } from '@/modules/error-diagnostics/error-window.service';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ command: SqliteWorkerCommand; callbacks: SqliteWorkerWriteCallbacks }>,
  generation: '',
  allocationBytes: 0,
  request: vi.fn<(command: SqliteWorkerCommand) => Promise<unknown>>(),
  close: vi.fn<() => Promise<void>>(),
  accept: true,
}));
vi.mock('@/shared/persistence/sqlite-worker/bounded-sqlite-worker', () => ({
  BoundedSqliteWorker: class {
    start() {}
    request = state.request;
    close = state.close;
    async drainAdmitted() {}
    getStats() {
      return { alive: true, pendingBytes: 0, pendingCommands: state.calls.length };
    }
    tryWrite(command: SqliteWorkerCommand, callbacks: SqliteWorkerWriteCallbacks) {
      if (state.accept) {
        state.calls.push({ command, callbacks });
      }
      return state.accept;
    }
  },
}));
let directory: string;
let owner: ErrorWindowService;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-error-lifecycle-'));
  state.calls = [];
  state.accept = true;
  state.generation = '';
  state.close.mockReset().mockResolvedValue();
  state.request.mockReset().mockImplementation(async (command) => {
    if (command.operation === 'maintain') {
      return { removedRecords: 0, databaseBytes: 4096, moreWorkPending: false };
    }
    if (command.operation === 'initialize' || command.operation === 'configure') {
      const { ErrorWindowCommandSchema } =
        await import('@/modules/error-diagnostics/error-window.schema');
      const parsed = ErrorWindowCommandSchema.parse(command);
      if (parsed.operation === 'initialize' || parsed.operation === 'configure') {
        state.generation = parsed.payload.generation;
        state.allocationBytes = parsed.payload.allocationBytes;
      }
    }
    return {
      generation: state.generation,
      role: 'core',
      allocationBytes: state.allocationBytes,
      maintenanceCeiling: state.allocationBytes,
      reclaiming: false,
      databaseBytes: 4096,
      records: 0,
    };
  });
  owner = new ErrorWindowService({
    role: 'core',
    databasePath: path.join(directory, 'core.db'),
    workerPath: 'fixture.worker.js',
  });
});
afterEach(async () => {
  // Individual failure tests observe the primary shutdown rejection explicitly.
  await owner.shutdown().catch(() => undefined);
  expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(directory).startsWith('agm-error-lifecycle-')).toBe(true);
  await fs.rm(directory, { recursive: true, force: true });
});
const capture = () =>
  owner.capture({ error: 'fixture failure', source: 'test', category: 'fixture' });

it('distinguishes accepted queue admission from successful durable acknowledgement', async () => {
  await owner.applyAllocation(32 * 1024 * 1024);
  capture();
  expect((await owner.status()).counters).toMatchObject({ accepted: 1, persisted: 0 });
  state.calls[0].callbacks.onSuccess?.();
  expect((await owner.status()).counters).toMatchObject({ accepted: 1, persisted: 1 });
});

it('preserves bounded fallback and explicit state after write refusal, without recursive logging', async () => {
  await owner.applyAllocation(32 * 1024 * 1024);
  capture();
  state.calls[0].callbacks.onFailure?.(new Error('SQLite write rejected: disk_full'));
  expect(await owner.status()).toMatchObject({
    fallbackRecords: 1,
    lastFailure: 'disk_full',
    counters: { failed: 1, persisted: 0 },
  });
  await expect(owner.shutdown()).rejects.toThrow('unpersisted captures');
});

it('reports a shutdown-time write failure instead of declaring the accepted capture persisted', async () => {
  await owner.applyAllocation(32 * 1024 * 1024);
  capture();
  state.close.mockImplementationOnce(async () => {
    state.calls[0].callbacks.onFailure?.(new Error('SQLite write rejected: read_only'));
  });
  await expect(owner.shutdown()).rejects.toThrow('unpersisted captures');
  expect((await owner.status()).counters).toMatchObject({ accepted: 1, persisted: 0, failed: 1 });
});

it('can recover from a failed initialization through a later explicit allocation, without a second writer', async () => {
  state.request.mockRejectedValueOnce(new Error('fixture open failure'));
  await expect(owner.applyAllocation(32 * 1024 * 1024)).rejects.toThrow('fixture open failure');
  expect(state.close).toHaveBeenCalledOnce();
  capture();
  await owner.applyAllocation(32 * 1024 * 1024);
  expect(state.calls).toHaveLength(1);
  state.calls[0].callbacks.onSuccess?.();
  expect(await owner.status()).toMatchObject({ fallbackRecords: 0, counters: { persisted: 1 } });
});

it('bounds queue-refused fallback by retained bytes and reports unavailable storage truthfully', async () => {
  await owner.applyAllocation(32 * 1024 * 1024);
  state.accept = false;
  for (let index = 0; index < 80; index += 1) {
    owner.capture({ error: '帧'.repeat(6000), source: 'test', category: 'fixture' });
  }
  const status = await owner.status();
  expect(status.lastFailure).toBe('queue_full');
  expect(status.counters.rejected).toBe(80);
  expect(status.fallbackBytes).toBeLessThanOrEqual(1024 * 1024);
  expect(status.counters.fallbackEvicted).toBeGreaterThan(0);
  state.request.mockRejectedValueOnce(new Error('fixture stat failure'));
  expect((await owner.status()).storage.state).toBe('unavailable');
  await expect(owner.shutdown()).rejects.toThrow('unpersisted captures');
});
