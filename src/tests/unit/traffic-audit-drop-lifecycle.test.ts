import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoundedSqliteWorker } from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';
import type { TrafficClass } from '@/modules/proxy-gateway/audit/traffic-classifier';

const state = vi.hoisted(() => {
  const queues: BoundedSqliteWorker[] = [];
  const workers: Worker[] = [];
  const events: string[] = [];
  return { directory: '', events, queues, workers };
});

vi.mock('@/shared/platform/paths', () => ({ getProxyStateDir: () => state.directory }));
vi.mock('@/shared/logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/server-config', async () => {
  const { DEFAULT_APP_CONFIG } = await import('@/modules/config/types');
  return {
    getServerConfig: () => ({
      ...DEFAULT_APP_CONFIG.proxy,
      traffic_audit: { ...DEFAULT_APP_CONFIG.proxy.traffic_audit, enabled: true },
    }),
  };
});
vi.mock('@/modules/proxy-gateway/audit/traffic-audit-context', () => ({
  getTrafficAuditRequestContext: () => undefined,
  getProxyResponseTimingContext: () => undefined,
}));
vi.mock('@/shared/persistence/sqlite-worker/bounded-sqlite-worker', async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import('@/shared/persistence/sqlite-worker/bounded-sqlite-worker')
    >();
  return {
    ...original,
    BoundedSqliteWorker: class extends original.BoundedSqliteWorker {
      public constructor(options: ConstructorParameters<typeof original.BoundedSqliteWorker>[0]) {
        super({
          ...options,
          workerFactory: (_filename, workerOptions) => {
            // Substitute SQLite only: service admission, callbacks and weighted scheduling stay real.
            const worker = new Worker(
              `
              const { parentPort } = require('node:worker_threads');
              const drops = new Map();
              let held = null;
              parentPort.on('message', (command) => {
                if (command.release) {
                  if (held) {
                    parentPort.postMessage({ id: held.id, result: true });
                    held = null;
                  }
                  return;
                }
                if (command.operation === 'hold') {
                  held = command;
                  parentPort.postMessage({ event: 'held' });
                  return;
                }
                let result = 1;
                if (command.operation === 'drop') {
                  const { trafficClass, count, reason } = command.payload;
                  const old = drops.get(trafficClass);
                  drops.set(trafficClass, { count: (old?.count ?? 0) + count, reason });
                  parentPort.postMessage({ event: 'drop' });
                } else if (command.operation === 'resetDropStats' || command.operation === 'clear') {
                  result = command.payload.trafficClass
                    ? Number(drops.delete(command.payload.trafficClass)) : drops.size;
                  if (!command.payload.trafficClass) { drops.clear(); }
                  parentPort.postMessage({ event: command.operation });
                } else if (command.operation === 'stats') {
                  result = {
                    bodyStoredBytes: 0, databaseBytes: 0, incompleteBodies: 0,
                    oldestTimestamp: null, rows: 0,
                    droppedCount: [...drops.values()].reduce((sum, row) => sum + row.count, 0),
                    lastDropReason: [...drops.values()].at(-1)?.reason ?? null,
                  };
                }
                parentPort.postMessage({ id: command.id, result });
              });
              `,
              { ...workerOptions, eval: true },
            );
            worker.on('message', (message: { event?: string }) => {
              if (message.event) {
                state.events.push(message.event);
              }
            });
            state.workers.push(worker);
            return worker;
          },
        });
        state.queues.push(this);
      }
    },
  };
});

import { TrafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';

let service: TrafficAuditService;

beforeEach(async () => {
  state.events.length = 0;
  state.queues.length = 0;
  state.workers.length = 0;
  state.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-drop-lifecycle-'));
  service = new TrafficAuditService();
  await service.stats();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const worker of state.workers) {
    worker.postMessage({ release: true });
  }
  const directory = path.resolve(state.directory);
  if (
    path.dirname(directory) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith('agm-drop-lifecycle-')
  ) {
    throw new Error('Unexpected test cleanup directory');
  }
  try {
    await service.shutdown();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function recordDrop(trafficClass: TrafficClass = 'model') {
  vi.spyOn(state.queues[0], 'tryWrite').mockReturnValueOnce(false);
  expect(
    service.startParent({
      method: 'POST',
      protocol: 'openai',
      url: '/v1/chat/completions',
      trafficClass,
      headers: {},
      requestPayloadHandled: true,
    }),
  ).toBeNull();
}

describe.each(['resetDropStats', 'clear'] as const)('%s drop baseline', (operation) => {
  it.each([null, 'model'] as const)(
    'does not resurrect queued drops after reset (%s)',
    async (scope) => {
      recordDrop();
      state.queues[0].tryWrite({ operation: 'hold', payload: null });
      await vi.waitFor(() => expect(state.events).toContain('held'));
      service.recordAdminOperation('flush_before_reset');
      const reset = service[operation](scope);
      await Promise.resolve();
      state.workers[0].postMessage({ release: true });
      await reset;
      await vi.waitFor(() => expect(state.events).toContain('drop'));
      expect((await service.stats()).droppedCount).toBe(0);
      expect(state.events.indexOf('drop')).toBeLessThan(state.events.indexOf(operation));
    },
  );

  it('retains unpersisted drops when the control request fails', async () => {
    recordDrop();
    const queue = state.queues[0];
    const request = queue.request.bind(queue);
    vi.spyOn(queue, 'request').mockImplementation((command) =>
      command.operation === operation
        ? Promise.reject(new Error('control queue is full'))
        : request(command),
    );
    await expect(service[operation]()).rejects.toThrow('control queue is full');
    expect((await service.stats()).droppedCount).toBe(1);
  });

  it.each([true, false])(
    'preserves new drops while reset is pending (success: %s)',
    async (success) => {
      recordDrop();
      const queue = state.queues[0];
      const request = queue.request.bind(queue);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let admitted = false;
      vi.spyOn(queue, 'request').mockImplementation(async (command) => {
        if (command.operation === operation) {
          admitted = true;
          await gate;
          if (!success) {
            throw new Error('control queue is full');
          }
        }
        return request(command);
      });
      const outcome = service[operation]().catch((error: unknown) => error);
      try {
        await vi.waitFor(() => expect(admitted).toBe(true));
        recordDrop();
        service.recordAdminOperation('flush_during_reset');
        expect((await service.stats()).droppedCount).toBe(2);
        expect(state.events).not.toContain('drop');
      } finally {
        release();
        await outcome;
      }
      if (success) {
        expect(await outcome).toBe(0);
      } else {
        expect(await outcome).toEqual(new Error('control queue is full'));
      }
      expect((await service.stats()).droppedCount).toBe(success ? 1 : 2);
    },
  );

  it('preserves drops in other traffic classes', async () => {
    await state.queues[0].request({
      operation: 'drop',
      payload: {
        trafficClass: 'ipc',
        count: 3,
        reason: 'ipc_failure',
        droppedBytes: 0,
        lastSeen: 1,
      },
    });
    recordDrop();
    await service[operation]('model');
    expect(await service.stats()).toMatchObject({ droppedCount: 3, lastDropReason: 'ipc_failure' });
  });

  it('allows an overlapping reset to finish after the first reset fails', async () => {
    recordDrop();
    vi.spyOn(state.queues[0], 'request').mockRejectedValueOnce(new Error('control queue is full'));
    const failed = service[operation]().catch((error: unknown) => error);
    const next = service[operation]();
    expect(await failed).toEqual(new Error('control queue is full'));
    expect(await next).toBe(0);
    expect((await service.stats()).droppedCount).toBe(0);
  });
});
