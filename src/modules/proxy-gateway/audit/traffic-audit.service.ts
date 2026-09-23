import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { TrafficAuditConfig } from '@/modules/config/types';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { getServerConfig } from '@/server/server-config';
import { getProxyStateDir } from '@/shared/platform/paths';
import { preserveCorruptSqliteDatabase } from '@/shared/persistence/database/preserve-corrupt-sqlite';
import { BoundedSqliteWorker } from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';
import { logger } from '@/shared/logging/logger';
import {
  MAX_AUDIT_BODY_BYTES,
  sanitizeAuditHeaders,
  sanitizeAuditUrl,
  snapshotAuditPayload,
} from './audit-sanitizer';
import {
  AUDIT_BODY_CHUNK_BYTES,
  serializeAuditPayloadIncrementally,
} from './incremental-audit-serializer';
import {
  TrafficAuditListResultSchema,
  TrafficAuditBodyPageSchema,
  TrafficAuditBodySearchResultSchema,
  TrafficAuditDetailSchema,
  TrafficAuditFilterOptionsSchema,
  TrafficAuditStatsSchema,
  type CompleteAuditParentInput,
  type CompleteUpstreamAttemptInput,
  type StartAuditParentInput,
  type StartUpstreamAttemptInput,
  type TrafficAuditBodyPage,
  type TrafficAuditBodyPageInput,
  type TrafficAuditBodySearchInput,
  type TrafficAuditBodySearchResult,
  type TrafficAuditDetail,
  type TrafficAuditEvent,
  type TrafficAuditListInput,
  type TrafficAuditStats,
} from './traffic-audit.types';
import type { TrafficClass } from './traffic-classifier';
import type { TrafficAuditWorkerCommand } from './traffic-audit.worker-protocol';

const TRAFFIC_AUDIT_FILENAME = 'request-audit.db';
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

export interface AuditHandle {
  id: string;
  startedAt: number;
  trafficClass: TrafficClass;
}

export interface UpstreamAttemptHandle extends AuditHandle {
  attemptIndex: number;
  parentId: string;
}

export interface AuditSseBodyWriter {
  finish(input: {
    errorSummary?: string | null;
    parseErrorOffset?: number | null;
    partial?: boolean;
    rawBytes: number;
    terminalStatus: string;
  }): Promise<void>;
  write(chunk: string): boolean;
}

export interface DatabaseRepairResult {
  backupPath: string | null;
  repaired: boolean;
}

interface PendingDropStats {
  bytes: number;
  count: number;
  flushing: boolean;
  reason: string;
}

export class TrafficAuditService {
  private worker: BoundedSqliteWorker | null = null;
  private queueConfigKey = '';
  private readonly pendingDropStats = new Map<TrafficClass, PendingDropStats>();
  private lastDropReason: string | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private repairInProgress: Promise<DatabaseRepairResult> | null = null;
  private readonly activePayloadWrites = new Set<Promise<void>>();
  private readonly eventListeners = new Set<(event: TrafficAuditEvent) => void>();

