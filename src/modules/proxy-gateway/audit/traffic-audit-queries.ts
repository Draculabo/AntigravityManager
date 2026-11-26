import type Database from 'better-sqlite3';
import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/sqlite-core';
import { iterateSqliteQuery } from '@/shared/persistence/database/iterate-sqlite-query';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { omit } from 'lodash-es';

import {
  attemptBodyRefs,
  auditAdminEvents,
  auditPayloadChunks,
  auditPayloads,
  requestBodyRefs,
  requestLogs,
  trafficAuditSchema,
  upstreamAttempts,
} from './traffic-audit.schema';
import type { TrafficAuditWorkerCommand } from './traffic-audit.worker-protocol';
import { auditCaptureOutcome } from './traffic-audit-recovery';
import { decodeUpstreamAttemptTiming } from './upstream-attempt-timing';
import { auditRequestListPredicate } from './audit-request-list-predicate';

type TrafficAuditDatabase = BetterSQLite3Database<typeof trafficAuditSchema>;

type ListInput = Extract<TrafficAuditWorkerCommand, { operation: 'list' }>['payload'];

function requestProjection(orm: TrafficAuditDatabase) {
  const forRequest = eq(upstreamAttempts.parentId, requestLogs.id);
  return {
    id: requestLogs.id,
    timestamp: requestLogs.timestamp,
    completedAt: requestLogs.completedAt,
    durationMs: requestLogs.durationMs,
    method: requestLogs.method,
    model: requestLogs.model,
    mappedModel: requestLogs.mappedModel,
    attributedAccountId: requestLogs.attributedAccountId,
    physicalModel: requestLogs.physicalModel,
    physicalModelFamily: requestLogs.physicalModelFamily,
    hasTextOutput: requestLogs.hasTextOutput,
    hasImageOutput: requestLogs.hasImageOutput,
    inputTokens: requestLogs.inputTokens,
    outputTokens: requestLogs.outputTokens,
    outcome: requestLogs.outcome,
    protocol: requestLogs.protocol,
    recordKind: sql<'request'>`${'request'}`.as('record_kind'),
    status: requestLogs.status,
    trafficClass: requestLogs.trafficClass,
    url: requestLogs.url,
    attemptCount: orm.$count(upstreamAttempts, forRequest).as('attempt_count'),
    failedAttemptCount: orm
      .$count(
        upstreamAttempts,
        and(
          forRequest,
          or(
            notInArray(upstreamAttempts.outcome, ['completed', 'in_progress']),
            gte(upstreamAttempts.status, 400),
          ),
        ),
      )
      .as('failed_attempt_count'),
  };
}

const bodyProjection = {
  chunkCount: auditPayloads.chunkCount,
  completedAt: auditPayloads.completedAt,
  droppedReason: auditPayloads.droppedReason,
  errorSummary: auditPayloads.errorSummary,
  id: auditPayloads.id,
  kind: auditPayloads.kind,
  logicalBytes: auditPayloads.logicalBytes,
  oversized: auditPayloads.oversized,
  parseErrorOffset: auditPayloads.parseErrorOffset,
  partial: auditPayloads.partial,
  representation: auditPayloads.representation,
  sha256: auditPayloads.sha256,
  sha256Scope: auditPayloads.sha256Scope,
  state: auditPayloads.state,
  storedBytes: auditPayloads.storedBytes,
  terminalStatus: auditPayloads.terminalStatus,
};

export class TrafficAuditQueries {
  public constructor(
    private readonly raw: Database.Database,
    private readonly orm: TrafficAuditDatabase,
  ) {}

  public list(payload: ListInput) {
    if (payload.trafficClass === 'system') {
      return this.listSystem(payload);
    }
    const where = auditRequestListPredicate(payload);
    const total = this.orm.select({ value: count() }).from(requestLogs).where(where).get()?.value;
    const items = this.orm
      .select(requestProjection(this.orm))
      .from(requestLogs)
      .where(where)
      .orderBy(desc(requestLogs.timestamp), desc(requestLogs.id))
      .limit(payload.limit)
      .offset(payload.offset)
      .all();
    return {
      items: items.map((item) => ({
        ...item,
        outcome: auditCaptureOutcome(item.outcome, item.completedAt),
      })),
      total: total ?? 0,
    };
  }

