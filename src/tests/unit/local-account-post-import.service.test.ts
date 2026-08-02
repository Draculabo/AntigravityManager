import { describe, expect, it, vi } from 'vitest';
import {
  LocalAccountPostImportService,
  type LocalAccountPostImportTaskRunner,
} from '@/modules/cloud-account/local-import/local-account-post-import.service';

function createDeferredRunner() {
  let run: LocalAccountPostImportTaskRunner | undefined;
  return {
    defer: vi.fn((task: LocalAccountPostImportTaskRunner) => {
      run = task;
    }),
    run: async () => {
      if (!run) {
        throw new Error('No background task was scheduled');
      }
      await run();
    },
  };
}

describe('LocalAccountPostImportService', () => {
  it('returns a queued task before starting quota refreshes', async () => {
    const deferred = createDeferredRunner();
    const refreshAccountQuota = vi.fn(async () => undefined);
    const service = new LocalAccountPostImportService({
      dependencies: {
        refreshAccountQuota,
        reloadAccountCache: vi.fn(async () => 'reloaded' as const),
        createTaskId: () => '00000000-0000-4000-8000-000000000101',
        now: () => 1_800_000_000,
        defer: deferred.defer,
      },
    });

    const taskId = service.schedule(['account-a']);

    expect(taskId).toBe('00000000-0000-4000-8000-000000000101');
    expect(refreshAccountQuota).not.toHaveBeenCalled();
    expect(service.getStatus(taskId!)).toEqual({
      taskId,
      status: 'queued',
      totalAccounts: 1,
      completedAccounts: 0,
      refreshedAccountIds: [],
      failedAccountIds: [],
      cacheReloadStatus: 'pending',
      createdAt: 1_800_000_000,
    });

    await deferred.run();
  });

  it('bounds quota refresh concurrency, isolates failures, and reloads the cache once', async () => {
    const deferred = createDeferredRunner();
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    const refreshAccountQuota = vi.fn(async (accountId: string) => {
      activeRefreshes += 1;
      maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
      await Promise.resolve();
      activeRefreshes -= 1;
      if (accountId === 'account-b') {
        throw new Error('quota refresh failed');
      }
    });
    const reloadAccountCache = vi.fn(async () => 'reloaded' as const);
    let now = 1_800_000_000;
    const service = new LocalAccountPostImportService({
      dependencies: {
        refreshAccountQuota,
        reloadAccountCache,
        createTaskId: () => '00000000-0000-4000-8000-000000000102',
        now: () => now++,
        defer: deferred.defer,
      },
      maxConcurrency: 2,
    });

    const taskId = service.schedule([
      'account-a',
      'account-b',
      'account-a',
      'account-c',
      'account-d',
    ]);
    await deferred.run();

    expect(refreshAccountQuota.mock.calls.map(([accountId]) => accountId)).toEqual([
      'account-a',
      'account-b',
      'account-c',
      'account-d',
    ]);
    expect(maxActiveRefreshes).toBe(2);
    expect(reloadAccountCache).toHaveBeenCalledTimes(1);
    expect(service.getStatus(taskId!)).toEqual({
      taskId,
      status: 'completed',
      totalAccounts: 4,
      completedAccounts: 4,
      refreshedAccountIds: ['account-a', 'account-c', 'account-d'],
      failedAccountIds: ['account-b'],
      cacheReloadStatus: 'reloaded',
      createdAt: 1_800_000_000,
      startedAt: 1_800_000_001,
      completedAt: 1_800_000_002,
    });
  });

  it('does not schedule work or reload the cache when no account changed', () => {
    const deferred = createDeferredRunner();
    const reloadAccountCache = vi.fn(async () => 'reloaded' as const);
    const service = new LocalAccountPostImportService({
      dependencies: {
        refreshAccountQuota: vi.fn(async () => undefined),
        reloadAccountCache,
        createTaskId: () => '00000000-0000-4000-8000-000000000103',
        now: () => 1_800_000_000,
        defer: deferred.defer,
      },
    });

    expect(service.schedule([])).toBeUndefined();
    expect(deferred.defer).not.toHaveBeenCalled();
    expect(reloadAccountCache).not.toHaveBeenCalled();
  });

  it('records a stopped proxy as skipped and a reload exception as failed', async () => {
    const skippedDeferred = createDeferredRunner();
    const skippedService = new LocalAccountPostImportService({
      dependencies: {
        refreshAccountQuota: vi.fn(async () => undefined),
        reloadAccountCache: vi.fn(async () => 'skipped' as const),
        createTaskId: () => '00000000-0000-4000-8000-000000000104',
        now: () => 1_800_000_000,
        defer: skippedDeferred.defer,
      },
    });
    const skippedTaskId = skippedService.schedule(['account-a']);
    await skippedDeferred.run();

    expect(skippedService.getStatus(skippedTaskId!)?.cacheReloadStatus).toBe('skipped');

    const failedDeferred = createDeferredRunner();
    const failedService = new LocalAccountPostImportService({
      dependencies: {
        refreshAccountQuota: vi.fn(async () => undefined),
        reloadAccountCache: vi.fn(async () => {
          throw new Error('reload failed');
        }),
        createTaskId: () => '00000000-0000-4000-8000-000000000105',
        now: () => 1_800_000_000,
        defer: failedDeferred.defer,
      },
    });
    const failedTaskId = failedService.schedule(['account-a']);
    await failedDeferred.run();

    expect(failedService.getStatus(failedTaskId!)?.cacheReloadStatus).toBe('failed');
  });
});