  public subscribe(listener: (event: TrafficAuditEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  public isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  public startParent(input: StartAuditParentInput): AuditHandle | null {
    if (!this.isEnabled()) {
      return null;
    }

    const startedAt = Date.now();
    const handle = { id: randomUUID(), startedAt, trafficClass: input.trafficClass };
    const accepted = this.tryWrite(
      'insertParent',
      {
        clientIp: input.clientIp ?? null,
        id: handle.id,
        method: input.method,
        model: input.model ?? extractModel(input.requestBody),
        operation: input.operation ?? null,
        protocol: input.protocol,
        requestHeaders: JSON.stringify(sanitizeAuditHeaders(input.headers)),
        requestQuery: serializeQuery(input.query),
        sessionId: input.sessionId ?? null,
        timestamp: startedAt,
        trafficClass: input.trafficClass,
        url: sanitizeAuditUrl(input.url),
        username: input.username ?? null,
      },
      input.trafficClass,
    );
    if (!accepted) {
      return null;
    }
    this.emit({
      id: handle.id,
      kind: 'created',
      timestamp: startedAt,
      trafficClass: handle.trafficClass,
    });
    this.capturePayload({
      direction: 'request',
      ownerId: handle.id,
      ownerKind: 'parent',
      parentId: handle.id,
      trafficClass: handle.trafficClass,
      value: input.requestBody,
    });
    return handle;
  }

  public completeParent(handle: AuditHandle | null, input: CompleteAuditParentInput): void {
    if (!handle) {
      return;
    }
    const completedAt = Date.now();
    const accepted = this.tryWrite(
      'completeParent',
      {
        cachedTokens: input.usage?.cachedTokens ?? null,
        completedAt,
        durationMs: Math.max(0, completedAt - handle.startedAt),
        error: serializeError(input.error),
        id: handle.id,
        hasImageOutput: input.outputModalities?.hasImage ?? null,
        hasTextOutput: input.outputModalities?.hasText ?? null,
        inputTokens: input.usage?.inputTokens ?? null,
        mappedModel: input.mappedModel ?? null,
        outcome: input.outcome,
        outputTokens: input.usage?.outputTokens ?? null,
        reasoningTokens: input.usage?.reasoningTokens ?? null,
        responseHeaders: input.responseHeaders
          ? JSON.stringify(sanitizeAuditHeaders(input.responseHeaders))
          : null,
        responsePartial: input.partial ? 1 : 0,
        status: input.status ?? null,
      },
      handle.trafficClass,
    );
    if (accepted) {
      this.emit({
        id: handle.id,
        kind: 'updated',
        timestamp: completedAt,
        trafficClass: handle.trafficClass,
      });
    }
    if (!input.responsePayloadHandled) {
      this.capturePayload({
        direction: 'response',
        ownerId: handle.id,
        ownerKind: 'parent',
        parentId: handle.id,
        parseErrorOffset: input.parseErrorOffset,
        partial: input.partial,
        representation: input.responseRepresentation,
        terminalStatus: input.outcome,
        trafficClass: handle.trafficClass,
        value: input.responseBody,
      });
    }
  }

  public startAttempt(
    parent: AuditHandle | null,
    attemptIndex: number,
    input: StartUpstreamAttemptInput,
  ): UpstreamAttemptHandle | null {
    if (!parent || !this.isEnabled()) {
      return null;
    }
    const startedAt = Date.now();
    const handle = {
      attemptIndex,
      id: randomUUID(),
      parentId: parent.id,
      startedAt,
      trafficClass: parent.trafficClass,
    };
    const accepted = this.tryWrite(
      'insertAttempt',
      {
        accountId: input.accountId ?? null,
        accountIdHash: input.accountId ? sha256Hex(input.accountId) : null,
        attemptIndex,
        endpoint: sanitizeAuditUrl(input.endpoint),
        id: handle.id,
        model: input.model ?? extractModel(input.requestBody),
        operation: input.operation,
        parentId: parent.id,
        requestHeaders: JSON.stringify(sanitizeAuditHeaders(input.headers)),
        timestamp: startedAt,
      },
      parent.trafficClass,
    );
    if (!accepted) {
      return null;
    }
    this.emit({
      id: parent.id,
      kind: 'updated',
      timestamp: startedAt,
      trafficClass: parent.trafficClass,
    });
    this.capturePayload({
      direction: 'request',
      ownerId: handle.id,
      ownerKind: 'attempt',
      parentId: parent.id,
      trafficClass: parent.trafficClass,
      value: input.requestBody,
    });
    return handle;
  }

  public completeAttempt(
    handle: UpstreamAttemptHandle | null,
    input: CompleteUpstreamAttemptInput,
  ): void {
    if (!handle) {
      return;
    }
    const completedAt = Date.now();
    const accepted = this.tryWrite(
      'completeAttempt',
      {
        completedAt,
        durationMs: Math.max(0, completedAt - handle.startedAt),
        error: serializeError(input.error),
        id: handle.id,
        outcome: input.outcome,
        responseHeaders: input.responseHeaders
          ? JSON.stringify(sanitizeAuditHeaders(input.responseHeaders))
          : null,
        responsePartial: input.partial ? 1 : 0,
        status: input.status ?? null,
      },
      handle.trafficClass,
    );
    if (accepted) {
      this.emit({
        id: handle.parentId,
        kind: 'updated',
        timestamp: completedAt,
        trafficClass: handle.trafficClass,
      });
    }
    if (!input.responsePayloadHandled) {
      this.capturePayload({
        direction: 'response',
        ownerId: handle.id,
        ownerKind: 'attempt',
        parentId: handle.parentId,
        parseErrorOffset: input.parseErrorOffset,
        partial: input.partial,
        representation: input.responseRepresentation,
        terminalStatus: input.outcome,
        trafficClass: handle.trafficClass,
        value: input.responseBody,
      });
    }
  }

  public beginParentSse(handle: AuditHandle | null): AuditSseBodyWriter | null {
    return handle
      ? this.beginSsePayload({
          ownerId: handle.id,
          ownerKind: 'parent',
          parentId: handle.id,
          trafficClass: handle.trafficClass,
        })
      : null;
  }

  public beginAttemptSse(handle: UpstreamAttemptHandle | null): AuditSseBodyWriter | null {
    return handle
      ? this.beginSsePayload({
          ownerId: handle.id,
          ownerKind: 'attempt',
          parentId: handle.parentId,
          trafficClass: handle.trafficClass,
        })
      : null;
  }

  public async list(input: TrafficAuditListInput) {
    const result = await this.request('list', input);
    return TrafficAuditListResultSchema.parse(result);
  }

  public async filterOptions() {
    const result = await this.request('filterOptions', null);
    return TrafficAuditFilterOptionsSchema.parse(result);
  }

  public async detail(id: string): Promise<TrafficAuditDetail | null> {
    const result = await this.request('detail', { id });
    if (result === null) {
      return null;
    }
    return TrafficAuditDetailSchema.parse(result);
  }

  public async bodyPage(input: TrafficAuditBodyPageInput): Promise<TrafficAuditBodyPage | null> {
    const result = await this.request('bodyPage', input);
    return result === null ? null : TrafficAuditBodyPageSchema.parse(result);
  }

  public async *bodyContent(bodyId: string): AsyncGenerator<string> {
    let cursor = 0;
    while (true) {
      const page = await this.bodyPage({ bodyId, cursor, limitBytes: 256 * 1024 });
      if (!page) {
        return;
      }
      for (const chunk of page.chunks) {
        yield chunk.data;
      }
      if (page.complete || page.nextCursor === null) {
        return;
      }
      cursor = page.nextCursor;
    }
  }

  public async bodySearch(
    input: TrafficAuditBodySearchInput,
  ): Promise<TrafficAuditBodySearchResult> {
    return TrafficAuditBodySearchResultSchema.parse(await this.request('bodySearch', input));
  }

  public async stats(): Promise<TrafficAuditStats> {
    const persisted = TrafficAuditStatsSchema.omit({
      workerAlive: true,
      workerPendingBytes: true,
      workerPendingCommands: true,
    }).parse(await this.request('stats', null));
    const queue = this.ensureWorker().getStats();
    const unflushedDroppedCount = [...this.pendingDropStats.values()].reduce(
      (total, bucket) => total + bucket.count,
      0,
    );
    return TrafficAuditStatsSchema.parse({
      ...persisted,
      droppedCount: persisted.droppedCount + unflushedDroppedCount,
      lastDropReason: this.lastDropReason ?? persisted.lastDropReason,
      workerAlive: queue.alive,
      workerPendingBytes: queue.pendingBytes,
      workerPendingCommands: queue.pendingCommands,
    });
  }

  public async delete(id: string): Promise<number> {
    const affected = Number(await this.request('delete', { id }));
    this.recordAdminEvent('delete_request', affected, null);
    if (affected > 0) {
      this.emit({ id, kind: 'deleted', timestamp: Date.now() });
    }
    return affected;
  }

  public async clear(trafficClass: TrafficClass | null = null): Promise<number> {
    const affected = Number(await this.request('clear', { trafficClass }));
    this.recordAdminEvent('clear_requests', affected, null);
    this.emit({
      id: trafficClass ?? 'all',
      kind: 'cleared',
      timestamp: Date.now(),
      trafficClass: trafficClass ?? undefined,
    });
    return affected;
  }

  public async configure(config: TrafficAuditConfig): Promise<void> {
    const nextKey = `${config.max_queue_records}:${config.max_queue_mib}`;
    if (this.worker && nextKey !== this.queueConfigKey) {
      const old = this.worker;
      this.worker = null;
      await old.close();
    }
    await this.request('configure', toRetentionConfig(config));
    this.recordAdminEvent('configure_traffic_audit', null, null);
  }

  public async repair(): Promise<DatabaseRepairResult> {
    if (this.repairInProgress) {
      return this.repairInProgress;
    }
    const repair = this.performRepair().then(
      (result) => {
        this.repairInProgress = null;
        this.recordAdminEvent('repair_traffic_audit', null, null);
        return result;
      },
      (error: unknown) => {
        this.repairInProgress = null;
        throw error;
      },
    );
    this.repairInProgress = repair;
    return repair;
  }

  public recordAdminOperation(
    operation: string,
    affectedCount: number | null = null,
    error: unknown = null,
  ): void {
    this.recordAdminEvent(operation, affectedCount, error);
  }

  public async close(): Promise<void> {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    if (this.activePayloadWrites.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.activePayloadWrites]),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      await worker.close();
    }
  }

