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
import { readCurrentCloudAccountUsageIdentity } from '@/modules/cloud-account/incarnation';
import { DiagnosticStoreShutdown } from '../diagnostics/store-shutdown';
import {
  MAX_AUDIT_BODY_BYTES,
  sanitizeAuditHeaders,
  serializeAuditQuery,
  redactUrlCredentials,
  sanitizeAuditUrl,
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
import {
  TrafficAuditMaintenanceResultSchema,
  type TrafficAuditWorkerCommand,
} from './traffic-audit.worker-protocol';
import { DiagnosticMaintenanceScheduler } from '../diagnostics/maintenance-scheduler';
import { createPreparedAuditPayloadWriter } from './prepared-audit-payload';
import { extractAuditModel, serializeAuditError } from './audit-parent-metadata';
import { TrafficAuditDropStats } from './traffic-audit-drop-stats';
import { auditDiskRejection } from './traffic-audit-disk-budget';
import { AuditCaptureGenerations } from './audit-capture-generations';
import { auditBodyForExport } from './audit-body-export';
import { auditSessionForExport } from './audit-session-export';
import { auditHarForExport } from './audit-har-export';
import { AuditSessionSnapshotSchema } from './audit-session-export.schema';
import {
  UsageTrendsInputSchema,
  UsageTrendsResultSchema,
  type UsageTrendsInput,
} from './usage-trends.schema';
import {
  UsageRangeInputSchema,
  UsageRangeResultSchema,
  type UsageRangeInput,
} from './usage-range.schema';
import type { IncrementalAuditPayloadKind } from './incremental-audit-serializer';
import { extractAuditUsage } from './audit-usage';

const TRAFFIC_AUDIT_FILENAME = 'request-audit.db';

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

export class TrafficAuditService {
  private readonly generations = new AuditCaptureGenerations();
  private readonly terminal = new DiagnosticStoreShutdown();
  private worker: BoundedSqliteWorker | null = null;
  private readonly dropStats = new TrafficAuditDropStats();
  private readonly maintenance = new DiagnosticMaintenanceScheduler(
    async () =>
      TrafficAuditMaintenanceResultSchema.parse(
        await this.request('maintenance', toRetentionConfig(this.getConfig())),
      ),
    (error) => logger.warn('Traffic audit maintenance failed', error),
  );
  private repairInProgress: Promise<DatabaseRepairResult> | null = null;
  private readonly activePayloadWrites = new Set<Promise<void>>();
  private readonly eventListeners = new Set<(event: TrafficAuditEvent) => void>();

  public subscribe(listener: (event: TrafficAuditEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  public isEnabled(): boolean {
    return this.terminal.acceptsWork() && this.getConfig().enabled;
  }

  public captureGeneration(trafficClass: TrafficClass): number {
    return this.generations.current(trafficClass);
  }

  public startParent(input: StartAuditParentInput): AuditHandle | null {
    if (!this.isEnabled()) {
      return null;
    }
    if (
      !this.generations.accepts(
        input.trafficClass,
        input.captureGeneration ?? this.generations.current(input.trafficClass),
      )
    ) {
      this.recordDrop('audit_clear_in_progress', 0, input.trafficClass);
      return null;
    }

    const startedAt = input.startedAt ?? Date.now();
    const handle = this.generations.track({
      id: randomUUID(),
      startedAt,
      trafficClass: input.trafficClass,
    });
    const accepted = this.tryWrite(
      'insertParent',
      {
        clientIp: input.clientIp ?? null,
        id: handle.id,
        method: input.method,
        model: input.model ?? extractAuditModel(input.requestBody),
        operation: input.operation ?? null,
        protocol: input.protocol,
        requestHeaders: JSON.stringify(sanitizeAuditHeaders(input.headers)),
        requestQuery: serializeAuditQuery(input.query),
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
    if (!input.requestPayloadHandled) {
      this.capturePayload({
        direction: 'request',
        ownerId: handle.id,
        ownerKind: 'parent',
        parentId: handle.id,
        trafficClass: handle.trafficClass,
        value: input.requestBody,
      });
    }
    return handle;
  }

  public beginPreparedParentPayload(
    parent: AuditHandle,
    direction: 'request' | 'response',
    kind: IncrementalAuditPayloadKind,
  ) {
    this.terminal.requireAdmission();
    return createPreparedAuditPayloadWriter(
      parent,
      direction,
      kind,
      async (command) =>
        this.generations.isCurrent(parent) &&
        ((await this.tryWriteAcknowledged(
          command.operation,
          command.payload,
          parent.trafficClass,
        )) ??
          false),
    );
  }

  public completeParent(handle: AuditHandle | null, input: CompleteAuditParentInput): void {
    if (!handle || !this.terminal.acceptsWork() || !this.generations.isCurrent(handle)) {
      return;
    }
    const completedAt = Date.now();
    // Establish body ownership before completion makes this request eligible for eviction.
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

    const accepted = this.tryWrite(
      'completeParent',
      {
        cachedTokens: input.usage?.cachedTokens ?? null,
        sessionId: input.sessionId,
        completedAt,
        durationMs: Math.max(0, completedAt - handle.startedAt),
        error:
          input.errorSummary === undefined ? serializeAuditError(input.error) : input.errorSummary,
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
  }

  public startAttempt(
    parent: AuditHandle | null,
    attemptIndex: number,
    input: StartUpstreamAttemptInput,
  ): UpstreamAttemptHandle | null {
    if (!parent || !this.isEnabled() || !this.generations.isCurrent(parent)) {
      return null;
    }
    const startedAt = Date.now();
    const handle = this.generations.track({
      attemptIndex,
      id: randomUUID(),
      parentId: parent.id,
      startedAt,
      trafficClass: parent.trafficClass,
    });
    const accepted = this.tryWrite(
      'insertAttempt',
      {
        accountId: input.accountId ?? null,
        accountIdHash: input.accountId ? sha256Hex(input.accountId) : null,
        accountGenerationHash: input.accountGenerationHash ?? null,
        accountSubjectHash: input.accountSubjectHash ?? null,
        accountGrantHash: input.accountGrantHash ?? null,
        usageScope: input.usageScope ?? null,
        attemptIndex,
        endpoint: sanitizeAuditUrl(input.endpoint),
        id: handle.id,
        model: input.model ?? extractAuditModel(input.requestBody),
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
    if (!handle || !this.terminal.acceptsWork() || !this.generations.isCurrent(handle)) {
      return;
    }
    const completedAt = Date.now();
    const usage = input.usage ?? extractAuditUsage(input.responseBody);
    // Establish body ownership before completion makes this request eligible for eviction.
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

    const accepted = this.tryWrite(
      'completeAttempt',
      {
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        cachedTokens: usage?.cachedTokens ?? null,
        reasoningTokens: usage?.reasoningTokens ?? null,
        completedAt,
        durationMs: Math.max(0, completedAt - handle.startedAt),
        error: serializeAuditError(input.error),
        id: handle.id,
        outcome: input.outcome,
        timing: input.timing ?? null,
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
  }

  public beginParentSse(handle: AuditHandle | null): AuditSseBodyWriter | null {
    return handle && this.generations.isCurrent(handle)
      ? this.beginSsePayload({
          ownerId: handle.id,
          ownerKind: 'parent',
          parentId: handle.id,
          trafficClass: handle.trafficClass,
        })
      : null;
  }

  public beginAttemptSse(handle: UpstreamAttemptHandle | null): AuditSseBodyWriter | null {
    return handle && this.generations.isCurrent(handle)
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
    const parsed = TrafficAuditListResultSchema.parse(result);
    return {
      ...parsed,
      items: parsed.items.map((item) => ({ ...item, url: sanitizeAuditUrl(item.url) })),
    };
  }

  public async filterOptions() {
    const result = await this.request('filterOptions', null);
    return TrafficAuditFilterOptionsSchema.parse(result);
  }

  public async usageTrends(input: UsageTrendsInput) {
    return UsageTrendsResultSchema.parse(
      await this.request('usageTrends', {
        ...UsageTrendsInputSchema.parse(input),
        asOf: Date.now(),
      }),
    );
  }

  public async usageRange(input: UsageRangeInput) {
    try {
      const range = UsageRangeInputSchema.parse(input);
      const identity = await readCurrentCloudAccountUsageIdentity(range.accountId);
      if (!identity) {
        throw new Error('Current account incarnation is unavailable for retained usage');
      }
      const result = UsageRangeResultSchema.parse(
        await this.request('usageRange', {
          range,
          ...identity,
          asOf: Date.now(),
        }),
      );
      const current = await readCurrentCloudAccountUsageIdentity(range.accountId);
      if (
        !current ||
        current.accountGenerationHash !== identity.accountGenerationHash ||
        current.accountSubjectHash !== identity.accountSubjectHash ||
        current.accountGrantHash !== identity.accountGrantHash
      ) {
        throw new Error('Account incarnation changed during retained usage query');
      }
      return result;
    } catch (error) {
      logger.warn('Retained usage query failed', error);
      throw error;
    }
  }

  public async detail(id: string): Promise<TrafficAuditDetail | null> {
    const result = await this.request('detail', { id });
    if (result === null) {
      return null;
    }
    const detail = TrafficAuditDetailSchema.parse(result);
    if (detail.recordKind !== 'request') {
      return detail;
    }
    return {
      ...detail,
      request: {
        ...detail.request,
        url: sanitizeAuditUrl(detail.request.url),
        requestQuery: serializeAuditQuery(detail.request.requestQuery),
        error: detail.request.error === null ? null : redactUrlCredentials(detail.request.error),
      },
      attempts: detail.attempts.map((attempt) => ({
        ...attempt,
        endpoint: sanitizeAuditUrl(attempt.endpoint),
        error: attempt.error === null ? null : redactUrlCredentials(attempt.error),
      })),
    };
  }

  public async bodyPage(input: TrafficAuditBodyPageInput): Promise<TrafficAuditBodyPage | null> {
    const result = await this.request('bodyPage', input);
    return result === null ? null : TrafficAuditBodyPageSchema.parse(result);
  }

  public bodyContent(bodyId: string): AsyncGenerator<string> {
    return auditBodyForExport(bodyId, (input) => this.bodyPage(input));
  }

  public harContent(requestId: string): AsyncGenerator<string> {
    return auditHarForExport(requestId, {
      detail: (id) => this.detail(id),
      body: (id) => this.bodyContent(id),
    });
  }

  public sessionContent(sessionId: string): AsyncGenerator<string> {
    return auditSessionForExport(sessionId, {
      snapshot: async (id) =>
        AuditSessionSnapshotSchema.parse(await this.request('sessionSnapshot', { sessionId: id })),
      detail: (id) => this.detail(id),
      body: (id) => this.bodyContent(id),
    });
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
    return TrafficAuditStatsSchema.parse({
      ...persisted,
      droppedCount: persisted.droppedCount + this.dropStats.count,
      lastDropReason: this.dropStats.lastReason ?? persisted.lastDropReason,
      workerAlive: queue.alive,
      maintenanceState: this.maintenance.state(),
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
    const barrier = this.generations.beginClear(trafficClass);
    let affected: number;
    try {
      affected = Number(
        await this.dropStats.reset(trafficClass, () =>
          this.request('clear', { trafficClass, generations: barrier.generations }),
        ),
      );
    } finally {
      barrier.finish();
    }
    this.recordAdminEvent('clear_requests', affected, null);
    this.emit({
      id: trafficClass ?? 'all',
      kind: 'cleared',
      timestamp: Date.now(),
      trafficClass: trafficClass ?? undefined,
    });
    return affected;
  }

  public async resetDropStats(trafficClass: TrafficClass | null = null): Promise<number> {
    const affected = Number(
      await this.dropStats.reset(trafficClass, () =>
        this.request('resetDropStats', { trafficClass }),
      ),
    );
    this.recordAdminEvent('reset_drop_stats', affected, null);
    this.emit({
      id: trafficClass ? `reset-drops:${trafficClass}` : 'reset-drops:all',
      kind: 'updated',
      timestamp: Date.now(),
      trafficClass: trafficClass ?? undefined,
    });
    return affected;
  }

  public async configure(config: TrafficAuditConfig): Promise<void> {
    this.terminal.requireAdmission();
    const result = TrafficAuditMaintenanceResultSchema.parse(
      await this.request('configure', toRetentionConfig(config)),
    );
    this.worker?.setQueueLimits({
      maxPendingBytes: config.max_queue_mib * 1024 * 1024,
      maxPendingCommands: config.max_queue_records,
    });
    this.maintenance.continueFrom(result);
    this.recordAdminEvent('configure_traffic_audit', null, null);
  }

  public async repair(): Promise<DatabaseRepairResult> {
    this.terminal.requireAdmission();
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
    if (!this.terminal.acceptsWork()) {
      return;
    }
    this.recordAdminEvent(operation, affectedCount, error);
  }

  public shutdown(): Promise<void> {
    this.maintenance.stop();
    return this.terminal.run(
      async () => {
        await this.repairInProgress;
        await Promise.all([...this.activePayloadWrites]);
      },
      async () => {
        const worker = this.worker;
        this.worker = null;
        try {
          await worker?.close();
        } finally {
          this.eventListeners.clear();
        }
      },
    );
  }

  public async close(): Promise<void> {
    this.maintenance.stop();
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
    const generation = this.generations.current(input.trafficClass);
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

    const task = this.writePayload(id, input, generation).finally(() => {
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
    if (!this.isEnabled()) {
      return null;
    }
    const id = randomUUID();
    const generation = this.generations.current(input.trafficClass);
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
    let chunkFailureReason: string | null = null;
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
          if (!this.generations.accepts(input.trafficClass, generation)) {
            return;
          }
          const results = await Promise.all([...inFlight]);
          if (!this.generations.accepts(input.trafficClass, generation)) {
            return;
          }
          dropped = dropped || results.some((accepted) => !accepted);
          if (dropped) {
            this.recordDrop(
              chunkFailureReason ?? 'sse_chunk_queue_or_write_failure',
              0,
              input.trafficClass,
            );
          }
          const finalized = await this.tryWriteAcknowledged(
            'finalizeSsePayload',
            {
              completedAt: Date.now(),
              droppedReason: dropped
                ? (chunkFailureReason ?? 'sse_chunk_queue_or_write_failure')
                : null,
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
        if (
          finished ||
          !this.terminal.acceptsWork() ||
          !this.generations.accepts(input.trafficClass, generation)
        ) {
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
            (reason) => {
              chunkFailureReason ??= reason;
            },
          );
          if (!write) {
            dropped = true;
            return false;
          }
          sequence += 1;
          storedBytes += Buffer.byteLength(piece, 'utf8');
          inFlight.add(write);
          void write.then((accepted) => {
            dropped ||= !accepted;
            inFlight.delete(write);
          });
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
    generation: number,
  ): Promise<void> {
    const inFlight = new Set<Promise<boolean>>();
    let dropped = false;
    let droppedBytes = 0;
    let chunkFailureReason: string | null = null;
    try {
      const result = await serializeAuditPayloadIncrementally(
        input.value,
        async (data, sequence) => {
          if (!this.generations.accepts(input.trafficClass, generation)) {
            return false;
          }
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
          if (!this.generations.accepts(input.trafficClass, generation)) {
            return false;
          }
          const write = this.tryWriteAcknowledged(
            'appendPayloadChunk',
            {
              data,
              payloadId: id,
              sequence,
            },
            input.trafficClass,
            (reason) => {
              chunkFailureReason ??= reason;
            },
          );
          if (!write) {
            dropped = true;
            droppedBytes += Buffer.byteLength(data, 'utf-8');
            return false;
          }
          inFlight.add(write);
          void write.then((accepted) => {
            dropped ||= !accepted;
            inFlight.delete(write);
          });
          return true;
        },
      );
      const settled = await Promise.all([...inFlight]);
      if (!this.generations.accepts(input.trafficClass, generation)) {
        return;
      }
      dropped = dropped || settled.some((accepted) => !accepted);
      if (dropped) {
        this.recordDrop(
          chunkFailureReason ?? 'body_chunk_queue_or_write_failure',
          droppedBytes,
          input.trafficClass,
        );
      }
      this.tryWrite(
        'finalizePayload',
        {
          completedAt: Date.now(),
          droppedReason: dropped
            ? (chunkFailureReason ?? 'body_chunk_queue_or_write_failure')
            : null,
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
      if (!this.generations.accepts(input.trafficClass, generation)) {
        return;
      }
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
    onFailure?: (reason: string) => void,
  ): Promise<boolean> | null {
    if (
      (operation === 'beginPayload' || operation === 'appendPayloadChunk') &&
      !this.getConfig().enabled
    ) {
      this.recordDrop('capture_disabled', 0, trafficClass);
      onFailure?.('capture_disabled');
      return null;
    }
    if (this.repairInProgress) {
      return null;
    }
    let resolve!: (accepted: boolean) => void;
    const completion = new Promise<boolean>((settle) => {
      resolve = settle;
    });
    try {
      const accepted = this.ensureWorker().tryWrite(this.writeCommand(operation, payload), {
        onFailure: (error) => {
          onFailure?.(auditDiskRejection(error) ?? 'worker_write_failure');
          resolve(false);
        },
        onSuccess: () => resolve(true),
        priority: toWorkerPriority(trafficClass),
      });
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
    this.terminal.requireWorker(
      (this.worker?.getStats().alive ?? false) || this.repairInProgress !== null,
    );
    if (this.worker?.getStats().alive) {
      return this.worker;
    }
    this.worker = null;
    const config = this.getConfig();
    const stateDir = getProxyStateDir();
    fs.mkdirSync(stateDir, { recursive: true });
    this.worker = new BoundedSqliteWorker({
      databasePath: path.join(stateDir, TRAFFIC_AUDIT_FILENAME),
      maxPendingBytes: config.max_queue_mib * 1024 * 1024,
      maxPendingCommands: config.max_queue_records,
      name: 'traffic-audit-sqlite',
      ownerStartedAt: Math.floor(performance.timeOrigin),
      onWriteFailure: (error) => {
        this.recordDrop(auditDiskRejection(error) ?? 'worker_write_failure');
        logger.warn('Traffic audit worker write failed', error);
      },
      workerPath: path.join(__dirname, 'traffic-audit.worker.js'),
    });
    this.worker.start();
    if (this.terminal.acceptsWork()) {
      this.maintenance.start();
    }
    return this.worker;
  }

  private tryWrite<TOperation extends TrafficAuditWorkerCommand['operation']>(
    operation: TOperation,
    payload: Extract<TrafficAuditWorkerCommand, { operation: TOperation }>['payload'],
    trafficClass: TrafficClass = 'system',
  ): boolean {
    if (
      (operation === 'beginPayload' || operation === 'appendPayloadChunk') &&
      !this.getConfig().enabled
    ) {
      this.recordDrop('capture_disabled', 0, trafficClass);
      return false;
    }
    if (this.repairInProgress) {
      this.recordDrop('database_repair', 0, trafficClass);
      return false;
    }
    try {
      this.flushDropStats();
      if (
        this.ensureWorker().tryWrite(this.writeCommand(operation, payload, trafficClass), {
          priority: toWorkerPriority(trafficClass),
        })
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
    this.terminal.requireAdmission();
    if (this.repairInProgress) {
      await this.repairInProgress;
    }
    return this.ensureWorker().request<TResult>({ operation, payload });
  }

  private writeCommand<TPayload>(
    operation: TrafficAuditWorkerCommand['operation'],
    payload: TPayload,
    trafficClass?: TrafficClass,
  ) {
    return {
      operation,
      payload,
      maxDiskBytes: this.getConfig().max_disk_mib * 1024 * 1024,
      ...((operation === 'insertParent' || operation === 'adminEvent') && trafficClass
        ? { capture: { trafficClass, generation: this.generations.current(trafficClass) } }
        : {}),
    };
  }

  private async performRepair(): Promise<DatabaseRepairResult> {
    this.maintenance.stop();
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
    this.dropStats.record(reason, droppedBytes, trafficClass);
  }

  private flushDropStats(): void {
    if (!this.worker) {
      return;
    }
    this.dropStats.flush(this.worker, this.getConfig().max_disk_mib * 1024 * 1024);
  }

  private recordAdminEvent(operation: string, affectedCount: number | null, error: unknown): void {
    const timestamp = Date.now();
    const accepted = this.tryWrite('adminEvent', {
      affectedCount,
      error: serializeAuditError(error),
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
    maxDiskBytes: config.max_disk_mib * 1024 * 1024,
    maxRows: config.max_rows,
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
