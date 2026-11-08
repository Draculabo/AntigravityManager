import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import {
  BoundedSqliteWorker,
  type SqliteWorkerFactory,
} from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';
import type { CreateDiagnosticErrorRecordInput } from '@/shared/observability/errorDiagnostic';
import type { LocalErrorSink } from '@/shared/logging/local-error-sink';
import {
  encodeErrorCapture,
  StoredErrorRecordSchema,
  type EncodedErrorRecord,
} from './error-record';
import type { ErrorDiagnosticRole } from './error-window.database';
import {
  ErrorAllocationSchema,
  ErrorWindowClearSchema,
  ErrorWindowMaintenanceSchema,
  ErrorWindowPageSchema,
  ErrorWindowStatsSchema,
  type ErrorWindowQuery,
} from './error-window.schema';

const MAX_FALLBACK_BYTES = 1024 * 1024;
const MAX_FALLBACK_RECORDS = 64;
type Capture = Extract<EncodedErrorRecord, { accepted: true }> & {
  generation: string;
  retainedBytes: number;
};
type Failure =
  | 'record_too_large'
  | 'projection_failed'
  | 'queue_full'
  | 'store_unavailable'
  | 'write_failed'
  | 'cleared_generation'
  | 'disk_budget'
  | 'checkpoint_busy'
  | 'read_only'
  | 'disk_full'
  | 'disk_usage_unknown'
  | 'reclaim_failed'
  | 'closed';
const FailureSchema = z.enum([
  'disk_budget',
  'checkpoint_busy',
  'read_only',
  'disk_full',
  'disk_usage_unknown',
  'reclaim_failed',
]);

interface ErrorWindowOptions {
  role: ErrorDiagnosticRole;
  databasePath: string;
  workerPath: string;
  workerFactory?: SqliteWorkerFactory;
}

/** Process lifetime, independent of Nest. Construction and logger registration perform no I/O. */
export class ErrorWindowService {
  private worker: BoundedSqliteWorker | null = null;
  private generation = randomUUID();
  private allocationBytes: number | null = null;
  private ready = false;
  private closed = false;
  private clearing = 0;
  private operations: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private closeWriteFailed = false;
  private unregister: (() => void) | null = null;
  private maintenance: Promise<void> | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private lastFailure: Failure | null = null;
  private maintenanceBlocked: string | null = null;
  private maintenanceRetryAt = 0;
  private readonly fallback = new Map<string, Capture>();
  private fallbackBytes = 0;
  private readonly counters = {
    captured: 0,
    accepted: 0,
    persisted: 0,
    rejected: 0,
    failed: 0,
    cleared: 0,
    fallbackEvicted: 0,
    discarded: 0,
  };

  constructor(private readonly options: ErrorWindowOptions) {}

  get currentGeneration(): string {
    return this.generation;
  }
  get storageReady(): boolean {
    return this.ready && !this.closed;
  }

  attachLogger(logger: { setLocalErrorSink: (sink: LocalErrorSink) => () => void }): void {
    if (this.closed) {
      throw new Error('Local error diagnostic owner is closed');
    }
    this.unregister?.();
    this.unregister = logger.setLocalErrorSink(({ message, error }) =>
      this.capture({ error: error ?? message, source: 'logger', category: 'unclassified-error' }),
    );
  }