  private capturePayload(input: {
    direction: 'request' | 'response';
    ownerId: string;
    ownerKind: 'parent' | 'attempt';
    parentId: string;
    parseErrorOffset?: number;
    partial?: boolean;
    representation?: 'reconstructed_sse' | 'redacted_raw_sse';
    terminalStatus?: string;
    trafficClass: TrafficClass;
    value: unknown;
  }): void {
    const id = randomUUID();
    const kind = quickPayloadKind(input.value);
    const representation = input.representation ?? defaultRepresentation(kind);
    if (
      !this.tryWrite(
        'beginPayload',
        {
          createdAt: Date.now(),
          direction: input.direction,
          id,
          kind,
          ownerId: input.ownerId,
          ownerKind: input.ownerKind,
          parentId: input.parentId,
          representation,
        },
        input.trafficClass,
      )
    ) {
      return;
    }

    const task = this.writePayload(id, input).finally(() => {
      this.activePayloadWrites.delete(task);
    });
    this.activePayloadWrites.add(task);
  }

  private beginSsePayload(input: {
    ownerId: string;
    ownerKind: 'parent' | 'attempt';
    parentId: string;
    trafficClass: TrafficClass;
  }): AuditSseBodyWriter | null {
    const id = randomUUID();
    if (
      !this.tryWrite(
        'beginPayload',
        {
          createdAt: Date.now(),
          direction: 'response',
          id,
          kind: 'sse',
          ownerId: input.ownerId,
          ownerKind: input.ownerKind,
          parentId: input.parentId,
          representation: 'redacted_raw_sse',
        },
        input.trafficClass,
      )
    ) {
      return null;
    }

    const inFlight = new Set<Promise<boolean>>();
    const hash = createHash('sha256');
    let dropped = false;
    let finished = false;
    let logicalBytes = 0;
    let sequence = 0;
    let storedBytes = 0;
    let resolveLifecycle!: () => void;
    const lifecycle = new Promise<void>((resolve) => {
      resolveLifecycle = resolve;
    });
    this.activePayloadWrites.add(lifecycle);
    return {
      finish: async (finishInput) => {
        if (finished) {
          return;
        }
        finished = true;
        try {
          const results = await Promise.all([...inFlight]);
          dropped = dropped || results.some((accepted) => !accepted);
          if (dropped) {
            this.recordDrop('sse_chunk_queue_or_write_failure', 0, input.trafficClass);
          }
          const finalized = await this.tryWriteAcknowledged(
            'finalizeSsePayload',
            {
              completedAt: Date.now(),
              droppedReason: dropped ? 'sse_chunk_queue_or_write_failure' : null,
              errorSummary: finishInput.errorSummary ?? null,
              id,
              parseErrorOffset: finishInput.parseErrorOffset ?? null,
              partial: finishInput.partial || dropped ? 1 : 0,
              rawBytes: finishInput.rawBytes,
              sanitizedBytes: logicalBytes,
              sanitizedSha256: logicalBytes > 0 ? hash.digest('hex') : null,
              terminalStatus: finishInput.terminalStatus,
            },
            input.trafficClass,
          );
          if (!finalized) {
            this.recordDrop('sse_finalize_queue_or_write_failure', 0, input.trafficClass);
          }
        } finally {
          this.activePayloadWrites.delete(lifecycle);
          resolveLifecycle();
        }
      },
      write: (chunk) => {
        if (finished) {
          return false;
        }
        const bytes = Buffer.from(chunk, 'utf8');
        hash.update(bytes);
        logicalBytes += bytes.byteLength;
        if (dropped) {
          return false;
        }
        const remaining = Math.max(0, MAX_AUDIT_BODY_BYTES - storedBytes);
        if (remaining === 0) {
          return true;
        }
        const prefix = utf8Prefix(bytes, remaining);
        for (const piece of splitUtf8Chunks(prefix.toString('utf8'))) {
          // The worker queue already enforces both record and byte limits without blocking the
          // model path. A second tiny in-flight cap here would drop ordinary multi-event SSE
          // responses before the configured queue is actually full.
          const write = this.tryWriteAcknowledged(
            'appendPayloadChunk',
            {
              data: piece,
              payloadId: id,
              sequence,
            },
            input.trafficClass,
          );
          if (!write) {
            dropped = true;
            return false;
          }
          sequence += 1;
          storedBytes += Buffer.byteLength(piece, 'utf8');
          inFlight.add(write);
          void write.finally(() => inFlight.delete(write));
        }
        return true;
      },
    };
  }

