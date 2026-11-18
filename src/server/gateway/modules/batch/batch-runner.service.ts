import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { logger } from '@/shared/logging/logger';
import { DurableRecordStore } from '@/shared/persistence/durable-record-store';

import {
  executeBatchRequest,
  toBatchRequestError,
  type BatchExecutionTarget,
} from './batch-request-executor';
import {
  applyBatchExpiry,
  beginCancellation,
  claimRequest,
  endBatch,
  recordRequestOutcome,
  resetInterruptedRequests,
} from './batch-job-transitions';
import {
  BatchJobError,
  DEFAULT_BATCH_CONCURRENCY,
  DEFAULT_BATCH_TTL_MS,
  DEFAULT_COMPLETION_WINDOW_MS,
  DEFAULT_MAX_BATCHES,
  DEFAULT_MAX_REQUESTS_PER_BATCH,
  countBatchRequests,
  isTerminalBatchStatus,
  reviveBatchJob,
  type BatchDialect,
  type BatchJobRecord,
  type BatchRequestRecord,
  type BatchRunnerOptions,
} from './batch-job.types';

export const BATCH_RUNNER_OPTIONS = Symbol('BATCH_RUNNER_OPTIONS');

export interface CreateBatchInput {
  dialect: BatchDialect;
  endpoint: string;
  requests: Array<Pick<BatchRequestRecord, 'customId' | 'body' | 'model' | 'target'>>;
  completionWindow?: string;
  completionWindowMs?: number;
  displayName?: string;
  metadata?: Record<string, string>;
  /** OpenAI only: the local Files handle the input JSONL was read from. */
  inputFileId?: string;
}

/** Called once a batch finishes processing, before its terminal state is persisted. */
export type BatchFinalizer = (job: BatchJobRecord) => Promise<Partial<BatchJobRecord> | void>;

/**
 * A durable, bounded, restartable job queue over the proxy's own handlers.
 *
 * State lives in one {@link DurableRecordStore}, so a batch and every
 * per-request outcome survive a kill mid-flight: a fresh runner over the same
 * file rehydrates the queue, resets whatever was in flight back to pending and
 * carries on. A batch that died on restart would be worse than no batch API at
 * all, so resumption is the point rather than a nicety.
 *
 * Concurrency is deliberately small; see `DEFAULT_BATCH_CONCURRENCY`.
 */
@Injectable()
export class BatchRunnerService {
  private readonly store: DurableRecordStore<BatchJobRecord>;
  private readonly maxConcurrency: number;
  private readonly maxBatches: number;
  private readonly maxRequestsPerBatch: number;
  private readonly ttlMs: number;
  private readonly finalizers = new Map<BatchDialect, BatchFinalizer>();
  private readonly settled = new Set<Promise<void>>();
  private target?: BatchExecutionTarget;
  private running = 0;
  private resumed = false;

  constructor(@Optional() @Inject(BATCH_RUNNER_OPTIONS) options?: BatchRunnerOptions) {
    this.maxConcurrency = Math.max(1, options?.maxConcurrency ?? DEFAULT_BATCH_CONCURRENCY);
    this.maxBatches = Math.max(1, options?.maxBatches ?? DEFAULT_MAX_BATCHES);
    this.maxRequestsPerBatch = Math.max(
      1,
      options?.maxRequestsPerBatch ?? DEFAULT_MAX_REQUESTS_PER_BATCH,
    );
    this.ttlMs = options?.ttlMs ?? DEFAULT_BATCH_TTL_MS;
    this.store = new DurableRecordStore<BatchJobRecord>({
      ...(options?.filePath ? { filePath: options.filePath } : {}),
      maxEntries: this.maxBatches,
      ttlMs: this.ttlMs,
      revive: reviveBatchJob,
    });
  }

  /** Registers the dialect's "write the outputs" step, run before `completed`. */
  public registerFinalizer(dialect: BatchDialect, finalizer: BatchFinalizer): void {
    this.finalizers.set(dialect, finalizer);
  }