  applyAllocation(allocationBytes: number): Promise<void> {
    ErrorAllocationSchema.parse(allocationBytes);
    return this.serial(async () => {
      this.requireOpen();
      this.allocationBytes = allocationBytes;
      try {
        if (!this.worker) {
          await fs.mkdir(path.dirname(this.options.databasePath), { recursive: true, mode: 0o700 });
          const factory =
            this.options.workerFactory ?? ((filename, options) => new Worker(filename, options));
          this.worker = new BoundedSqliteWorker({
            databasePath: this.options.databasePath,
            workerPath: this.options.workerPath,
            name: `error-window-${this.options.role}`,
            maxPendingBytes: 32 * 1024 * 1024,
            maxPendingCommands: 256,
            workerFactory: (filename, options) =>
              factory(filename, {
                ...options,
                workerData: { databasePath: this.options.databasePath, role: this.options.role },
              }),
          });
          this.worker.start();
          ErrorWindowStatsSchema.parse(
            await this.worker.request({
              operation: 'initialize',
              payload: { generation: this.generation, allocationBytes },
            }),
          );
        } else {
          ErrorWindowStatsSchema.parse(
            await this.worker.request({
              operation: 'configure',
              payload: { generation: this.generation, allocationBytes },
            }),
          );
        }
        this.ready = true;
        this.maintenanceRetryAt = 0;
        this.lastFailure = null;
        this.flushFallback();
        this.startMaintenance();
      } catch (error) {
        this.ready = false;
        this.lastFailure = 'store_unavailable';
        const failed = this.worker;
        this.worker = null;
        if (failed) {
          try {
            await failed.close(5000);
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              'Local error diagnostic initialization and cleanup failed',
            );
          }
        }
        throw error;
      }
    });
  }

  capture(input: CreateDiagnosticErrorRecordInput): void {
    this.increment('captured');
    if (this.closed) {
      this.increment('rejected');
      this.increment('discarded');
      this.lastFailure = 'closed';
      return;
    }
    let encoded: EncodedErrorRecord;
    try {
      encoded = encodeErrorCapture({ ...input, role: this.options.role });
    } catch {
      this.increment('rejected');
      this.increment('discarded');
      this.lastFailure = 'projection_failed';
      return;
    }
    if (!encoded.accepted) {
      this.increment('rejected');
      this.increment('discarded');
      this.lastFailure = encoded.reason;
      return;
    }
    const capture = {
      ...encoded,
      generation: this.generation,
      retainedBytes: encoded.body.length * 2 + 128,
    };
    if (!this.write(capture)) {
      this.retainFallback(capture);
    }
  }

  async query(input: ErrorWindowQuery) {
    const generation = this.generation;
    const page = ErrorWindowPageSchema.parse(
      await this.requireReady().request({ operation: 'query', payload: input }),
    );
    this.assertCurrent(generation);
    if (page.generation !== generation) {
      throw new Error('Local error diagnostic generation is unavailable');
    }
    return page;
  }

  async detail(id: string) {
    const generation = this.generation;
    const record = StoredErrorRecordSchema.nullable().parse(
      await this.requireReady().request({ operation: 'detail', payload: { id } }),
    );
    this.assertCurrent(generation);
    return record;
  }

  async status() {
    const generation = this.generation;
    const local = {
      storagePath: this.options.databasePath,
      role: this.options.role,
      counters: { ...this.counters },
      fallbackRecords: this.fallback.size,
      fallbackBytes: this.fallbackBytes,
      lastFailure: this.lastFailure,
      maintenanceBlocked: this.maintenanceBlocked,
      queue: this.worker?.getStats() ?? null,
    };
    if (!this.ready || !this.worker || this.closed) {
      return {
        ...local,
        storage: { state: 'unavailable' as const, allocationBytes: this.allocationBytes },
      };
    }
    try {
      const stats = ErrorWindowStatsSchema.parse(
        await this.worker.request({ operation: 'stats', payload: null }),
      );
      this.assertCurrent(generation);
      if (stats.generation !== generation) {
        throw new Error('Local error diagnostic generation is unavailable');
      }
      return { ...local, storage: { state: 'ready' as const, ...stats } };
    } catch {
      return {
        ...local,
        storage: { state: 'unavailable' as const, allocationBytes: this.allocationBytes },
      };
    }
  }

  clear() {
    this.requireOpen();
    this.generation = randomUUID();
    this.clearing += 1;
    const memoryRecords = this.fallback.size;
    this.fallback.clear();
    this.fallbackBytes = 0;
    const generation = this.generation;
    return this.serial(async () => {
      try {
        const receipt = ErrorWindowClearSchema.parse(
          await this.requireReady().request({ operation: 'clear', payload: { generation } }),
        );
        return { ...receipt, memoryRecords };
      } catch (error) {
        this.ready = false;
        this.lastFailure = 'store_unavailable';
        throw error;
      } finally {
        this.clearing -= 1;
        this.flushFallback();
      }
    });
  }

  async drain(): Promise<void> {
    await this.operations;
    await this.worker?.drainAdmitted(5000);
  }

  shutdown(): Promise<void> {
    this.closed = true;
    this.unregister?.();
    this.unregister = null;
    if (this.maintenanceTimer) {
      clearTimeout(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    this.closePromise ??= (async () => {
      await this.operations;
      await this.maintenance;
      await this.worker?.close(5000);
      this.ready = false;
      if (this.closeWriteFailed || this.fallback.size > 0) {
        throw new Error('Local error diagnostic shutdown has unpersisted captures');
      }
    })();
    return this.closePromise;
  }

  private write(capture: Capture): boolean {
    if (!this.ready || !this.worker || this.clearing > 0 || this.closed) {
      this.lastFailure = this.closed ? 'closed' : 'store_unavailable';
      return false;
    }
    const accepted = this.worker.tryWrite(
      { operation: 'insert', payload: { generation: capture.generation, body: capture.body } },
      {
        priority: 'model',
        onSuccess: () => this.increment('persisted'),
        onFailure: (error) => {
          if (capture.generation !== this.generation) {
            this.increment('cleared');
            return;
          }
          this.increment('failed');
          if (this.closed) {
            this.closeWriteFailed = true;
          }
          const reason =
            error instanceof Error && error.message.startsWith('SQLite write rejected: ')
              ? FailureSchema.safeParse(error.message.slice(23))
              : null;
          this.lastFailure = reason?.success ? reason.data : 'write_failed';
          this.retainFallback(capture);
          this.startMaintenance();
        },
      },
    );
    if (accepted) {
      this.increment('accepted');
    } else {
      this.increment('rejected');
      this.lastFailure = 'queue_full';
    }
    return accepted;
  }

  private retainFallback(capture: Capture): void {
    if (capture.generation !== this.generation || this.closed) {
      return;
    }
    if (capture.retainedBytes > MAX_FALLBACK_BYTES) {
      this.increment('fallbackEvicted');
      return;
    }
    const previous = this.fallback.get(capture.id);
    if (previous) {
      this.fallbackBytes -= previous.retainedBytes;
      this.fallback.delete(capture.id);
    }
    while (
      this.fallback.size >= MAX_FALLBACK_RECORDS ||
      this.fallbackBytes + capture.retainedBytes > MAX_FALLBACK_BYTES
    ) {
      const oldest = this.fallback.entries().next().value;
      if (!oldest) {
        break;
      }
      this.fallback.delete(oldest[0]);
      this.fallbackBytes -= oldest[1].retainedBytes;
      this.increment('fallbackEvicted');
    }
    this.fallback.set(capture.id, capture);
    this.fallbackBytes += capture.retainedBytes;
  }

  private flushFallback(): void {
    if (!this.ready || this.clearing > 0 || this.closed) {
      return;
    }
    for (const [id, capture] of this.fallback) {
      if (!this.write(capture)) {
        break;
      }
      this.fallback.delete(id);
      this.fallbackBytes -= capture.retainedBytes;
    }
  }

  private startMaintenance(): void {
    if (
      this.closed ||
      !this.ready ||
      this.maintenance ||
      this.maintenanceTimer ||
      performance.now() < this.maintenanceRetryAt
    ) {
      return;
    }
    this.maintenance = (async () => {
      const startedAt = performance.now();
      for (let slice = 0; slice < 128 && !this.closed && this.ready; slice += 1) {
        const result = ErrorWindowMaintenanceSchema.parse(
          await this.requireReady().request({ operation: 'maintain', payload: null }),
        );
        this.maintenanceBlocked = result.blockedReason ?? null;
        if (result.blockedReason) {
          this.maintenanceRetryAt = performance.now() + 1000;
        }
        if (!result.moreWorkPending) {
          if (
            !result.blockedReason &&
            (result.removedRecords > 0 || (result.reclaimedBytes ?? 0) > 0)
          ) {
            this.flushFallback();
          }
          return;
        }
        if (performance.now() - startedAt >= 250) {
          this.maintenanceTimer = setTimeout(() => {
            this.maintenanceTimer = null;
            this.startMaintenance();
          }, 1000);
          this.maintenanceTimer.unref();
          return;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })()
      .catch(() => {
        if (!this.closed) {
          this.maintenanceBlocked = 'reclaim_failed';
          this.maintenanceRetryAt = performance.now() + 1000;
        }
      })
      .finally(() => {
        this.maintenance = null;
      });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operations.then(work);
    this.operations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private increment(key: keyof ErrorWindowService['counters']): void {
    this.counters[key] = Math.min(Number.MAX_SAFE_INTEGER, this.counters[key] + 1);
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new Error('Local error diagnostic owner is closed');
    }
  }

  private requireReady(): BoundedSqliteWorker {
    this.requireOpen();
    if (!this.ready || !this.worker) {
      throw new Error('Local error diagnostic storage is unavailable');
    }
    return this.worker;
  }

  private assertCurrent(generation: string): void {
    this.requireOpen();
    if (generation !== this.generation) {
      throw new Error('Local error diagnostic read was invalidated');
    }
  }
}