  private async writePayload(
    id: string,
    input: {
      parseErrorOffset?: number;
      partial?: boolean;
      terminalStatus?: string;
      trafficClass: TrafficClass;
      value: unknown;
    },
  ): Promise<void> {
    const inFlight = new Set<Promise<boolean>>();
    let dropped = false;
    let droppedBytes = 0;
    try {
      const result = await serializeAuditPayloadIncrementally(
        input.value,
        async (data, sequence) => {
          if (dropped) {
            droppedBytes += Buffer.byteLength(data, 'utf-8');
            return false;
          }
          while (inFlight.size >= 4) {
            const accepted = await Promise.race(inFlight);
            if (!accepted) {
              dropped = true;
              droppedBytes += Buffer.byteLength(data, 'utf-8');
              return false;
            }
          }
          const write = this.tryWriteAcknowledged(
            'appendPayloadChunk',
            {
              data,
              payloadId: id,
              sequence,
            },
            input.trafficClass,
          );
          if (!write) {
            dropped = true;
            droppedBytes += Buffer.byteLength(data, 'utf-8');
            return false;
          }
          inFlight.add(write);
          void write.finally(() => inFlight.delete(write));
          return true;
        },
      );
      const settled = await Promise.all([...inFlight]);
      dropped = dropped || settled.some((accepted) => !accepted);
      if (dropped) {
        this.recordDrop('body_chunk_queue_or_write_failure', droppedBytes, input.trafficClass);
      }
      this.tryWrite(
        'finalizePayload',
        {
          completedAt: Date.now(),
          droppedReason: dropped ? 'body_chunk_queue_or_write_failure' : null,
          errorSummary: input.parseErrorOffset === undefined ? null : 'SSE event parsing failed',
          id,
          logicalBytes: result.logicalBytes,
          oversized: result.oversized ? 1 : 0,
          parseErrorOffset: input.parseErrorOffset ?? null,
          partial: input.partial || result.oversized || dropped ? 1 : 0,
          rawBytes: null,
          sha256: result.sha256,
          sha256Scope: 'full',
          state: dropped ? 'incomplete' : 'complete',
          terminalStatus: input.terminalStatus ?? null,
        },
        input.trafficClass,
      );
    } catch (error) {
      this.recordDrop('body_serialization_failure', 0, input.trafficClass);
      logger.warn('Traffic audit body serialization failed', error);
      this.tryWrite(
        'finalizePayload',
        {
          completedAt: Date.now(),
          droppedReason: 'body_serialization_failure',
          errorSummary:
            error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
          id,
          logicalBytes: 0,
          oversized: 0,
          parseErrorOffset: input.parseErrorOffset ?? null,
          partial: 1,
          rawBytes: null,
          sha256: null,
          sha256Scope: 'unavailable',
          state: 'incomplete',
          terminalStatus: input.terminalStatus ?? null,
        },
        input.trafficClass,
      );
    }
  }

