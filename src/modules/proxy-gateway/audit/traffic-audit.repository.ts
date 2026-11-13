import Database from 'better-sqlite3';
import { count, eq, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getQuotaModelFamilyId } from '@/modules/cloud-account/utils/quota-model-families';

import {
  auditAdminEvents,
  auditDropStats,
  requestLogs,
  trafficAuditSchema,
  upstreamAttempts,
} from './traffic-audit.schema';
import { TrafficAuditPayloads } from './traffic-audit-payloads';
import { TrafficAuditQueries } from './traffic-audit-queries';
import { TrafficAuditRetention } from './traffic-audit-retention';
import {
  configureTrafficAuditDatabase,
  initializeTrafficAuditSchema,
  openTrafficAuditDatabase,
} from './traffic-audit-database';
import type {
  TrafficAuditWorkerCommand,
  AuditCaptureGeneration,
} from './traffic-audit.worker-protocol';
import { initialAuditGenerations, AUDIT_TRAFFIC_CLASSES } from './audit-capture-generations';
import { readUsageRange } from './traffic-audit-usage-range';
import { readUsageTrends } from './traffic-audit-usage-trends';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { recoverInterruptedAudit } from './traffic-audit-recovery';
import { auditSessionSnapshot } from './audit-session-snapshot';
import {
  TrafficAuditDiskBudget,
  AuditDiskAdmissionError,
  toAuditDiskAdmissionError,
} from './traffic-audit-disk-budget';

type TrafficAuditDatabase = BetterSQLite3Database<typeof trafficAuditSchema>;
type MaintenanceCommand = Extract<
  TrafficAuditWorkerCommand,
  { operation: 'maintenance' | 'configure' }
>;
export class TrafficAuditRepository {
  private readonly generations = initialAuditGenerations();
  private readonly raw: Database.Database;
  private readonly orm: TrafficAuditDatabase;
  private readonly queries: TrafficAuditQueries;
  private readonly retention: TrafficAuditRetention;
  private readonly payloads: TrafficAuditPayloads;
  private readonly diskBudget: TrafficAuditDiskBudget;
  private activeDiskBudget = DEFAULT_APP_CONFIG.proxy.traffic_audit.max_disk_mib * 1024 * 1024;

  public constructor(databasePath: string, ownerStartedAt = Math.floor(performance.timeOrigin)) {
    this.raw = openTrafficAuditDatabase(databasePath);
    try {
      configureTrafficAuditDatabase(this.raw);
      initializeTrafficAuditSchema(this.raw);
      this.orm = drizzle(this.raw, { schema: trafficAuditSchema });
      this.queries = new TrafficAuditQueries(this.raw, this.orm);
      this.retention = new TrafficAuditRetention(databasePath, this.raw);
      this.diskBudget = new TrafficAuditDiskBudget(databasePath, this.raw);
      this.payloads = new TrafficAuditPayloads(this.raw, this.orm, (bytes) =>
        this.diskBudget.assertCanWrite(bytes, this.activeDiskBudget),
      );
      recoverInterruptedAudit(this.raw, ownerStartedAt);
    } catch (error) {
      this.raw.close();
      throw error;
    }
  }

  public maintenance(config: MaintenanceCommand['payload']) {
    return this.retention.maintenance(config);
  }

  public execute(
    command: Exclude<TrafficAuditWorkerCommand, MaintenanceCommand>,
    maxDiskBytes = DEFAULT_APP_CONFIG.proxy.traffic_audit.max_disk_mib * 1024 * 1024,
    capture?: AuditCaptureGeneration,
  ): unknown {
    if (command.operation === 'insertParent' || command.operation === 'adminEvent') {
      const scope = command.operation === 'adminEvent' ? 'system' : command.payload.trafficClass;
      if (capture && capture.trafficClass !== scope) {
        throw new Error('Invalid audit capture scope');
      }
      if ((capture?.generation ?? 0) < this.generations[scope]) {
        return 0;
      }
    }
    const previous = this.activeDiskBudget;
    this.activeDiskBudget = maxDiskBytes;
    try {
      switch (command.operation) {
        case 'insertParent':
        case 'insertAttempt':
        case 'beginPayload':
        case 'appendPayloadChunk':
        case 'drop':
        case 'adminEvent':
          this.diskBudget.assertCanWrite(
            Buffer.byteLength(JSON.stringify(command.payload), 'utf8'),
            maxDiskBytes,
          );
          break;
        case 'completeParent':
        case 'completeAttempt':
        case 'finalizePayload':
        case 'finalizeSsePayload':
          this.diskBudget.assertCanWrite(
            Buffer.byteLength(JSON.stringify(command.payload), 'utf8'),
            maxDiskBytes,
            false,
          );
          break;
      }
      const result = this.executeCommand(command);
      if ((command.operation === 'insertParent' || command.operation === 'adminEvent') && capture) {
        this.generations[capture.trafficClass] = Math.max(
          this.generations[capture.trafficClass],
          capture.generation,
        );
      }
      return result;
    } catch (error) {
      const failure = toAuditDiskAdmissionError(error) ?? error;
      if (
        failure instanceof AuditDiskAdmissionError &&
        command.operation === 'appendPayloadChunk'
      ) {
        try {
          this.diskBudget.assertCanWrite(0, maxDiskBytes, false);
          this.payloads.markIncomplete(command.payload.payloadId, failure.reason);
        } catch (metadataError) {
          // The original rejection remains authoritative when even its metadata cannot commit.
          throw new AuditDiskAdmissionError(
            failure.reason,
            {
              cause: new AggregateError(
                [failure, metadataError],
                'Audit rejection metadata could not be persisted',
              ),
            },
            true,
          );
        }
      }
      throw failure;
    } finally {
      this.activeDiskBudget = previous;
    }
  }

