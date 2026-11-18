import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ThoughtStoreConfig } from '@/modules/config/types';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { errorProcessOwner } from '@/modules/error-diagnostics/public';
import type {
  GeminiContent,
  GeminiInternalRequest,
} from '@/modules/proxy-gateway/antigravity/types';
import { getTrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { recordProxyThinkingFill } from '@/server/gateway/common/proxy-response-timing';
import { recordThoughtRestoreCompletion } from '../../../server/gateway/common/generation-request-diagnostics';
import {
  recordThoughtRestoreOutcome,
  type ThoughtRestoreUnavailable,
} from './thought-restore-diagnostics';
import { getServerConfig } from '@/server/server-config';
import { logger } from '@/shared/logging/logger';
import { DiagnosticStoreShutdown } from '../diagnostics/store-shutdown';
import { DiagnosticMaintenanceScheduler } from '../diagnostics/maintenance-scheduler';
import { getProxyStateDir } from '@/shared/platform/paths';
import { preserveCorruptSqliteDatabase } from '@/shared/persistence/database/preserve-corrupt-sqlite';
import { BoundedSqliteWorker } from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';
import type { DatabaseRepairResult } from '../audit/traffic-audit.service';
import {
  ThoughtSessionListSchema,
  ThoughtStoreStatsSchema,
  type ThoughtRecord,
  type ThoughtRecordInput,
  type ThoughtSessionSummary,
  type ThoughtStoreStats,
} from './thought-store.types';
import { findExistingThoughtRecordIndex, isStrongerThoughtRecord } from './thought-store.matching';
import {
  ThoughtCleanupResultSchema,
  type ThoughtStoreWorkerCommand,
} from './thought-store.worker-protocol';
import {
  ThoughtSessionMemory,
  mergeHydratedThoughtRecords,
  type MemorySession,
} from './thought-session-memory';
import { ThoughtHydrationAdmissionError, ThoughtHydrationQueue } from './thought-hydration-queue';
import { ThoughtHydrationRequests, thoughtHydrationCancelled } from './thought-hydration-requests';
import {
  extractThoughtRecord,
  isMeaningfulThought,
  restoreStoredThoughts,
} from './thought-content';
export { isPlaceholderThought, restoreStoredThoughts } from './thought-content';
import { decodeThoughtPartSignatures, thoughtPartsBytes } from './thought-part-signatures';
import { mergeThoughtRecordContent } from './thought-record-content';
import { ThoughtRecordSchema } from './thought-owner.schema';
import { assertThoughtReplyBudget, MAX_THOUGHT_READ_RECORDS } from './thought-read-budget';
import { thoughtCausalHistory } from './thought-causal-history';
import { mergeThoughtProvenance } from './thought-record-provenance';
import { ThoughtReadBudgetError } from './thought-read-budget';
import { ThoughtToolRecovery } from './thought-tool-recovery';
import { ThoughtToolRecoverySnapshotSchema } from './thought-tool-recovery.schema';
import { thoughtToolLayoutDigest } from './thought-tool-layout';
import { invalidateThoughtRecoveryPeers } from './thought-recovery-peers';
import { ThoughtStreamCapture } from './thought-stream-capture';
import {
  decodeThoughtRecordPage,
  ThoughtMutationReceiptSchema,
  type ThoughtRecordPageInput,
  type ThoughtMutationReceipt,
} from './thought-management.schema';
import {
  thoughtCaptureLeases,
  ThoughtCaptureLeases,
  type ThoughtCaptureLease,
} from './thought-capture-leases';

const THOUGHT_STORE_FILENAME = 'thinking-store.db';
const TOUCH_PERSIST_INTERVAL_MS = 5 * 60 * 1000;
const HYDRATION_FAILURE_COOLDOWN_MS = 1000;
const MAX_QUEUE_BYTES = 128 * 1024 * 1024;
const MAX_QUEUE_COMMANDS = 256;
type ThoughtRestoreSource = 'memoryHits' | 'coldHits' | 'restoredSourceUnknown';
interface ThoughtHydrationResult {
  records: ThoughtRecord[];
  unavailable: ThoughtRestoreUnavailable | null;
  restoredSource: ThoughtRestoreSource;
}
export const HARD_MAX_THOUGHT_TURNS = 10_000;
export const HARD_MAX_THOUGHT_SESSION_BYTES = 64 * 1024 * 1024;

export function enforceThoughtSessionLimits(
  records: ThoughtRecord[],
  config: Pick<ThoughtStoreConfig, 'max_session_mib' | 'max_turns_per_session'>,
): void {
  const maxTurns = Math.min(HARD_MAX_THOUGHT_TURNS, Math.max(10, config.max_turns_per_session));
  const maxBytes = Math.min(
    HARD_MAX_THOUGHT_SESSION_BYTES,
    Math.max(1, config.max_session_mib) * 1024 * 1024,
  );
  while (records.length > maxTurns) {
    records.shift();
  }
  let bytes = records.reduce((total, record) => total + retainedThoughtBytes(record), 0);
  while (bytes > maxBytes && records.length > 0) {
    const removed = records.shift();
    bytes -= removed ? retainedThoughtBytes(removed) : 0;
  }
}

function resolveThoughtSessionLimits(
  config: Pick<ThoughtStoreConfig, 'max_session_mib' | 'max_turns_per_session'>,
): { maxBytes: number; maxTurns: number } {
  return {
    maxBytes: Math.min(
      HARD_MAX_THOUGHT_SESSION_BYTES,
      Math.max(1, config.max_session_mib) * 1024 * 1024,
    ),
    maxTurns: Math.min(HARD_MAX_THOUGHT_TURNS, Math.max(10, config.max_turns_per_session)),
  };
}

export class ThoughtStoreService {
  private readonly toolRecovery = new ThoughtToolRecovery();
  private readonly terminal = new DiagnosticStoreShutdown();
  private worker: BoundedSqliteWorker | null = null;
  private readonly maintenance = new DiagnosticMaintenanceScheduler(
    async () => {
      const config = this.getConfig();
      const protectedSessionKeys = thoughtCaptureLeases.protectedKeys();
      if (protectedSessionKeys === null) {
        this.maintenanceBlockedReason = 'active_sessions';
        return { moreWorkPending: false };
      }
      const reserveSlot = this.sessionCapacityRefused;
      this.sessionCapacityRefused = false;
      const result = ThoughtCleanupResultSchema.parse(
        await this.request('cleanup', {
          maxSessions: Math.max(0, config.max_sessions - (reserveSlot ? 1 : 0)),
          retentionDays: config.retention_days,
          maxDiskBytes: config.max_disk_mib * 1024 * 1024,
          protectedSessionKeys,
        }).catch((error: unknown) => {
          this.sessionCapacityRefused ||= reserveSlot;
          throw error;
        }),
      );
      this.maintenanceBlockedReason = result.blockedReason;
      for (const key of result.invalidatedSessions ?? []) {
        this.invalidateSessionHydration(key);
      }
      return result;
    },
    (error) => logger.warn('Thought Store maintenance failed', error),
  );
  private readonly sessions = new ThoughtSessionMemory();
  private readonly hydration = new ThoughtHydrationRequests<ThoughtHydrationResult>();
  private readonly hydrationLoads = new ThoughtHydrationQueue();
  private hydrationGeneration = 0;
  private readonly hydrationLeases = new ThoughtCaptureLeases();
  private closePromise: Promise<void> | null = null;
  private writeFailures = 0;
  private readFailures = 0;
  private hydrationAdmissionFailures = 0;
  private sessionCapacityRefused = false;
  private maintenanceBlockedReason: ThoughtStoreStats['maintenanceBlockedReason'];
  private lastWriteFailure: ThoughtStoreStats['lastWriteFailure'] = null;
  private captureMutations: Promise<unknown> = Promise.resolve();
  private readonly invalidationListeners = new Set<(sessionKey?: string) => void>();
  private readonly captureAnchors = new WeakMap<ThoughtCaptureLease, string>();

  public subscribeInvalidation(listener: (sessionKey?: string) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => {
      this.invalidationListeners.delete(listener);
    };
  }
  private repairInProgress: Promise<DatabaseRepairResult> | null = null;

  public isEnabled(): boolean {
    return this.terminal.acceptsWork() && this.getConfig().enabled;
  }

  public getCurrentSessionKey(): string | null {
    const lease = this.getCurrentCaptureLease();
    return lease?.valid ? lease.sessionKey : null;
  }

  public getCurrentCaptureLease(): ThoughtCaptureLease | undefined {
    const context = getTrafficAuditRequestContext();
    if (!context) {
      return undefined;
    }
    return (context.thoughtCaptureLease ??= thoughtCaptureLeases.acquire(
      context.thoughtSessionKey,
    ));
  }

  public async prepareInternalRequest(
    body: GeminiInternalRequest,
    model: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      recordThoughtRestoreOutcome('cancelled');
      recordThoughtRestoreCompletion();
      throw thoughtHydrationCancelled();
    }
    const sessionKey = this.getCurrentSessionKey();
    if (!sessionKey) {
      if (this.getCurrentCaptureLease()?.valid === false) {
        recordThoughtRestoreOutcome('invalidated');
        recordThoughtRestoreCompletion();
      }
      return;
    }
    if (!this.isEnabled()) {
      return;
    }
    if (!this.hydrationLoads.acceptsWork()) {
      recordThoughtRestoreOutcome('admissionUnavailable');
      recordThoughtRestoreCompletion();
      return;
    }
    const contents = body.request.contents;
    if (!Array.isArray(contents)) {
      return;
    }

    const startedAt = performance.now();
    let unavailable = false;
    const generation = this.hydrationGeneration;
    const hydrationLease = this.hydrationLeases.acquire(sessionKey);
    const captureLease = this.getCurrentCaptureLease();
    if (captureLease) {
      this.captureAnchors.set(captureLease, thoughtCausalHistory(contents).after);
    }
    try {
      const hydrated = await this.hydration.run(
        sessionKey,
        (sharedSignal) => this.ensureHydrated(sessionKey, sharedSignal),
        signal,
      );
      let records = hydrated.records;
      let restoredSource = hydrated.restoredSource;
      if (hydrated.unavailable) {
        unavailable = true;
        recordThoughtRestoreOutcome(hydrated.unavailable);
      }
      if (signal?.aborted) {
        throw thoughtHydrationCancelled();
      }
      if (
        generation !== this.hydrationGeneration ||
        !hydrationLease.valid ||
        !captureLease?.valid ||
        !this.terminal.acceptsWork()
      ) {
        recordThoughtRestoreOutcome('invalidated');
        return;
      }
      const causal = thoughtCausalHistory(contents);
      const missing = [
        ...new Set(
          contents.flatMap((content, index) => {
            if (content.role !== 'model' && content.role !== 'assistant') {
              return [];
            }
            const probe = extractThoughtRecord(content, model, true);
            if (!probe) {
              return [];
            }
            probe.causalAnchor = causal.before[index];
            return findExistingThoughtRecordIndex(probe, records, new Set(), 'restore') === null
              ? [causal.before[index]]
              : [];
          }),
        ),
      ];
      const memory = this.sessions.get(sessionKey);
      if (
        missing.length > 0 &&
        memory?.loaded &&
        performance.now() >= (memory.olderLookupRetryAt ?? 0)
      ) {
        try {
          if (missing.length > 64) {
            throw new ThoughtReadBudgetError();
          }
          const selected = await this.hydrationLoads.run(
            async () =>
              parseThoughtRecords(
                await this.request('findCandidates', { sessionKey, model, anchors: missing }),
              ),
            signal,
          );
          if (selected.length > 0) {
            restoredSource = records.length > 0 ? 'restoredSourceUnknown' : 'coldHits';
          }
          records = mergeHydratedThoughtRecords(selected, records);
        } catch (error) {
          if (signal?.aborted) {
            throw thoughtHydrationCancelled();
          }
          if (!hydrationLease.valid || !captureLease?.valid) {
            recordThoughtRestoreOutcome('invalidated');
            return;
          }
          unavailable = true;
          recordThoughtRestoreOutcome(
            error instanceof ThoughtHydrationAdmissionError
              ? 'admissionUnavailable'
              : 'readUnavailable',
          );
          if (error instanceof ThoughtHydrationAdmissionError) {
            this.hydrationAdmissionFailures += 1;
          } else {
            this.readFailures += 1;
            memory.olderLookupRetryAt = performance.now() + HYDRATION_FAILURE_COOLDOWN_MS;
          }
          logger.warn(
            'Thought Store older-history lookup failed; continuing without older restore',
            error,
          );
        }
      } else if (missing.length > 0 && memory?.loaded && memory.olderLookupRetryAt) {
        unavailable = true;
        recordThoughtRestoreOutcome('cooldownUnavailable');
      }
      records = await this.resolveToolRecovery(sessionKey, records, signal, () => {
        unavailable = true;
      });
      if (!hydrationLease.valid || !captureLease?.valid || signal?.aborted) {
        recordThoughtRestoreOutcome(signal?.aborted ? 'cancelled' : 'invalidated');
        return;
      }
      this.ingestContents(sessionKey, contents, model, true, records, causal.before);
      this.restoreContents(
        sessionKey,
        contents,
        model,
        records,
        causal.before,
        restoredSource,
        unavailable,
      );
    } catch (error) {
      if (signal?.aborted) {
        recordThoughtRestoreOutcome('cancelled');
      }
      if (
        generation !== this.hydrationGeneration ||
        !hydrationLease.valid ||
        !captureLease?.valid ||
        !this.terminal.acceptsWork()
      ) {
        if (!signal?.aborted) {
          recordThoughtRestoreOutcome('invalidated');
        }
        return;
      }
      throw error;
    } finally {
      hydrationLease.release();
      recordProxyThinkingFill(startedAt);
      recordThoughtRestoreCompletion();
    }
  }

  public captureGeminiResponse(
    sessionKey: string | null,
    response: unknown,
    model: string,
    lease = this.getCurrentCaptureLease(),
  ): void {
    if (!sessionKey || !this.isEnabled() || !lease?.valid || lease.sessionKey !== sessionKey) {
      return;
    }
    if (!this.hydrationLoads.acceptsWork()) {
      this.writeFailures += 1;
      return;
    }
    const contents = responseToContents(response);
    if (contents.length === 0) {
      return;
    }
    const operationId = randomUUID();
    if (contents.length !== 1) {
      return;
    }
    for (const [index, content] of contents.entries()) {
      const record = extractThoughtRecord(content, model);
      if (record) {
        this.storeRecord(sessionKey, {
          ...record,
          operationId: `${operationId}/${index}`,
          causalAnchor: this.captureAnchors.get(lease) ?? null,
          completedAt: Date.now(),
          captureState: 'complete',
        });
      }
    }
  }

  public beginStreamCapture(
    sessionKey: string | null,
    model: string,
    lease = this.getCurrentCaptureLease(),
  ): ThoughtStreamCapture {
    return new ThoughtStreamCapture(
      () =>
        Boolean(sessionKey && lease?.valid && lease.sessionKey === sessionKey && this.isEnabled()),
      (content) =>
        this.captureGeminiResponse(sessionKey, { candidates: [{ content }] }, model, lease),
      () => {
        this.writeFailures += 1;
      },
    );
  }

  public async listSessions(
    limit = 100,
    offset = 0,
    search?: string,
    model?: string,
  ): Promise<ThoughtSessionSummary[]> {
    return ThoughtSessionListSchema.parse(
      await this.request('listSessions', {
        limit: Math.min(Math.max(limit, 1), 200),
        model: model?.trim() || undefined,
        offset: Math.max(offset, 0),
        search: search?.trim() || undefined,
      }),
    );
  }

  public async getSession(sessionKey: string): Promise<ThoughtRecord[]> {
    return parseThoughtRecords(await this.request('getSession', { sessionKey }));
  }

  public async listRecordPage(input: ThoughtRecordPageInput) {
    return decodeThoughtRecordPage(await this.request('listRecordPage', input), input);
  }

  public async getRecord(sessionKey: string, id: number): Promise<ThoughtRecord | null> {
    const result = await this.request('getRecord', { id, sessionKey });
    if (result === null) {
      return null;
    }
    if (!isThoughtRecord(result)) {
      throw new Error('Thought Store returned an invalid record');
    }
    return result;
  }

  public async endSession(sessionKey: string): Promise<ThoughtMutationReceipt> {
    return this.mutateCaptureScope(sessionKey, async () => {
      const affected = ThoughtMutationReceiptSchema.parse(
        await this.request('end', {
          sessionKey,
          maxDiskBytes: this.getConfig().max_disk_mib * 1024 * 1024,
        }),
      );
      this.sessions.delete(sessionKey);
      return affected;
    });
  }

  public async deleteSession(sessionKey: string): Promise<ThoughtMutationReceipt> {
    return this.mutateCaptureScope(sessionKey, async () => {
      const affected = ThoughtMutationReceiptSchema.parse(
        await this.request('deleteSession', { sessionKey }),
      );
      this.sessions.delete(sessionKey);
      return { ...affected, ...(await invalidateThoughtRecoveryPeers(sessionKey)) };
    });
  }

  public async clear(): Promise<ThoughtMutationReceipt> {
    return this.mutateCaptureScope(undefined, async () => {
      const affected = ThoughtMutationReceiptSchema.parse(await this.request('clear', null));
      this.sessions.clear();
      return { ...affected, ...(await invalidateThoughtRecoveryPeers()) };
    });
  }

  private mutateCaptureScope<T>(
    sessionKey: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    this.terminal.requireAdmission();
    const release = thoughtCaptureLeases.block(sessionKey);
    if (sessionKey === undefined) {
      this.hydrationGeneration += 1;
      this.hydration.cancelAll();
      this.hydrationLeases.revoke();
      this.sessions.clear();
      for (const listener of this.invalidationListeners) {
        listener();
      }
    } else {
      this.invalidateSessionHydration(sessionKey);
    }
    const task = this.captureMutations
      .catch(() => undefined)
      .then(async () => {
        await this.worker?.drainAdmitted();
        return work();
      })
      .finally(release);
    this.captureMutations = task;
    return task;
  }

  public async stats(): Promise<ThoughtStoreStats> {
    const persisted = ThoughtStoreStatsSchema.pick({
      databaseBytes: true,
      sessions: true,
      records: true,
      recoverableToolLinks: true,
    }).parse(await this.request('stats', null));
    const queue = this.ensureWorker().getStats();
    const memory = this.sessions.snapshot();
    return ThoughtStoreStatsSchema.parse({
      ...persisted,
      memorySessions: this.sessions.size,
      workerAlive: queue.alive,
      workerPendingBytes: queue.pendingBytes,
      workerPendingCommands: queue.pendingCommands,
      writeFailures: this.writeFailures,
      readFailures: this.readFailures,
      hydrationAdmissionFailures: this.hydrationAdmissionFailures,
      memoryRecords: memory.records,
      memoryBytes: memory.bytes,
      maintenanceState: this.maintenance.state(),
      maintenanceBlockedReason: this.maintenanceBlockedReason,
      lastWriteFailure: this.lastWriteFailure,
    });
  }

  public async configure(config: ThoughtStoreConfig): Promise<void> {
    const protectedSessionKeys = thoughtCaptureLeases.protectedKeys();
    const progress =
      protectedSessionKeys === null
        ? ThoughtCleanupResultSchema.parse({
            removedSessions: 0,
            moreWorkPending: false,
            blockedReason: 'active_sessions',
          })
        : ThoughtCleanupResultSchema.parse(
            await this.request('cleanup', {
              maxSessions: config.max_sessions,
              retentionDays: config.retention_days,
              maxDiskBytes: config.max_disk_mib * 1024 * 1024,
              protectedSessionKeys,
            }),
          );
    this.maintenance.continueFrom(progress);
    this.maintenanceBlockedReason = progress.blockedReason;
    for (const key of progress.invalidatedSessions ?? []) {
      this.invalidateSessionHydration(key);
    }
    for (const [sessionKey, session] of this.sessions) {
      this.pruneMemorySession(sessionKey, session, config);
    }
    this.pruneMemorySessions(config.max_sessions);
  }

  public async repair(): Promise<DatabaseRepairResult> {
    this.terminal.requireAdmission();
    if (this.repairInProgress) {
      return this.repairInProgress;
    }
    if (!this.hydrationLoads.acceptsWork()) {
      throw new Error('Thought Store is closing');
    }
    const repair = this.performRepair().finally(() => {
      this.repairInProgress = null;
    });
    this.repairInProgress = repair;
    return repair;
  }

  public shutdown(): Promise<void> {
    const unblock = thoughtCaptureLeases.block();
    for (const listener of this.invalidationListeners) {
      listener();
    }
    this.maintenance.stop();
    this.hydrationGeneration += 1;
    this.hydration.cancelAll();
    this.hydrationLoads.pause();
    return this.terminal
      .run(
        async () => {
          await this.repairInProgress;
          await this.closePromise;
          await this.hydration.waitForIdle();
        },
        async () => {
          const worker = this.worker;
          this.worker = null;
          try {
            await worker?.close();
          } finally {
            this.sessions.clear();
            this.hydration.cancelAll();
          }
        },
      )
      .finally(unblock);
  }

  public close(): Promise<void> {
    this.closePromise ??= this.performClose().finally(() => {
      this.closePromise = null;
    });
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    const unblock = thoughtCaptureLeases.block();
    for (const listener of this.invalidationListeners) {
      listener();
    }
    this.maintenance.stop();
    this.hydrationGeneration += 1;
    this.hydration.cancelAll();
    this.hydrationLoads.pause();
    const worker = this.worker;
    this.worker = null;
    try {
      await worker?.close();
    } finally {
      this.sessions.clear();
      this.hydration.cancelAll();
      this.hydrationLoads.resume();
      unblock();
    }
  }

  private ingestContents(
    sessionKey: string,
    contents: GeminiContent[],
    model: string,
    historical = false,
    candidateRecords?: readonly ThoughtRecord[],
    causalAnchors?: readonly string[],
  ): void {
    const incoming = contents
      .map((content, index) => {
        const record = extractThoughtRecord(content, model);
        if (
          record &&
          historical &&
          candidateRecords?.some((candidate) => candidate.causalAnchor === causalAnchors?.[index])
        ) {
          record.causalAnchor = causalAnchors?.[index];
          record.captureState = 'history';
        }
        return record;
      })
      .filter((record): record is ThoughtRecordInput => record !== null);
    if (!historical) {
      for (const record of incoming) {
        this.storeRecord(sessionKey, record);
      }
      return;
    }
    if (incoming.length === 0) {
      return;
    }

    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }
    const existing = [...(candidateRecords ?? session.records)];
    const used = new Set<number>();
    const upgrades: Array<{ index: number; record: ThoughtRecordInput }> = [];
    const toAppend: ThoughtRecordInput[] = [];
    for (const record of incoming) {
      const index = findExistingThoughtRecordIndex(record, existing, used);
      if (index === null) {
        toAppend.push(record);
        continue;
      }
      used.add(index);
      if (isStrongerThoughtRecord(record, existing[index])) {
        upgrades.push({ index, record });
      }
    }
    if (upgrades.length === 0 && toAppend.length === 0) {
      return;
    }

    const config = this.getConfig();
    const { maxBytes, maxTurns } = resolveThoughtSessionLimits(config);
    const now = Date.now();
    for (const { index, record } of upgrades) {
      const previous = existing[index];
      const currentIndex = session.records.findIndex((item) => item.id === previous.id);
      if (currentIndex >= 0) {
        session.records[currentIndex] = toMemoryRecord(
          {
            ...record,
            ...mergeThoughtRecordContent(record, previous),
            ...mergeThoughtProvenance(record, previous),
          },
          previous.id,
          previous.createdAt,
          maxBytes,
        );
        this.toolRecovery.inherit(previous, session.records[currentIndex]);
      }
    }
    this.pruneMemorySession(sessionKey, session, config);
    for (const record of toAppend) {
      this.storeRecord(sessionKey, record, false);
    }

    if (this.repairInProgress) {
      this.writeFailures += 1;
      return;
    }
    const accepted = this.tryWriteSessionAccess(session, 'ingestHistory', {
      records: incoming.map((record) => ({
        ...record,
        createdAt: now,
        maxSessionBytes: HARD_MAX_THOUGHT_SESSION_BYTES,
        maxDiskBytes: config.max_disk_mib * 1024 * 1024,
        maxSessions: config.max_sessions,
        maxTurns,
        meaningful: isMeaningfulThought(record.thought),
        sessionKey,
      })),
      sessionKey,
    });
    this.pruneMemorySessions(config.max_sessions);
    if (!accepted) {
      this.writeFailures += 1;
    }
  }

  private restoreContents(
    sessionKey: string,
    contents: GeminiContent[],
    model: string,
    hydrated: ThoughtRecord[],
    causalAnchors: readonly string[],
    restoredSource: ThoughtRestoreSource,
    unavailable: boolean,
  ): void {
    const session = this.sessions.get(sessionKey);
    const records = hydrated;
    if (session && records.length > 0) {
      session.lastAccessed = Date.now();
      this.touchSession(sessionKey);
    }
    restoreStoredThoughts(
      contents,
      records,
      model,
      records.some((record) => record.causalAnchor) ? causalAnchors : undefined,
      (outcome) => {
        if (outcome.kind === 'restored') {
          recordThoughtRestoreOutcome(restoredSource);
        } else if (outcome.kind === 'no-candidate') {
          recordThoughtRestoreOutcome(unavailable ? 'unresolved' : 'noCandidate');
        } else if (outcome.kind === 'unresolved') {
          recordThoughtRestoreOutcome('unresolved');
        } else {
          recordThoughtRestoreOutcome('matchedUnchanged');
        }
      },
    );
  }

  private storeRecord(sessionKey: string, input: ThoughtRecordInput, persist = true): void {
    const config = this.getConfig();
    const now = Date.now();
    const session = this.sessions.get(sessionKey) ?? {
      lastAccessed: now,
      persistedAccess: null,
      loaded: false,
      records: [],
    };
    const { maxBytes, maxTurns } = resolveThoughtSessionLimits(config);
    const index = findExistingThoughtRecordIndex(input, session.records, new Set());
    const latest = index === null ? undefined : session.records[index];
    if (latest && index !== null) {
      session.records[index] = toMemoryRecord(
        {
          ...input,
          ...mergeThoughtRecordContent(input, latest),
          ...mergeThoughtProvenance(input, latest),
        },
        latest.id,
        latest.createdAt,
        maxBytes,
      );
      this.toolRecovery.inherit(latest, session.records[index]);
    } else {
      session.records.push(toMemoryRecord(input, `memory-${randomUUID()}`, now, maxBytes));
    }
    session.lastAccessed = now;
    this.sessions.delete(sessionKey);
    this.sessions.set(sessionKey, session);
    this.pruneMemorySession(sessionKey, session, config);
    this.pruneMemorySessions(config.max_sessions);

    if (!persist) {
      return;
    }
    if (this.repairInProgress) {
      this.writeFailures += 1;
      return;
    }
    const accepted = this.tryWriteSessionAccess(
      session,
      'save',
      {
        ...input,
        createdAt: now,
        maxSessionBytes: HARD_MAX_THOUGHT_SESSION_BYTES,
        maxDiskBytes: config.max_disk_mib * 1024 * 1024,
        maxSessions: config.max_sessions,
        maxTurns,
        meaningful: isMeaningfulThought(input.thought),
        sessionKey,
      },
      () => {
        if (input.operationId) {
          for (const record of session.records) {
            if (record.operationId === input.operationId) {
              this.toolRecovery.markPersisted(record);
            }
          }
        }
      },
    );
    if (!accepted) {
      this.writeFailures += 1;
    }
  }

  private invalidateSessionHydration(sessionKey: string): void {
    this.hydrationLeases.revoke(sessionKey);
    this.hydration.cancel(sessionKey);
    this.sessions.delete(sessionKey);
    for (const listener of this.invalidationListeners) {
      listener(sessionKey);
    }
  }
  private async ensureHydrated(
    sessionKey: string,
    signal: AbortSignal,
  ): Promise<ThoughtHydrationResult> {
    const existing = this.sessions.get(sessionKey);
    if (existing?.loaded) {
      existing.lastAccessed = Date.now();
      return { records: existing.records, unavailable: null, restoredSource: 'memoryHits' };
    }
    if (existing?.hydrationRetryAt !== undefined && performance.now() < existing.hydrationRetryAt) {
      return {
        records: existing.records,
        unavailable: 'cooldownUnavailable',
        restoredSource: 'memoryHits',
      };
    }
    const { maxBytes, maxTurns } = resolveThoughtSessionLimits(this.getConfig());
    const generation = this.hydrationGeneration;
    const hydrationLease = this.hydrationLeases.acquire(sessionKey);
    const load = this.hydrationLoads
      .run(
        async () =>
          parseThoughtRecords(
            await this.request('load', { sessionKey, maxSessionBytes: maxBytes, maxTurns }),
          ),
        signal,
      )
      .then((persisted): ThoughtHydrationResult => {
        const captured = this.sessions.get(sessionKey)?.records ?? [];
        const records = mergeHydratedThoughtRecords(persisted, captured);
        // Merges retain persisted IDs even when current captures supply restored content.
        const restoredSource: ThoughtRestoreSource =
          captured.length === 0
            ? 'coldHits'
            : persisted.length === 0
              ? 'memoryHits'
              : 'restoredSourceUnknown';
        const persistedOperations = new Set(persisted.map((record) => record.operationId));
        for (const record of records) {
          if (record.operationId && persistedOperations.has(record.operationId)) {
            this.toolRecovery.markPersisted(record);
          }
        }
        if (
          signal.aborted ||
          !this.terminal.acceptsWork() ||
          generation !== this.hydrationGeneration ||
          !hydrationLease.valid
        ) {
          return { records, unavailable: null, restoredSource };
        }
        const session = {
          lastAccessed: Date.now(),
          persistedAccess: this.sessions.get(sessionKey)?.persistedAccess ?? null,
          loaded: true,
          records,
        };
        this.pruneMemorySession(sessionKey, session, this.getConfig());
        this.sessions.set(sessionKey, session);
        this.pruneMemorySessions(this.getConfig().max_sessions);
        if (persisted.length > 0) {
          this.touchSession(sessionKey);
        }
        return { records, unavailable: null, restoredSource };
      })
      .catch((error): ThoughtHydrationResult => {
        if (signal.aborted) {
          throw thoughtHydrationCancelled();
        }
        const captured = this.sessions.get(sessionKey);
        if (error instanceof ThoughtHydrationAdmissionError && error.reason === 'closed') {
          return {
            records: captured?.records ?? [],
            unavailable: 'admissionUnavailable',
            restoredSource: 'memoryHits',
          };
        }
        if (error instanceof ThoughtHydrationAdmissionError) {
          this.hydrationAdmissionFailures += 1;
        } else {
          this.readFailures += 1;
        }
        errorProcessOwner.capture({
          error,
          source: 'proxy-gateway',
          module: 'thought-store',
          functionName: 'ensureHydrated',
          stage: 'hydration',
          category:
            error instanceof ThoughtHydrationAdmissionError
              ? 'thought_hydration_admission_failed'
              : 'thought_hydration_read_failed',
          requestId: getTrafficAuditRequestContext()?.parent?.id,
        });
        logger.warn('Thought Store hydration failed; continuing without restore', error);
        if (
          this.terminal.acceptsWork() &&
          generation === this.hydrationGeneration &&
          hydrationLease.valid
        ) {
          this.sessions.set(sessionKey, {
            lastAccessed: Date.now(),
            persistedAccess: captured?.persistedAccess ?? null,
            loaded: false,
            ...(error instanceof ThoughtHydrationAdmissionError
              ? {}
              : { hydrationRetryAt: performance.now() + HYDRATION_FAILURE_COOLDOWN_MS }),
            records: captured?.records ?? [],
          });
          this.pruneMemorySessions(this.getConfig().max_sessions);
        }
        return {
          records: captured?.records ?? [],
          restoredSource: 'memoryHits',
          unavailable:
            error instanceof ThoughtHydrationAdmissionError
              ? 'admissionUnavailable'
              : 'readUnavailable',
        };
      })
      .finally(() => hydrationLease.release());
    return load;
  }

  private async resolveToolRecovery(
    sessionKey: string,
    records: ThoughtRecord[],
    signal?: AbortSignal,
    onUnavailable?: () => void,
  ): Promise<ThoughtRecord[]> {
    const operationIds = [
      ...new Set(
        records.flatMap((record) =>
          record.operationId &&
          record.partSignatures.some((part) => part.kind === 'tool' && part.signature)
            ? [record.operationId]
            : [],
        ),
      ),
    ];
    if (operationIds.length === 0) {
      return this.toolRecovery.apply(records, []);
    }
    const memory = this.sessions.get(sessionKey);
    if (performance.now() < (memory?.toolLinkRetryAt ?? 0)) {
      recordThoughtRestoreOutcome('cooldownUnavailable');
      onUnavailable?.();
      return this.toolRecovery.apply(records);
    }
    try {
      return await this.hydrationLoads.run(async () => {
        const snapshot = ThoughtToolRecoverySnapshotSchema.parse(
          await this.request('toolRecoverySnapshot', { sessionKey, operationIds,
            layouts: records.flatMap((record) => record.operationId ? [{ operationId: record.operationId, digest: thoughtToolLayoutDigest(record.partSignatures) }] : []),
          }),
        );
        return this.toolRecovery.apply(records, snapshot);
      }, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw thoughtHydrationCancelled();
      }
      onUnavailable?.();
      recordThoughtRestoreOutcome(
        error instanceof ThoughtHydrationAdmissionError
          ? 'admissionUnavailable'
          : 'readUnavailable',
      );
      if (error instanceof ThoughtHydrationAdmissionError) {
        this.hydrationAdmissionFailures += 1;
      } else {
        this.readFailures += 1;
        if (memory) {
          memory.toolLinkRetryAt = performance.now() + HYDRATION_FAILURE_COOLDOWN_MS;
        }
      }
      logger.warn(
        'Thought Store tool permissions unavailable; continuing without tool restore',
        error,
      );
      return this.toolRecovery.apply(records);
    }
  }

  private touchSession(sessionKey: string): void {
    const session = this.sessions.get(sessionKey);
    if (
      !session ||
      (session.persistedAccess &&
        performance.now() - session.persistedAccess.queuedAt < TOUCH_PERSIST_INTERVAL_MS)
    ) {
      return;
    }
    if (this.repairInProgress) {
      this.writeFailures += 1;
      return;
    }
    if (
      !this.tryWriteSessionAccess(session, 'touch', {
        sessionKey,
        maxDiskBytes: this.getConfig().max_disk_mib * 1024 * 1024,
      })
    ) {
      this.writeFailures += 1;
    }
  }

  /** Saves and hydration already refresh SQLite access; warm replay needs no extra write. */
  private tryWriteSessionAccess<TOperation extends 'save' | 'ingestHistory' | 'touch'>(
    session: MemorySession,
    operation: TOperation,
    payload: Extract<ThoughtStoreWorkerCommand, { operation: TOperation }>['payload'],
    onSuccess?: () => void,
  ): boolean {
    const access = { queuedAt: performance.now() };
    const accepted = this.ensureWorker().tryWrite(
      { operation, payload },
      {
        onSuccess,
        onFailure: () => {
          // An older failure must not invalidate a newer accepted access write.
          if (session.persistedAccess === access) {
            session.persistedAccess = null;
          }
        },
      },
    );
    if (accepted) {
      session.persistedAccess = access;
    }
    return accepted;
  }

  private pruneMemorySession(
    sessionKey: string,
    session: MemorySession,
    config: ThoughtStoreConfig,
  ): void {
    enforceThoughtSessionLimits(session.records, config);
    this.sessions.refresh(sessionKey, session);
  }

  private pruneMemorySessions(maxSessions: number): void {
    this.sessions.prune(maxSessions);
  }

  private ensureWorker(): BoundedSqliteWorker {
    this.terminal.requireWorker(this.worker !== null || this.repairInProgress !== null);
    if (this.worker) {
      return this.worker;
    }
    const stateDir = getProxyStateDir();
    fs.mkdirSync(stateDir, { recursive: true });
    this.worker = new BoundedSqliteWorker({
      databasePath: path.join(stateDir, THOUGHT_STORE_FILENAME),
      maxPendingBytes: MAX_QUEUE_BYTES,
      maxPendingCommands: MAX_QUEUE_COMMANDS,
      name: 'thought-store-sqlite',
      onWriteFailure: (error) => {
        this.writeFailures += 1;
        const message = error instanceof Error ? error.message : '';
        const reason = message.startsWith('SQLite write rejected: ')
          ? message.slice(23)
          : message === 'Thought Store write rejected: session_capacity'
            ? 'session_capacity'
            : 'write_failed';
        const safeReason = ThoughtStoreStatsSchema.shape.lastWriteFailure.safeParse(reason);
        this.lastWriteFailure = safeReason.success ? safeReason.data : 'write_failed';
        errorProcessOwner.capture({
          // Worker replies carry messages, not the original worker Error or its stack.
          error: `Thought Store write failed: ${this.lastWriteFailure}`,
          source: 'proxy-gateway',
          module: 'thought-store',
          functionName: 'onWriteFailure',
          stage: 'persistence',
          category: 'thought_store_write_failed',
        });
        if (message === 'Thought Store write rejected: session_capacity') {
          this.sessionCapacityRefused = true;
        }
        this.maintenance.continueFrom({ moreWorkPending: true });
        logger.warn('Thought Store worker write failed', error);
      },
      workerPath: path.join(__dirname, 'thought-store.worker.js'),
    });
    this.worker.start();
    if (this.terminal.acceptsWork()) {
      this.maintenance.start(false);
    }
    return this.worker;
  }

  private async request<
    TOperation extends ThoughtStoreWorkerCommand['operation'],
    TResult = unknown,
  >(
    operation: TOperation,
    payload: Extract<ThoughtStoreWorkerCommand, { operation: TOperation }>['payload'],
  ): Promise<TResult> {
    this.terminal.requireAdmission();
    if (this.repairInProgress) {
      await this.repairInProgress;
    }
    if (!this.hydrationLoads.acceptsWork()) {
      throw new Error('Thought Store is closing');
    }
    return this.ensureWorker().request<TResult>({ operation, payload });
  }

  private async performRepair(): Promise<DatabaseRepairResult> {
    const unblock = thoughtCaptureLeases.block();
    for (const listener of this.invalidationListeners) {
      listener();
    }
    this.maintenance.stop();
    this.hydrationGeneration += 1;
    this.hydration.cancelAll();
    this.hydrationLoads.pause();
    const worker = this.worker;
    this.worker = null;
    try {
      await worker?.close();
      this.sessions.clear();
      this.hydration.cancelAll();
      const databasePath = path.join(getProxyStateDir(), THOUGHT_STORE_FILENAME);
      const backupPath = preserveCorruptSqliteDatabase(databasePath);
      await this.ensureWorker().request({ operation: 'stats', payload: null });
      return { backupPath, repaired: true };
    } finally {
      this.hydrationLoads.resume();
      unblock();
    }
  }

  private getConfig(): ThoughtStoreConfig {
    return getServerConfig()?.thought_store ?? DEFAULT_APP_CONFIG.proxy.thought_store;
  }
}