  private tryWriteAcknowledged<TOperation extends TrafficAuditWorkerCommand['operation']>(
    operation: TOperation,
    payload: Extract<TrafficAuditWorkerCommand, { operation: TOperation }>['payload'],
    trafficClass: TrafficClass,
  ): Promise<boolean> | null {
    if (this.repairInProgress) {
      return null;
    }
    let resolve!: (accepted: boolean) => void;
    const completion = new Promise<boolean>((settle) => {
      resolve = settle;
    });
    try {
      const accepted = this.ensureWorker().tryWrite(
        { operation, payload },
        {
          onFailure: () => resolve(false),
          onSuccess: () => resolve(true),
          priority: toWorkerPriority(trafficClass),
        },
      );
      if (!accepted) {
        this.recordDrop('queue_capacity', 0, trafficClass);
        return null;
      }
      return completion;
    } catch (error) {
      this.recordDrop('worker_unavailable', 0, trafficClass);
      logger.warn('Traffic audit write was skipped', error);
      return null;
    }
  }

  private ensureWorker(): BoundedSqliteWorker {
    if (this.worker?.getStats().alive) {
      return this.worker;
    }
    this.worker = null;
    const config = this.getConfig();
    const stateDir = getProxyStateDir();
    fs.mkdirSync(stateDir, { recursive: true });
    this.queueConfigKey = `${config.max_queue_records}:${config.max_queue_mib}`;
    this.worker = new BoundedSqliteWorker({
      databasePath: path.join(stateDir, TRAFFIC_AUDIT_FILENAME),
      maxPendingBytes: config.max_queue_mib * 1024 * 1024,
      maxPendingCommands: config.max_queue_records,
      name: 'traffic-audit-sqlite',
      onWriteFailure: (error) => {
        this.recordDrop('worker_write_failure');
        logger.warn('Traffic audit worker write failed', error);
      },
      workerPath: path.join(__dirname, 'traffic-audit.worker.js'),
    });
    this.worker.start();
    this.scheduleMaintenance();
    this.request('maintenance', toRetentionConfig(config)).catch((error) => {
      logger.warn('Traffic audit startup maintenance failed', error);
    });
    return this.worker;
  }