  private listSystem(payload: ListInput) {
    const blockRequests =
      payload.accountId ||
      payload.modelFamily ||
      payload.modality ||
      (payload.statusMode === 'exact' && payload.status === undefined);
    const statusFamily =
      payload.statusMode && /^[1-5]xx$/u.test(payload.statusMode)
        ? Number(payload.statusMode[0]) * 100
        : undefined;
    const status =
      payload.statusMode === 'unfinished'
        ? and(eq(requestLogs.outcome, 'in_progress'), isNull(requestLogs.completedAt))
        : payload.statusMode === 'no-status'
          ? isNull(requestLogs.status)
          : statusFamily !== undefined
            ? and(gte(requestLogs.status, statusFamily), lt(requestLogs.status, statusFamily + 100))
            : payload.status === undefined || (payload.statusMode && payload.statusMode !== 'exact')
              ? undefined
              : eq(requestLogs.status, payload.status);
    const search = payload.search ? `%${payload.search}%` : undefined;
    const requestWhere = and(
      eq(requestLogs.trafficClass, 'system'),
      blockRequests ? sql`0` : undefined,
      payload.sessionId ? eq(requestLogs.sessionId, payload.sessionId) : undefined,
      payload.from === undefined ? undefined : gte(requestLogs.timestamp, payload.from),
      payload.to === undefined ? undefined : lte(requestLogs.timestamp, payload.to),
      status,
      search
        ? or(
            ...[
              requestLogs.id,
              requestLogs.url,
              requestLogs.method,
              requestLogs.protocol,
              requestLogs.operation,
              requestLogs.model,
              requestLogs.mappedModel,
              requestLogs.sessionId,
              requestLogs.username,
            ].map((column) => like(column, search)),
            like(sql`cast(${requestLogs.status} as text)`, search),
          )
        : undefined,
    );
    const blockEvents =
      blockRequests ||
      payload.sessionId ||
      statusFamily !== undefined ||
      payload.statusMode === 'exact' ||
      payload.statusMode === 'unfinished' ||
      (payload.status !== undefined && !payload.statusMode);
    const adminWhere = and(
      blockEvents ? sql`0` : undefined,
      payload.from === undefined ? undefined : gte(auditAdminEvents.timestamp, payload.from),
      payload.to === undefined ? undefined : lte(auditAdminEvents.timestamp, payload.to),
      search
        ? or(
            like(auditAdminEvents.operation, search),
            like(auditAdminEvents.outcome, search),
            like(auditAdminEvents.error, search),
          )
        : undefined,
    );
    const requests = this.orm
      .select({
        ...requestProjection(this.orm),
        recordKind: sql<'request' | 'admin'>`${'request'}`.as('record_kind'),
      })
      .from(requestLogs)
      .where(requestWhere);
    const adminEvents = this.orm
      .select({
        id: sql<string>`${'admin:'} || ${auditAdminEvents.id}`,
        timestamp: auditAdminEvents.timestamp,
        completedAt: sql<null>`null`,
        durationMs: sql<null>`null`,
        method: sql<string>`${'ADMIN'}`,
        model: sql<null>`null`,
        mappedModel: sql<null>`null`,
        attributedAccountId: sql<null>`null`,
        physicalModel: sql<null>`null`,
        physicalModelFamily: sql<null>`null`,
        hasTextOutput: sql<null>`null`,
        hasImageOutput: sql<null>`null`,
        inputTokens: sql<null>`null`,
        outputTokens: sql<null>`null`,
        outcome: auditAdminEvents.outcome,
        protocol: sql<string>`${'admin-event'}`,
        recordKind: sql<'request' | 'admin'>`${'admin'}`,
        status: sql<null>`null`,
        trafficClass: sql<string>`${'system'}`,
        url: sql<string>`${'/admin/'} || ${auditAdminEvents.operation}`,
        attemptCount: sql<number>`1`,
        failedAttemptCount: sql<number>`0`,
      })
      .from(auditAdminEvents)
      .where(adminWhere);
    const union = unionAll(requests, adminEvents).as('system_rows');
    const items = this.orm
      .select()
      .from(union)
      .orderBy(desc(union.timestamp))
      .limit(payload.limit)
      .offset(payload.offset)
      .all()
      .map((row) => ({ ...row, outcome: auditCaptureOutcome(row.outcome, row.completedAt) }));
    const total = this.orm.select({ value: count() }).from(union).get()?.value ?? 0;
    return { items, total };
  }