  public getMaxConcurrency(): number {
    return this.maxConcurrency;
  }

  public setExecutionTarget(target: BatchExecutionTarget): void {
    if (this.target && this.target !== target) {
      throw new Error('Batch execution target is already configured');
    }
    this.target = target;
  }

  public create(input: CreateBatchInput, now: number = Date.now()): BatchJobRecord {
    if (input.requests.length === 0) {
      throw BatchJobError.invalid('A batch needs at least one request');
    }
    if (input.requests.length > this.maxRequestsPerBatch) {
      throw BatchJobError.invalid(
        `A batch is limited to ${this.maxRequestsPerBatch} requests; ${input.requests.length} were submitted`,
      );
    }
    const seen = new Set<string>();
    for (const request of input.requests) {
      if (seen.has(request.customId)) {
        throw BatchJobError.invalid(`custom_id '${request.customId}' appears more than once`);
      }
      seen.add(request.customId);
    }

    const job: BatchJobRecord = {
      id: randomBytes(12).toString('hex'),
      dialect: input.dialect,
      endpoint: input.endpoint,
      status: 'validating',
      requests: input.requests.map((request) => ({ ...request, state: 'pending' })),
      createdAtMs: now,
      expiresAtMs: now + (input.completionWindowMs ?? DEFAULT_COMPLETION_WINDOW_MS),
      ...(input.completionWindow ? { completionWindow: input.completionWindow } : {}),
      ...(input.inputFileId ? { inputFileId: input.inputFileId } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    this.save(job, now);
    this.pump();
    return job;
  }

  /** The batch as it stands, or null. Expiry is applied on read, not on a timer. */
  public get(id: string): BatchJobRecord | null {
    this.resume();
    const job = this.store.get(id);
    if (!job) {
      return null;
    }
    return this.applyExpiry(job);
  }

  public require(id: string): BatchJobRecord {
    const job = this.get(id);
    if (!job) {
      throw BatchJobError.notFound(id);
    }
    return job;
  }

  /** Newest first, optionally narrowed to one dialect. */
  public list(dialect?: BatchDialect): BatchJobRecord[] {
    this.resume();
    return this.store
      .entries()
      .map((entry) => this.applyExpiry(entry.value))
      .filter((job) => !dialect || job.dialect === dialect)
      .sort((left, right) => right.createdAtMs - left.createdAtMs);
  }

  /**
   * Asks for cancellation.
   *
   * Requests that have not started are cancelled immediately. One already
   * dispatched upstream is not aborted -- the cost is already incurred and the
   * connection cannot be un-sent -- but its result is discarded and recorded as
   * `canceled`, which is why the batch sits in `cancelling` until it settles.
   */
  public cancel(id: string, now: number = Date.now()): BatchJobRecord {
    const job = this.require(id);
    if (isTerminalBatchStatus(job.status)) {
      throw BatchJobError.alreadyEnded(id, job.status);
    }
    beginCancellation(job, now);
    this.save(job, now);
    this.track(this.settle(job.id));
    return job;
  }

  public delete(id: string): boolean {
    this.resume();
    return this.store.delete(id);
  }

  /** Resolves once nothing is in flight and every scheduled write has landed. */
  public async drain(): Promise<void> {
    while (this.settled.size > 0) {
      await Promise.all([...this.settled]);
    }
    await this.store.flush();
  }

  /**
   * Forces every scheduled write to disk without waiting for in-flight work.
   * This is what "the process died here" looks like from the state file's side.
   */
  public flushState(): Promise<void> {
    return this.store.flush();
  }

  /** Keeps background work visible to {@link drain} rather than floating. */
  private track(work: Promise<void>): void {
    const tracked = work
      .catch((error: unknown) => logger.warn('Batch background step failed', error))
      .finally(() => this.settled.delete(tracked));
    this.settled.add(tracked);
  }

  /** Re-enqueues whatever the last process was working on. Runs once, lazily. */
  private resume(): void {
    if (this.resumed) {
      return;
    }
    this.resumed = true;
    const now = Date.now();
    for (const entry of this.store.entries(now)) {
      if (resetInterruptedRequests(entry.value)) {
        logger.info(`Resuming batch ${entry.value.id} after restart`);
        this.save(entry.value, now);
      }
    }
    this.pump();
  }

  /** Starts as many pending requests as the concurrency ceiling allows. */
  private pump(): void {
    this.resume();
    while (this.running < this.maxConcurrency) {
      const next = this.takeNextPending();
      if (!next) {
        return;
      }
      this.running += 1;
      const task = this.runOne(next.job, next.request).finally(() => {
        this.running -= 1;
        this.settled.delete(task);
        this.pump();
      });
      this.settled.add(task);
    }
  }

  private takeNextPending(): { job: BatchJobRecord; request: BatchRequestRecord } | null {
    const now = Date.now();
    // Oldest batch first, so a long queue cannot be starved by newer arrivals.
    const jobs = this.store
      .entries(now)
      .map((entry) => this.applyExpiry(entry.value))
      .sort((left, right) => left.createdAtMs - right.createdAtMs);

    for (const job of jobs) {
      if (isTerminalBatchStatus(job.status) || job.status === 'finalizing') {
        continue;
      }
      const request = job.requests.find((candidate) => candidate.state === 'pending');
      if (!request || job.status === 'cancelling') {
        this.track(this.settle(job.id));
        continue;
      }
      claimRequest(job, request, now);
      this.save(job, now);
      return { job, request };
    }
    return null;
  }

  /** Runs one request and writes its outcome back against its `custom_id`. */
  private async runOne(job: BatchJobRecord, request: BatchRequestRecord): Promise<void> {
    const result = this.target
      ? await executeBatchRequest(job, request, this.target)
      : ({
          outcome: 'errored' as const,
          error: {
            message: 'No batch execution target is available to run this request',
            code: 'api_error',
            httpStatus: 503,
          },
        } as const);

    const now = Date.now();
    const current = this.store.get(job.id);
    if (!current) {
      // The batch was deleted while this request was in flight; nothing to record.
      return;
    }
    const targetRequest =
      current.requests.find((candidate) => candidate.customId === request.customId) ?? request;
    recordRequestOutcome(current, targetRequest, result, now);
    this.save(current, now);
    await this.settle(current.id);
  }

  /** Moves a batch out of `in_progress` once nothing is left to run. */
  private async settle(id: string): Promise<void> {
    const job = this.store.get(id);
    if (!job || isTerminalBatchStatus(job.status) || job.status === 'finalizing') {
      return;
    }
    const counts = countBatchRequests(job);
    if (counts.processing > 0) {
      return;
    }

    const now = Date.now();
    const cancelling = job.status === 'cancelling';
    job.status = 'finalizing';
    job.finalizingAtMs = now;
    this.save(job, now);

    try {
      const finalized = await this.finalizers.get(job.dialect)?.(job);
      Object.assign(job, finalized ?? {});
    } catch (error) {
      logger.warn(`Failed to finalize batch ${job.id}`, error);
      const settledAt = Date.now();
      // The batch's own result could not be produced -- this is a batch-level
      // failure, not a per-request one, so it must not be reported `completed`.
      endBatch(job, cancelling, settledAt, { error: toBatchRequestError(error) });
      this.save(job, settledAt);
      return;
    }

    const settledAt = Date.now();
    endBatch(job, cancelling, settledAt);
    this.save(job, settledAt);
  }

  /** Applies the completion-window deadline on read, rather than on a timer. */
  private applyExpiry(job: BatchJobRecord, now: number = Date.now()): BatchJobRecord {
    if (applyBatchExpiry(job, now)) {
      this.save(job, now);
    }
    return job;
  }

  private save(job: BatchJobRecord, now: number): void {
    this.store.set(job.id, job, now);
  }
}