  private scheduleMaintenance(): void {
    if (this.maintenanceTimer) {
      return;
    }
    this.maintenanceTimer = setInterval(() => {
      this.request('maintenance', toRetentionConfig(this.getConfig())).catch((error) => {
        logger.warn('Traffic audit maintenance failed', error);
      });
    }, MAINTENANCE_INTERVAL_MS);
    this.maintenanceTimer.unref();
  }

  private tryWrite<TOperation extends TrafficAuditWorkerCommand['operation']>(
    operation: TOperation,
    payload: Extract<TrafficAuditWorkerCommand, { operation: TOperation }>['payload'],
    trafficClass: TrafficClass = 'system',
  ): boolean {
    if (this.repairInProgress) {
      this.recordDrop('database_repair', 0, trafficClass);
      return false;
    }
    try {
      this.flushDropStats();
      if (
        this.ensureWorker().tryWrite(
          { operation, payload },
          { priority: toWorkerPriority(trafficClass) },
        )
      ) {
        return true;
      }
      this.recordDrop('queue_capacity', 0, trafficClass);
      return false;
    } catch (error) {
      this.recordDrop('worker_unavailable', 0, trafficClass);
      logger.warn('Traffic audit write was skipped', error);
      return false;
    }
  }

  private async request<
    TOperation extends TrafficAuditWorkerCommand['operation'],
    TResult = unknown,
  >(
    operation: TOperation,
    payload: Extract<TrafficAuditWorkerCommand, { operation: TOperation }>['payload'],
  ): Promise<TResult> {
    if (this.repairInProgress) {
      await this.repairInProgress;
    }
    return this.ensureWorker().request<TResult>({ operation, payload });
  }

  private async performRepair(): Promise<DatabaseRepairResult> {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      await worker.close();
    }

