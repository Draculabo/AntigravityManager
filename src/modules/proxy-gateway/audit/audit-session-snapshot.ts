import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { and, asc, count, eq, isNull, placeholder, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { TrafficAuditQueries } from './traffic-audit-queries';
import {
  MAX_AUDIT_SESSION_REQUESTS,
  type AuditSessionSnapshot,
} from './audit-session-export.schema';
import { TrafficAuditDetailSchema } from './traffic-audit.types';
import { auditPayloads, requestLogs, upstreamAttempts } from './traffic-audit.schema';

const MAX_METADATA_CHARACTERS = 128 * 1024;
const MAX_SNAPSHOT_MS = 1000;

function metadataLength(columns: SQLiteColumn[]) {
  return sql<number>`${sql.join(
    columns.map((column) =>
      column.notNull ? sql`length(${column})` : sql`coalesce(length(${column}), 0)`,
    ),
    sql` + `,
  )}`;
}

function sumOrZero(value: SQL) {
  return sql<number>`coalesce(sum(${value}), 0)`;
}

/** Bounded settled metadata snapshot; no read transaction is held across file I/O. */
export function auditSessionSnapshot(
  raw: Database.Database,
  queries: TrafficAuditQueries,
  sessionId: string,
): AuditSessionSnapshot {
  const started = performance.now();
  const orm = drizzle(raw);
  const ids = orm
    .select({ id: requestLogs.id })
    .from(requestLogs)
    .where(and(eq(requestLogs.sessionId, sessionId), eq(requestLogs.trafficClass, 'model')))
    .orderBy(asc(requestLogs.timestamp), asc(requestLogs.id))
    .limit(MAX_AUDIT_SESSION_REQUESTS + 1)
    .all()
    .map((row) => row.id);
  if (ids.length > MAX_AUDIT_SESSION_REQUESTS) {
    throw new Error('Audit session export exceeds its request limit');
  }
  const parentSize = orm
    .select({
      bytes: metadataLength([
        requestLogs.id,
        requestLogs.url,
        requestLogs.method,
        requestLogs.protocol,
        requestLogs.trafficClass,
        requestLogs.requestHeaders,
        requestLogs.responseHeaders,
        requestLogs.requestQuery,
        requestLogs.error,
        requestLogs.sessionId,
        requestLogs.clientIp,
        requestLogs.username,
        requestLogs.model,
        requestLogs.mappedModel,
        requestLogs.physicalModel,
        requestLogs.physicalModelFamily,
        requestLogs.attributedAccountId,
        requestLogs.operation,
        requestLogs.outcome,
      ]),
      active: isNull(requestLogs.completedAt),
    })
    .from(requestLogs)
    .where(eq(requestLogs.id, placeholder('id')))
    .prepare();
  const attemptSize = orm
    .select({
      bytes: sumOrZero(
        metadataLength([
          upstreamAttempts.id,
          upstreamAttempts.parentId,
          upstreamAttempts.operation,
          upstreamAttempts.endpoint,
          upstreamAttempts.requestHeaders,
          upstreamAttempts.responseHeaders,
          upstreamAttempts.error,
          upstreamAttempts.accountId,
          upstreamAttempts.accountIdHash,
          upstreamAttempts.model,
          upstreamAttempts.outcome,
        ]),
      ),
      rows: count(),
      active: sumOrZero(isNull(upstreamAttempts.completedAt)),
    })
    .from(upstreamAttempts)
    .where(eq(upstreamAttempts.parentId, placeholder('id')))
    .prepare();
  const payloadSize = orm
    .select({
      bytes: sumOrZero(
        metadataLength([
          auditPayloads.id,
          auditPayloads.requestId,
          auditPayloads.kind,
          auditPayloads.representation,
          auditPayloads.state,
          auditPayloads.sha256,
          auditPayloads.sha256Scope,
          auditPayloads.terminalStatus,
          auditPayloads.errorSummary,
          auditPayloads.droppedReason,
        ]),
      ),
      rows: count(),
      active: sumOrZero(eq(auditPayloads.state, 'writing')),
    })
    .from(auditPayloads)
    .where(eq(auditPayloads.requestId, placeholder('id')))
    .prepare();
  const hash = createHash('sha256').update(`agm-audit-session-v1:${sessionId}`);
  for (const id of ids) {
    const parent = parentSize.get({ id });
    const attempts = attemptSize.get({ id });
    const payloads = payloadSize.get({ id });
    if (
      !parent ||
      !attempts ||
      !payloads ||
      parent.active ||
      attempts.active ||
      payloads.active ||
      parent.bytes > MAX_METADATA_CHARACTERS ||
      attempts.bytes > MAX_METADATA_CHARACTERS ||
      payloads.bytes > MAX_METADATA_CHARACTERS ||
      attempts.rows > 256 ||
      payloads.rows > 1024 ||
      performance.now() - started > MAX_SNAPSHOT_MS
    ) {
      throw new Error('Audit session is active or exceeds export metadata limits');
    }
    const detail = TrafficAuditDetailSchema.parse(queries.detail(id));
    if (detail.recordKind !== 'request') {
      throw new Error('Invalid audit session record');
    }
    const stableBodies = detail.bodies.toSorted((left, right) =>
      `${left.ownerKind}:${left.ownerId}:${left.direction}:${left.id}`.localeCompare(
        `${right.ownerKind}:${right.ownerId}:${right.direction}:${right.id}`,
      ),
    );
    hash.update(JSON.stringify({ ...detail, bodies: stableBodies }));
  }
  return { ids, fingerprint: hash.digest('hex') };
}