  private executeCommand(command: Exclude<TrafficAuditWorkerCommand, MaintenanceCommand>): unknown {
    switch (command.operation) {
      case 'insertParent':
        return this.insertParent(command.payload);
      case 'completeParent':
        return this.completeParent(command.payload);
      case 'insertAttempt':
        return this.insertAttempt(command.payload);
      case 'completeAttempt':
        return this.completeAttempt(command.payload);
      case 'beginPayload':
        return this.payloads.beginPayload(command.payload);
      case 'appendPayloadChunk':
        return this.payloads.appendPayloadChunk(command.payload);
      case 'finalizePayload':
        return this.payloads.finalizePayload(command.payload);
      case 'finalizeSsePayload':
        return this.payloads.finalizeSsePayload(command.payload);
      case 'drop':
        return this.orm
          .insert(auditDropStats)
          .values(command.payload)
          .onConflictDoUpdate({
            target: [auditDropStats.trafficClass, auditDropStats.reason],
            set: {
              count: sql`${auditDropStats.count} + excluded.count`,
              droppedBytes: sql`${auditDropStats.droppedBytes} + excluded.dropped_bytes`,
              lastSeen: command.payload.lastSeen,
            },
          })
          .run().changes;
      case 'adminEvent':
        return this.orm.insert(auditAdminEvents).values(command.payload).run().changes;
      case 'list':
        return this.queries.list(command.payload);
      case 'filterOptions':
        return this.queries.filterOptions();
      case 'sessionSnapshot':
        return auditSessionSnapshot(this.raw, this.queries, command.payload.sessionId);
      case 'usageRange':
        return readUsageRange(this.raw, command.payload);
      case 'usageTrends':
        return readUsageTrends(this.raw, command.payload);
      case 'detail':
        return this.queries.detail(command.payload.id);
      case 'bodyPage':
        return this.queries.bodyPage(command.payload);
      case 'bodySearch':
        return this.queries.bodySearch(command.payload);
      case 'delete':
        if (command.payload.id.startsWith('admin:')) {
          const id = Number(command.payload.id.slice('admin:'.length));
          return Number.isInteger(id)
            ? this.orm.delete(auditAdminEvents).where(eq(auditAdminEvents.id, id)).run().changes
            : 0;
        }
        return this.orm.delete(requestLogs).where(eq(requestLogs.id, command.payload.id)).run()
          .changes;
      case 'clear':
        return this.clearRecords(command.payload);
      case 'resetDropStats': {
        if (command.payload.trafficClass) {
          return this.orm
            .delete(auditDropStats)
            .where(eq(auditDropStats.trafficClass, command.payload.trafficClass))
            .run().changes;
        }
        return this.orm.delete(auditDropStats).run().changes;
      }
      case 'stats':
        return this.retention.stats();
      case 'shutdown':
        this.raw.pragma('wal_checkpoint(TRUNCATE)');
        this.raw.close();
        return true;
    }
  }