  public filterOptions() {
    const accountIds = this.orm
      .selectDistinct({ id: upstreamAttempts.accountId })
      .from(upstreamAttempts)
      .where(and(isNotNull(upstreamAttempts.accountId), ne(upstreamAttempts.accountId, '')))
      .orderBy(upstreamAttempts.accountId)
      .all()
      .flatMap(({ id }) => (id === null ? [] : [id]));
    const modelFamilies = this.orm
      .selectDistinct({ id: requestLogs.physicalModelFamily })
      .from(requestLogs)
      .where(
        and(isNotNull(requestLogs.physicalModelFamily), ne(requestLogs.physicalModelFamily, '')),
      )
      .orderBy(requestLogs.physicalModelFamily)
      .all()
      .flatMap(({ id }) => (id === null ? [] : [id]));
    return { accountIds, modelFamilies };
  }

  public detail(id: string) {
    if (id.startsWith('admin:')) {
      const eventId = Number(id.slice('admin:'.length));
      if (!Number.isInteger(eventId)) {
        return null;
      }
      const event = this.orm
        .select()
        .from(auditAdminEvents)
        .where(eq(auditAdminEvents.id, eventId))
        .get();
      return event ? { event, recordKind: 'admin' as const } : null;
    }
    const request = this.orm.select().from(requestLogs).where(eq(requestLogs.id, id)).get();
    if (!request) {
      return null;
    }
    const attempts = this.orm
      .select()
      .from(upstreamAttempts)
      .where(eq(upstreamAttempts.parentId, id))
      .orderBy(upstreamAttempts.attemptIndex)
      .all();
    const bodies = this.bodyReferences(id).all();
    return {
      attempts: attempts.map((attempt) => ({
        ...omit(attempt, 'accountSubjectHash', 'accountGrantHash', 'timingJson'),
        timing: decodeUpstreamAttemptTiming(attempt.timingJson),
        outcome: auditCaptureOutcome(attempt.outcome, attempt.completedAt),
      })),
      bodies,
      recordKind: 'request' as const,
      request: { ...request, outcome: auditCaptureOutcome(request.outcome, request.completedAt) },
    };
  }

  private bodyReferences(id: string, byPayload = false) {
    const parents = this.orm
      .select({
        ...bodyProjection,
        ownerId: requestBodyRefs.requestId,
        ownerKind: sql<'parent' | 'attempt'>`${'parent'}`,
        direction: requestBodyRefs.direction,
      })
      .from(auditPayloads)
      .innerJoin(requestBodyRefs, eq(requestBodyRefs.payloadId, auditPayloads.id))
      .where(byPayload ? eq(auditPayloads.id, id) : eq(requestBodyRefs.requestId, id));
    const attempts = this.orm
      .select({
        ...bodyProjection,
        ownerId: attemptBodyRefs.attemptId,
        ownerKind: sql<'parent' | 'attempt'>`${'attempt'}`,
        direction: attemptBodyRefs.direction,
      })
      .from(auditPayloads)
      .innerJoin(attemptBodyRefs, eq(attemptBodyRefs.payloadId, auditPayloads.id));
    return unionAll(
      parents,
      byPayload
        ? attempts.where(eq(auditPayloads.id, id))
        : attempts
            .innerJoin(upstreamAttempts, eq(upstreamAttempts.id, attemptBodyRefs.attemptId))
            .where(eq(upstreamAttempts.parentId, id)),
    );
  }

