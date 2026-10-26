import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TrafficAuditQueries } from './traffic-audit-queries';
import {
  MAX_AUDIT_SESSION_REQUESTS,
  type AuditSessionSnapshot,
} from './audit-session-export.schema';
import { TrafficAuditDetailSchema } from './traffic-audit.types';

const MAX_METADATA_CHARACTERS = 128 * 1024;
const MAX_SNAPSHOT_MS = 1000;
/** Bounded settled metadata snapshot; no read transaction is held across file I/O. */
export function auditSessionSnapshot(
  raw: Database.Database,
  queries: TrafficAuditQueries,
  sessionId: string,
): AuditSessionSnapshot {
  const started = performance.now();
  const ids = raw
    .prepare<[string, number], { id: string }>(
      "SELECT id FROM request_logs WHERE session_id=? AND traffic_class='model' ORDER BY timestamp,id LIMIT ?",
    )
    .all(sessionId, MAX_AUDIT_SESSION_REQUESTS + 1)
    .map((row) => row.id);
  if (ids.length > MAX_AUDIT_SESSION_REQUESTS) {
    throw new Error('Audit session export exceeds its request limit');
  }
  const parentSize = raw.prepare<[string], { bytes: number; active: number }>(`SELECT
    length(id)+length(url)+length(method)+length(protocol)+length(traffic_class)+length(request_headers)+
    coalesce(length(response_headers),0)+coalesce(length(request_query),0)+coalesce(length(error),0)+
    coalesce(length(session_id),0)+coalesce(length(client_ip),0)+coalesce(length(username),0)+
    coalesce(length(model),0)+coalesce(length(mapped_model),0)+coalesce(length(physical_model),0)+
    coalesce(length(physical_model_family),0)+coalesce(length(attributed_account_id),0)+coalesce(length(operation),0)+length(outcome) bytes,
    completed_at IS NULL active FROM request_logs WHERE id=?`);
  const attemptSize = raw.prepare<
    [string],
    { bytes: number; rows: number; active: number }
  >(`SELECT count(*) rows,coalesce(sum(
    length(id)+length(parent_id)+length(operation)+length(endpoint)+length(request_headers)+
    coalesce(length(response_headers),0)+coalesce(length(error),0)+coalesce(length(account_id),0)+
    coalesce(length(account_id_hash),0)+coalesce(length(model),0)+length(outcome)),0) bytes,
    coalesce(sum(completed_at IS NULL),0) active FROM upstream_attempts WHERE parent_id=?`);
  const payloadSize = raw.prepare<
    [string],
    { bytes: number; rows: number; active: number }
  >(`SELECT count(*) rows,coalesce(sum(
    length(id)+length(request_id)+length(kind)+length(representation)+length(state)+
    coalesce(length(sha256),0)+length(sha256_scope)+coalesce(length(terminal_status),0)+
    coalesce(length(error_summary),0)+coalesce(length(dropped_reason),0)),0) bytes,
    coalesce(sum(state='writing'),0) active FROM audit_payloads WHERE request_id=?`);
  const hash = createHash('sha256').update(`agm-audit-session-v1:${sessionId}`);
  for (const id of ids) {
    const parent = parentSize.get(id);
    const attempts = attemptSize.get(id);
    const payloads = payloadSize.get(id);
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
