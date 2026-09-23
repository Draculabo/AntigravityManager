import { Worker, type WorkerOptions } from 'node:worker_threads';

export interface SqliteWorkerCommand<TPayload = unknown> {
  operation: string;
  payload: TPayload;
}

export interface BoundedSqliteWorkerOptions {
  databasePath: string;
  maxPendingBytes: number;
  maxPendingCommands: number;
  name: string;
  onWriteFailure?: (error: unknown) => void;
  workerPath: string;
  workerFactory?: SqliteWorkerFactory;
}

export type SqliteWorkerFactory = (filename: string, options: WorkerOptions) => Worker;

interface PendingCommand {
  bytes: number;
  command: SqliteWorkerCommand;
  id: number;
  priority: SqliteWorkerPriority;
  reject: (reason?: unknown) => void;
  resolve: (value: unknown) => void;
}

interface WorkerReply {
  error?: string;
  id: number;
  result?: unknown;
}

export interface SqliteWorkerQueueStats {
  alive: boolean;
  pendingBytes: number;
  pendingCommands: number;
}

export interface SqliteWorkerWriteCallbacks {
  onFailure?: (error: unknown) => void;
  onSuccess?: () => void;
  priority?: Exclude<SqliteWorkerPriority, 'control'>;
}

export type SqliteWorkerPriority = 'model' | 'auxiliary' | 'background' | 'control';

const NON_MODEL_QUEUE_SHARE = 0.3;
const BACKGROUND_QUEUE_SHARE = 0.1;
const CONTROL_QUEUE_SHARE = 0.1;
const SCHEDULE: readonly SqliteWorkerPriority[] = [
  'model',
  'model',
  'model',
  'model',
  'model',
  'model',
  'model',
  'model',
  'auxiliary',
  'auxiliary',
  'background',
  'control',
];

/**
 * A small RPC boundary around a synchronous SQLite worker.
 *
 * Writes use {@link tryWrite}: overload is reported to the caller and never delays the
 * model request. Reads are explicit promises used only by management and hydration paths.
 */
export class BoundedSqliteWorker {
  private worker: Worker | null = null;
  private nextId = 1;
  private pendingBytes = 0;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly queues: Record<SqliteWorkerPriority, number[]> = {
    auxiliary: [],
    background: [],
    control: [],
    model: [],
  };
  private activeId: number | null = null;
  private scheduleIndex = 0;
  private readonly idleWaiters = new Set<() => void>();
  private alive = false;

  public constructor(private readonly options: BoundedSqliteWorkerOptions) {}

  public getStats(): SqliteWorkerQueueStats {
    return {
      alive: this.alive,
      pendingBytes: this.pendingBytes,
      pendingCommands: this.pending.size,
    };
  }

  public start(): void {
    if (this.worker) {
      return;
    }

    const worker = (this.options.workerFactory ?? createSqliteWorker)(this.options.workerPath, {
      name: this.options.name,
      workerData: { databasePath: this.options.databasePath },
    });
    this.worker = worker;
    this.alive = true;
    worker.on('message', (reply: WorkerReply) => this.handleReply(reply));
    worker.on('error', (error) => this.failWorker(error));
    worker.on('exit', (code) => {
      if (this.worker === worker) {
        this.failWorker(new Error(`${this.options.name} exited with code ${code}`));
      }
    });
  }

  public tryWrite(
    command: SqliteWorkerCommand,
    callbacks: SqliteWorkerWriteCallbacks = {},
  ): boolean {
    const bytes = estimateCommandBytes(command);
    const priority = callbacks.priority ?? 'background';
    const backgroundUsage = this.getUsage(['background']);
    const nonModelUsage = this.getUsage(['auxiliary', 'background']);
    if (
      bytes > this.options.maxPendingBytes ||
      this.pending.size >= this.options.maxPendingCommands ||
      this.pendingBytes + bytes > this.options.maxPendingBytes ||
      (priority === 'background' &&
        this.exceedsShare(backgroundUsage, bytes, BACKGROUND_QUEUE_SHARE)) ||
      (priority !== 'model' && this.exceedsShare(nonModelUsage, bytes, NON_MODEL_QUEUE_SHARE))
    ) {
      return false;
    }

    this.send(command, bytes, priority)
      .then(callbacks.onSuccess)
      .catch((error) => {
        // The owning service exposes aggregate failure/drop state. A write failure is
        // deliberately detached from the request that produced the audit record.
        callbacks.onFailure?.(error);
        this.options.onWriteFailure?.(error);
      });
    return true;
  }

