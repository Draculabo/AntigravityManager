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
import type { TrafficAuditWorkerCommand } from './traffic-audit.worker-protocol';

type TrafficAuditDatabase = BetterSQLite3Database<typeof trafficAuditSchema>;
export class TrafficAuditRepository {
  private readonly raw: Database.Database;
  private readonly orm: TrafficAuditDatabase;
  private readonly queries: TrafficAuditQueries;
  private readonly retention: TrafficAuditRetention;
  private readonly payloads: TrafficAuditPayloads;

  public constructor(databasePath: string) {
    this.raw = openTrafficAuditDatabase(databasePath);
    configureTrafficAuditDatabase(this.raw);
    initializeTrafficAuditSchema(this.raw);
    this.orm = drizzle(this.raw, { schema: trafficAuditSchema });
    this.queries = new TrafficAuditQueries(this.raw, this.orm);
    this.retention = new TrafficAuditRetention(databasePath, this.raw, this.orm);
    this.payloads = new TrafficAuditPayloads(this.raw, this.orm);
    this.raw
      .prepare(
        "UPDATE audit_payloads SET state='incomplete',partial=1," +
          "dropped_reason=COALESCE(dropped_reason,'worker_restart')," +
          'stored_bytes=COALESCE((SELECT SUM(byte_length) FROM audit_payload_chunks ' +
          'WHERE payload_id=audit_payloads.id),0),chunk_count=(SELECT COUNT(*) FROM ' +
          "audit_payload_chunks WHERE payload_id=audit_payloads.id),completed_at=? WHERE state='writing'",
      )
      .run(Date.now());
  }

  public execute(command: TrafficAuditWorkerCommand): unknown {
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
      case 'clear': {
        if (command.payload.trafficClass === 'system') {
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
            return requests + events;
          })();
        }
        if (command.payload.trafficClass) {
          const rows =
            this.orm
              .select({ value: count() })
              .from(requestLogs)
              .where(eq(requestLogs.trafficClass, command.payload.trafficClass))
              .get()?.value ?? 0;
          this.orm
            .delete(requestLogs)
            .where(eq(requestLogs.trafficClass, command.payload.trafficClass))
            .run();
          return rows;
        }
        const rows = this.orm.select({ value: count() }).from(requestLogs).get()?.value ?? 0;
        const events = this.orm.select({ value: count() }).from(auditAdminEvents).get()?.value ?? 0;
        this.orm.delete(requestLogs).run();
        this.orm.delete(auditAdminEvents).run();
        return rows + events;
      }
      case 'stats':
        return this.retention.stats();
      case 'maintenance':
        return this.retention.maintenance(command.payload);
      case 'configure':
        return this.retention.maintenance(command.payload);
      case 'shutdown':
        this.raw.pragma('wal_checkpoint(TRUNCATE)');
        this.raw.close();
        return true;
    }
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
        completedAt: payload.completedAt,
        durationMs: payload.durationMs,
        error: payload.error,
        outcome: payload.outcome,
        responseHeaders: payload.responseHeaders,
        responsePartial: Boolean(payload.responsePartial),
        status: payload.status,
      })
      .where(eq(upstreamAttempts.id, payload.id))
      .run().changes;
  }
}