export const thoughtStoreService = new ThoughtStoreService();

function toMemoryRecord(
  input: ThoughtRecordInput,
  id: ThoughtRecord['id'],
  createdAt: number,
  maxBytes: number,
): ThoughtRecord {
  const rawBytes = retainedThoughtBytes(input);
  const oversized = rawBytes > maxBytes;
  return {
    ...input,
    createdAt,
    id,
    oversized,
    oversizedBytes: oversized ? rawBytes : null,
    oversizedSha256: oversized ? sha256Hex(input.thought) : null,
    thought: oversized ? '' : input.thought,
    signature: oversized ? null : input.signature,
    partSignatures: oversized ? [] : input.partSignatures,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function responseToContents(response: unknown): GeminiContent[] {
  if (!response || typeof response !== 'object') {
    return [];
  }
  const wrapped = Reflect.get(response, 'response');
  const source = wrapped && typeof wrapped === 'object' ? wrapped : response;
  const candidates = Reflect.get(source, 'candidates');
  if (!Array.isArray(candidates)) {
    return [];
  }
  return candidates
    .map((candidate) =>
      candidate && typeof candidate === 'object' ? Reflect.get(candidate, 'content') : null,
    )
    .filter((content): content is GeminiContent => Boolean(content && typeof content === 'object'));
}

function parseThoughtRecords(value: unknown): ThoughtRecord[] {
  if (!Array.isArray(value) || value.length > MAX_THOUGHT_READ_RECORDS) {
    throw new Error('Thought Store returned an invalid record list');
  }
  const records = value.map((record) => {
    if (!isThoughtRecord(record)) {
      throw new Error('Thought Store returned an invalid record');
    }
    return record;
  });
  assertThoughtReplyBudget(records);
  return records;
}

function isThoughtRecord(value: unknown): value is ThoughtRecord {
  const valid = ThoughtRecordSchema.safeParse(value).success;
  if (valid && value && typeof value === 'object') {
    decodeThoughtPartSignatures(
      Reflect.get(value, 'partSignatures'),
      Reflect.get(value, 'thought'),
    );
  }
  return valid;
}

function retainedThoughtBytes(record: ThoughtRecordInput): number {
  return (
    Buffer.byteLength(record.thought, 'utf8') +
    thoughtPartsBytes(record.partSignatures) +
    Buffer.byteLength(record.signature ?? '', 'utf8') +
    Buffer.byteLength(record.visible, 'utf8') +
    Buffer.byteLength(record.fingerprint, 'utf8') +
    Buffer.byteLength(record.model ?? '', 'utf8') +
    Buffer.byteLength(record.sourceFamily ?? '', 'utf8') +
    Buffer.byteLength(record.operationId ?? '', 'utf8') +
    Buffer.byteLength(record.causalAnchor ?? '', 'utf8') +
    Buffer.byteLength(record.captureState ?? '', 'utf8') +
    record.toolIds.reduce((bytes, value) => bytes + Buffer.byteLength(value, 'utf8') + 16, 0) +
    record.toolNames.reduce((bytes, value) => bytes + Buffer.byteLength(value, 'utf8') + 16, 0) +
    256
  );
}