  private descriptorForPayload(id: string) {
    return this.bodyReferences(id, true).limit(1).get() ?? null;
  }

  private iterateChunks(id: string, cursor?: number) {
    return iterateSqliteQuery<{ seq: number; payload: Buffer; byte_length: number }>(
      this.raw,
      this.orm
        .select({
          seq: auditPayloadChunks.sequence,
          payload: auditPayloadChunks.payload,
          byte_length: auditPayloadChunks.byteLength,
        })
        .from(auditPayloadChunks)
        .where(
          and(
            eq(auditPayloadChunks.payloadId, id),
            cursor === undefined ? undefined : gte(auditPayloadChunks.sequence, cursor),
          ),
        )
        .orderBy(auditPayloadChunks.sequence),
    );
  }

  public bodyPage(
    payload: Extract<TrafficAuditWorkerCommand, { operation: 'bodyPage' }>['payload'],
  ) {
    const body = this.descriptorForPayload(payload.bodyId);
    if (!body) {
      return null;
    }
    const rows = this.iterateChunks(payload.bodyId, payload.cursor);
    const chunks: Array<{ data: string; sequence: number }> = [];
    let bytes = 0;
    for (const row of rows) {
      if (chunks.length > 0 && bytes + row.byte_length > payload.limitBytes) {
        break;
      }
      chunks.push({ data: row.payload.toString('utf8'), sequence: row.seq });
      bytes += row.byte_length;
      if (bytes >= payload.limitBytes) {
        break;
      }
    }
    const last = chunks.at(-1)?.sequence ?? payload.cursor - 1;
    const next = this.orm
      .select({ sequence: auditPayloadChunks.sequence })
      .from(auditPayloadChunks)
      .where(
        and(
          eq(auditPayloadChunks.payloadId, payload.bodyId),
          gt(auditPayloadChunks.sequence, last),
        ),
      )
      .orderBy(auditPayloadChunks.sequence)
      .limit(1)
      .get();
    return {
      body,
      chunks,
      complete: !next,
      nextCursor: next?.sequence ?? null,
    };
  }

  public bodySearch(
    payload: Extract<TrafficAuditWorkerCommand, { operation: 'bodySearch' }>['payload'],
  ) {
    const rows = this.iterateChunks(payload.bodyId);
    const needle = payload.query.toLocaleLowerCase();
    const matches: Array<{
      chunkOffset: number;
      length: number;
      offset: number;
      sequence: number;
      snippet: string;
    }> = [];
    let absoluteOffset = 0;
    let carry = '';
    let previousSequence = 0;
    let previousLength = 0;
    let lastMatchOffset = -1;
    for (const row of rows) {
      const text = row.payload.toString('utf8');
      const combined = carry + text;
      const combinedLower = combined.toLocaleLowerCase();
      const combinedOffset = absoluteOffset - carry.length;
      let index = combinedLower.indexOf(needle);
      while (index >= 0) {
        const offset = combinedOffset + index;
        if (offset > lastMatchOffset) {
          const startsInPreviousChunk = index < carry.length;
          matches.push({
            chunkOffset: startsInPreviousChunk
              ? previousLength - carry.length + index
              : index - carry.length,
            length: payload.query.length,
            offset,
            sequence: startsInPreviousChunk ? previousSequence : row.seq,
            snippet: combined.slice(Math.max(0, index - 80), index + payload.query.length + 80),
          });
          lastMatchOffset = offset;
          if (matches.length >= payload.limit) {
            return { matches, truncated: true };
          }
        }
        index = combinedLower.indexOf(needle, index + Math.max(1, needle.length));
      }
      absoluteOffset += text.length;
      const overlap = Math.max(0, payload.query.length - 1);
      carry = overlap > 0 ? combined.slice(-overlap) : '';
      previousSequence = row.seq;
      previousLength = text.length;
    }
    return { matches, truncated: false };
  }
}
