import { randomUUID } from 'crypto';
import { logger } from '@/shared/logging/logger';
import type {
  LocalAccountPostImportCacheReloadStatus,
  LocalAccountPostImportTaskSnapshot,
} from './import-types';

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_MAX_TASKS = 32;
const DEFAULT_TASK_TTL_MS = 15 * 60 * 1000;

export type LocalAccountPostImportTaskRunner = () => Promise<void>;

export interface LocalAccountPostImportDependencies {
  refreshAccountQuota: (accountId: string) => Promise<void>;
  reloadAccountCache: () => Promise<'reloaded' | 'skipped'>;
  createTaskId: () => string;
  now: () => number;
  defer: (task: LocalAccountPostImportTaskRunner) => void;
}

export interface LocalAccountPostImportOptions {
  dependencies?: LocalAccountPostImportDependencies;
  maxConcurrency?: number;
  maxTasks?: number;
  taskTtlMs?: number;
}

interface MutablePostImportTask extends LocalAccountPostImportTaskSnapshot {
  forgetAt: number;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function createDefaultDependencies(): LocalAccountPostImportDependencies {
  return {
    refreshAccountQuota: async (accountId) => {
      const { refreshAccountQuota } = await import('../ipc/handler');
      await refreshAccountQuota(accountId);
    },
    reloadAccountCache: async () => {
      const { reloadNestServerAccountLeaseCache } = await import('@/server/main');
      return (await reloadNestServerAccountLeaseCache()) ? 'reloaded' : 'skipped';
    },
    createTaskId: randomUUID,
    now: Date.now,
    defer: (task) => {
      const timer = setTimeout(() => {
        task();
      }, 0);
      timer.unref();
    },
  };
}

/**
 * Runs post-import quota hydration outside the confirmation response path.
 *
 * Task snapshots intentionally contain only account IDs and state counters.
 * Upstream error objects stay in the main-process logs and never cross IPC.
 */
export class LocalAccountPostImportService {
  private readonly dependencies: LocalAccountPostImportDependencies;
  private readonly maxConcurrency: number;
  private readonly maxTasks: number;
  private readonly taskTtlMs: number;
  private readonly tasks = new Map<string, MutablePostImportTask>();

  constructor(options: LocalAccountPostImportOptions = {}) {
    this.dependencies = options.dependencies ?? createDefaultDependencies();
    this.maxConcurrency = normalizePositiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
    this.maxTasks = normalizePositiveInteger(options.maxTasks, DEFAULT_MAX_TASKS);
    this.taskTtlMs = normalizePositiveInteger(options.taskTtlMs, DEFAULT_TASK_TTL_MS);
  }

  schedule(accountIds: string[]): string | undefined {
    const uniqueAccountIds = Array.from(new Set(accountIds));
    if (uniqueAccountIds.length === 0) {
      return undefined;
    }

    const now = this.dependencies.now();
    this.cleanup(now);
    this.evictOldestTasks();
    const taskId = this.dependencies.createTaskId();
    const task: MutablePostImportTask = {
      taskId,
      status: 'queued',
      totalAccounts: uniqueAccountIds.length,
      completedAccounts: 0,
      refreshedAccountIds: [],
      failedAccountIds: [],
      cacheReloadStatus: 'pending',
      createdAt: now,
      forgetAt: now + this.taskTtlMs,
    };
    this.tasks.set(taskId, task);
    this.dependencies.defer(() => this.runTask(task, uniqueAccountIds));
    return taskId;
  }

  getStatus(taskId: string): LocalAccountPostImportTaskSnapshot | undefined {
    this.cleanup(this.dependencies.now());
    const task = this.tasks.get(taskId);
    if (!task) {
      return undefined;
    }

    return {
      taskId: task.taskId,
      status: task.status,
      totalAccounts: task.totalAccounts,
      completedAccounts: task.completedAccounts,
      refreshedAccountIds: [...task.refreshedAccountIds],
      failedAccountIds: [...task.failedAccountIds],
      cacheReloadStatus: task.cacheReloadStatus,
      createdAt: task.createdAt,
      ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
      ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
    };
  }

  private async runTask(task: MutablePostImportTask, accountIds: string[]): Promise<void> {
    task.status = 'running';
    task.startedAt = this.dependencies.now();
    let nextIndex = 0;
    const workerCount = Math.min(this.maxConcurrency, accountIds.length);

    const runWorker = async () => {
      while (nextIndex < accountIds.length) {
        const accountId = accountIds[nextIndex];
        nextIndex += 1;
        try {
          await this.dependencies.refreshAccountQuota(accountId);
          task.refreshedAccountIds.push(accountId);
        } catch {
          task.failedAccountIds.push(accountId);
          logger.warn(`Post-import quota refresh failed for account ${accountId}`);
        } finally {
          task.completedAccounts += 1;
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    task.cacheReloadStatus = await this.reloadAccountCache();
    task.status = 'completed';
    task.completedAt = this.dependencies.now();
    task.forgetAt = task.completedAt + this.taskTtlMs;
  }

  private async reloadAccountCache(): Promise<LocalAccountPostImportCacheReloadStatus> {
    try {
      return await this.dependencies.reloadAccountCache();
    } catch {
      logger.warn('Post-import account cache reload failed');
      return 'failed';
    }
  }

  private cleanup(now: number): void {
    for (const [taskId, task] of this.tasks) {
      if (task.status === 'completed' && task.forgetAt <= now) {
        this.tasks.delete(taskId);
      }
    }
  }

  private evictOldestTasks(): void {
    while (this.tasks.size >= this.maxTasks) {
      const oldestTaskId = this.tasks.keys().next().value;
      if (typeof oldestTaskId !== 'string') {
        return;
      }
      this.tasks.delete(oldestTaskId);
    }
  }
}

export const localAccountPostImportService = new LocalAccountPostImportService();