    const databasePath = path.join(getProxyStateDir(), TRAFFIC_AUDIT_FILENAME);
    const backupPath = preserveCorruptSqliteDatabase(databasePath);
    await this.ensureWorker().request({ operation: 'stats', payload: null });
    return { backupPath, repaired: true };
  }

  private recordDrop(
    reason: string,
    droppedBytes = 0,
    trafficClass: TrafficClass = 'system',
  ): void {
    const bucket = this.pendingDropStats.get(trafficClass) ?? {
      bytes: 0,
      count: 0,
      flushing: false,
      reason,
    };
    bucket.count += 1;
    bucket.bytes += droppedBytes;
    bucket.reason = reason;
    this.pendingDropStats.set(trafficClass, bucket);
    this.lastDropReason = reason;
  }

  private flushDropStats(): void {
    if (!this.worker) {
      return;
    }
    for (const [trafficClass, bucket] of this.pendingDropStats) {
      if (bucket.count <= 0 || bucket.flushing) {
        continue;
      }
      const count = bucket.count;
      const droppedBytes = bucket.bytes;
      const reason = bucket.reason;
      bucket.flushing = true;
      const accepted = this.worker.tryWrite(
        {
          operation: 'drop',
          payload: { count, droppedBytes, lastSeen: Date.now(), reason, trafficClass },
        },
        {
          onFailure: () => {
            bucket.flushing = false;
          },
          onSuccess: () => {
            bucket.count = Math.max(0, bucket.count - count);
            bucket.bytes = Math.max(0, bucket.bytes - droppedBytes);
            bucket.flushing = false;
            if ([...this.pendingDropStats.values()].every((entry) => entry.count === 0)) {
              this.lastDropReason = null;
            }
          },
          priority: 'background',
        },
      );
      if (!accepted) {
        bucket.flushing = false;
      }
    }
  }

  private recordAdminEvent(operation: string, affectedCount: number | null, error: unknown): void {
    const timestamp = Date.now();
    const accepted = this.tryWrite('adminEvent', {
      affectedCount,
      error: serializeError(error),
      operation,
      outcome: error ? 'internal_error' : 'completed',
      timestamp,
    });
    if (accepted) {
      this.emit({
        id: `admin:${timestamp}`,
        kind: 'created',
        timestamp,
        trafficClass: 'system',
      });
    }
  }

  private emit(event: TrafficAuditEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn('Traffic audit event listener failed', error);
      }
    }
  }

  private getConfig(): TrafficAuditConfig {
    return getServerConfig()?.traffic_audit ?? DEFAULT_APP_CONFIG.proxy.traffic_audit;
  }
}

export const trafficAuditService = new TrafficAuditService();

function toRetentionConfig(config: TrafficAuditConfig) {
  return {
    bodyRetentionHours: config.body_retention_hours,
    maxDiskBytes: config.max_disk_mib * 1024 * 1024,
    maxRows: config.max_rows,
    summaryRetentionDays: config.summary_retention_days,
  };
}

function toWorkerPriority(trafficClass: TrafficClass): 'model' | 'auxiliary' | 'background' {
  if (trafficClass === 'model') {
    return 'model';
  }
  if (trafficClass === 'auxiliary') {
    return 'auxiliary';
  }
  return 'background';
}

function serializeQuery(query: Record<string, unknown> | string | undefined): string | null {
  if (query === undefined) {
    return null;
  }
  if (typeof query === 'string') {
    return sanitizeAuditUrl(`/?${query}`).slice(2);
  }
  return snapshotAuditPayload(query, 1024 * 1024).text;
}

function serializeError(error: unknown): string | null {
  if (error === undefined || error === null) {
    return null;
  }
  if (error instanceof Error) {
    return snapshotAuditPayload({ message: error.message, name: error.name, stack: error.stack })
      .text;
  }
  return snapshotAuditPayload(error).text;
}

function extractModel(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const model = Reflect.get(body, 'model');
  if (typeof model === 'string') {
    return model;
  }
  const nested = Reflect.get(body, 'request');
  return nested && typeof nested === 'object' && typeof Reflect.get(nested, 'model') === 'string'
    ? String(Reflect.get(nested, 'model'))
    : null;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function quickPayloadKind(value: unknown): 'empty' | 'json' | 'text' | 'binary' | 'sse' {
  if (value === undefined || value === null) {
    return 'empty';
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return 'binary';
  }
  return typeof value === 'string' ? 'text' : 'json';
}

function defaultRepresentation(
  kind: 'empty' | 'json' | 'text' | 'binary' | 'sse',
): 'sanitized_json' | 'sanitized_text' | 'binary_summary' {
  if (kind === 'binary') {
    return 'binary_summary';
  }
  return kind === 'text' ? 'sanitized_text' : 'sanitized_json';
}

function splitUtf8Chunks(value: string): string[] {
  const bytes = Buffer.from(value, 'utf-8');
  const output: string[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    let end = Math.min(offset + AUDIT_BODY_CHUNK_BYTES, bytes.byteLength);
    if (end < bytes.byteLength) {
      while (end > offset && (bytes[end] & 0xc0) === 0x80) {
        end -= 1;
      }
      if (end === offset) {
        end = Math.min(offset + AUDIT_BODY_CHUNK_BYTES, bytes.byteLength);
      }
    }
    output.push(bytes.subarray(offset, end).toString('utf-8'));
    offset = end;
  }
  return output;
}

function utf8Prefix(value: Buffer, maxBytes: number): Buffer {
  if (value.byteLength <= maxBytes) {
    return value;
  }
  let end = maxBytes;
  while (end > 0 && (value[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return value.subarray(0, end);
}