  private clearRecords(
    payload: Extract<TrafficAuditWorkerCommand, { operation: 'clear' }>['payload'],
  ): number {
    const affected = this.raw.transaction(() => {
      if (payload.trafficClass === 'system') {
        return this.raw.transaction(() => {
          const requests =
            this.orm
              .select({ value: count() })
              .from(requestLogs)
              .where(eq(requestLogs.trafficClass, 'system'))
              .get()?.value ?? 0;
          const events =
            this.orm.select({ value: count() }).from(auditAdminEvents).get()?.value ?? 0;
          this.orm.delete(requestLogs).where(eq(requestLogs.trafficClass, 'system')).run();
          this.orm.delete(auditAdminEvents).run();
          this.orm.delete(auditDropStats).where(eq(auditDropStats.trafficClass, 'system')).run();
          return requests + events;
        })();
      }
      if (payload.trafficClass) {
        const rows =
          this.orm
            .select({ value: count() })
            .from(requestLogs)
            .where(eq(requestLogs.trafficClass, payload.trafficClass))
            .get()?.value ?? 0;
        this.orm
          .delete(requestLogs)
          .where(eq(requestLogs.trafficClass, payload.trafficClass))
          .run();
        this.orm
          .delete(auditDropStats)
          .where(eq(auditDropStats.trafficClass, payload.trafficClass))
          .run();
        return rows;
      }
      const rows = this.orm.select({ value: count() }).from(requestLogs).get()?.value ?? 0;
      const events = this.orm.select({ value: count() }).from(auditAdminEvents).get()?.value ?? 0;
      this.orm.delete(requestLogs).run();
      this.orm.delete(auditAdminEvents).run();
      this.orm.delete(auditDropStats).run();
      return rows + events;
    })();
    for (const scope of payload.trafficClass ? [payload.trafficClass] : AUDIT_TRAFFIC_CLASSES) {
      this.generations[scope] = Math.max(
        this.generations[scope],
        payload.generations?.[scope] ?? this.generations[scope] + 1,
      );
    }
    this.retention.reclaimDiskSpaceDirect();
    return affected;
  }
  private insertParent(
    payload: Extract<TrafficAuditWorkerCommand, { operation: 'insertParent' }>['payload'],
  ): number {
    return this.orm
      .insert(requestLogs)
      .values({ ...payload, outcome: 'in_progress' })
      .run().changes;
  }

  private completeParent(
    payload: Extract<TrafficAuditWorkerCommand, { operation: 'completeParent' }>['payload'],
  ): number {
    const attributedAttempt = this.raw
      .prepare<
        [string],
        { accountId: string | null; model: string | null }
      >('SELECT account_id accountId, model FROM upstream_attempts WHERE parent_id=? ' + "ORDER BY CASE WHEN outcome='completed' AND status BETWEEN 200 AND 299 THEN 0 ELSE 1 END, " + 'attempt_index DESC LIMIT 1')
      .get(payload.id);
    return this.orm
      .update(requestLogs)
      .set({
        attributedAccountId: attributedAttempt?.accountId ?? null,
        cachedTokens: payload.cachedTokens,
        ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
        completedAt: payload.completedAt,
        durationMs: payload.durationMs,
        error: payload.error,
        inputTokens: payload.inputTokens,
        ...(payload.mappedModel === null ? {} : { mappedModel: payload.mappedModel }),
        outcome: payload.outcome,
        outputTokens: payload.outputTokens,
        physicalModel: attributedAttempt?.model ?? null,
        physicalModelFamily: attributedAttempt?.model
          ? getQuotaModelFamilyId(attributedAttempt.model)
          : null,
        hasTextOutput: payload.hasTextOutput,
        hasImageOutput: payload.hasImageOutput,
        reasoningTokens: payload.reasoningTokens,
        responseHeaders: payload.responseHeaders,
        responsePartial: Boolean(payload.responsePartial),
        status: payload.status,
      })
      .where(eq(requestLogs.id, payload.id))
      .run().changes;
  }

  private insertAttempt(
    payload: Extract<TrafficAuditWorkerCommand, { operation: 'insertAttempt' }>['payload'],
  ): number {
    return this.raw.transaction(() => {
      if (!this.raw.prepare('SELECT 1 FROM request_logs WHERE id=?').get(payload.parentId)) {
        return 0;
      }
      const changes = this.orm
        .insert(upstreamAttempts)
        .values({ ...payload, outcome: 'in_progress' })
        .run().changes;
      if (payload.model) {
        const current = this.orm
          .select({ mappedModel: requestLogs.mappedModel })
          .from(requestLogs)
          .where(eq(requestLogs.id, payload.parentId))
          .get();
        if (current?.mappedModel === null) {
          this.orm
            .update(requestLogs)
            .set({ mappedModel: payload.model })
            .where(eq(requestLogs.id, payload.parentId))
            .run();
        }
      }
      return changes;
    })();
  }

  private completeAttempt(
    payload: Extract<TrafficAuditWorkerCommand, { operation: 'completeAttempt' }>['payload'],
  ): number {
    return this.orm
      .update(upstreamAttempts)
      .set({
        timingJson: payload.timing ? JSON.stringify(payload.timing) : null,
        completedAt: payload.completedAt,
        durationMs: payload.durationMs,
        error: payload.error,
        outcome: payload.outcome,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        cachedTokens: payload.cachedTokens,
        reasoningTokens: payload.reasoningTokens,
        responseHeaders: payload.responseHeaders,
        responsePartial: Boolean(payload.responsePartial),
        status: payload.status,
      })
      .where(eq(upstreamAttempts.id, payload.id))
      .run().changes;
  }
}