  public request<TResult>(command: SqliteWorkerCommand): Promise<TResult> {
    const bytes = estimateCommandBytes(command);
    if (
      this.pending.size >= this.options.maxPendingCommands ||
      this.pendingBytes + bytes > this.options.maxPendingBytes ||
      this.exceedsShare(this.getUsage(['control']), bytes, CONTROL_QUEUE_SHARE)
    ) {
      return Promise.reject(new Error(`${this.options.name} control queue is full`));
    }
    return this.send(command, bytes, 'control') as Promise<TResult>;
  }

  public async close(timeoutMs = 2_000): Promise<void> {
    const worker = this.worker;
    if (!worker) {
      return;
    }

    try {
      await Promise.race([
        this.waitForIdle(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('SQLite worker shutdown timed out')), timeoutMs);
        }),
      ]);
      await this.request({ operation: 'shutdown', payload: null });
    } catch {
      // Termination below is the bounded fallback.
    }

    this.worker = null;
    this.alive = false;
    await worker.terminate();
    this.rejectPending(new Error(`${this.options.name} closed`));
  }

  private send(
    command: SqliteWorkerCommand,
    bytes: number,
    priority: SqliteWorkerPriority,
  ): Promise<unknown> {
    try {
      this.start();
    } catch (error) {
      return Promise.reject(error);
    }
    const worker = this.worker;
    if (!worker || !this.alive) {
      return Promise.reject(new Error(`${this.options.name} is unavailable`));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { bytes, command, id, priority, reject, resolve });
      this.pendingBytes += bytes;
      this.queues[priority].push(id);
      this.pump(worker);
    });
  }

  private pump(worker = this.worker): void {
    if (this.activeId !== null || !worker || !this.alive) {
      return;
    }
    const id = this.takeNextId();
    if (id === null) {
      this.resolveIdleWaiters();
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      this.pump(worker);
      return;
    }
    this.activeId = id;
    try {
      worker.postMessage({ ...pending.command, id });
    } catch (error) {
      this.settlePending(id);
      pending.reject(error);
      this.pump(worker);
    }
  }

  private takeNextId(): number | null {
    for (let offset = 0; offset < SCHEDULE.length; offset += 1) {
      const index = (this.scheduleIndex + offset) % SCHEDULE.length;
      const queue = this.queues[SCHEDULE[index]];
      const id = queue.shift();
      if (id !== undefined) {
        this.scheduleIndex = (index + 1) % SCHEDULE.length;
        return id;
      }
    }
    return null;
  }

  private handleReply(reply: WorkerReply): void {
    const pending = this.pending.get(reply.id);
    if (!pending) {
      return;
    }
    this.settlePending(reply.id);
    if (reply.error) {
      pending.reject(new Error(reply.error));
      this.pump();
      return;
    }
    pending.resolve(reply.result);
    this.pump();
  }

  private settlePending(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    this.pendingBytes = Math.max(0, this.pendingBytes - pending.bytes);
    if (this.activeId === id) {
      this.activeId = null;
    }
    if (this.pending.size === 0) {
      this.resolveIdleWaiters();
    }
  }

  private failWorker(error: Error): void {
    this.alive = false;
    this.worker = null;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.queues.model.length = 0;
    this.queues.auxiliary.length = 0;
    this.queues.background.length = 0;
    this.queues.control.length = 0;
    this.activeId = null;
    this.pendingBytes = 0;
    this.resolveIdleWaiters();
  }

  private getUsage(priorities: readonly SqliteWorkerPriority[]): {
    bytes: number;
    commands: number;
  } {
    let bytes = 0;
    let commands = 0;
    for (const pending of this.pending.values()) {
      if (priorities.includes(pending.priority)) {
        bytes += pending.bytes;
        commands += 1;
      }
    }
    return { bytes, commands };
  }

  private exceedsShare(
    usage: { bytes: number; commands: number },
    additionalBytes: number,
    share: number,
  ): boolean {
    return (
      usage.bytes + additionalBytes >
        Math.max(1, Math.floor(this.options.maxPendingBytes * share)) ||
      usage.commands >= Math.max(1, Math.floor(this.options.maxPendingCommands * share))
    );
  }

  private waitForIdle(): Promise<void> {
    if (this.pending.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private resolveIdleWaiters(): void {
    if (this.pending.size !== 0) {
      return;
    }
    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
  }
}

function createSqliteWorker(filename: string, options: WorkerOptions): Worker {
  return new Worker(filename, options);
}

function estimateCommandBytes(command: SqliteWorkerCommand): number {
  try {
    return Buffer.byteLength(JSON.stringify(command), 'utf-8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
