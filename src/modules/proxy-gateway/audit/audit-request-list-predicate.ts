import { and, eq, gte, isNull, like, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { requestLogs } from './traffic-audit.schema';
import { observedAuditClient } from './audit-client-identity';
import type { TrafficAuditListInput } from './traffic-audit.types';

export function auditRequestListPredicate(
  payload: Omit<TrafficAuditListInput, 'limit' | 'offset'>,
) {
  const conditions: SQL[] = [];
  if (payload.from !== undefined) {
    conditions.push(gte(requestLogs.timestamp, payload.from));
  }
  if (payload.to !== undefined) {
    conditions.push(lte(requestLogs.timestamp, payload.to));
  }
  if (payload.protocol) {
    conditions.push(eq(requestLogs.protocol, payload.protocol));
  }
  if (payload.client) {
    conditions.push(
      sql`(${sql.raw(observedAuditClient('request_logs.request_headers'))})=${payload.client}`,
    );
  }
  if (payload.sessionId) {
    conditions.push(eq(requestLogs.sessionId, payload.sessionId));
  }
  if (payload.accountId) {
    conditions.push(eq(requestLogs.attributedAccountId, payload.accountId));
  }
  if (payload.attemptAccountId || payload.attemptModel || payload.usageState) {
    const asOf = payload.usageAsOf ?? payload.to;
    const anyAttempt = sql`SELECT 1 FROM upstream_attempts a WHERE a.parent_id=${requestLogs.id}
      AND ${asOf === undefined ? sql`1=1` : sql`a.timestamp<=${asOf}`}`;
    const generation = sql`${anyAttempt} AND
      (a.usage_scope='generation' OR (a.usage_scope IS NULL AND ${requestLogs.trafficClass}='model'))`;
    if (payload.attemptAccountId || payload.attemptModel) {
      conditions.push(sql`EXISTS (${generation}
        AND ${payload.attemptAccountId ? sql`a.account_id=${payload.attemptAccountId}` : sql`1=1`}
        AND ${payload.attemptModel ? sql`a.model=${payload.attemptModel}` : sql`1=1`}
      )`);
    } else if (payload.usageState) {
      conditions.push(sql`(EXISTS (${generation}) OR NOT EXISTS (${anyAttempt}))`);
    }
    if (payload.usageState === 'retried') {
      conditions.push(sql`EXISTS (${generation} LIMIT 1 OFFSET 1)`);
    } else if (payload.usageState === 'failed') {
      conditions.push(sql`(${requestLogs.status}>=400 OR
        ${requestLogs.outcome} IN ('upstream_error','internal_error','timeout','auth_failed'))`);
      conditions.push(
        asOf === undefined
          ? sql`${requestLogs.completedAt} IS NOT NULL`
          : lte(requestLogs.completedAt, asOf),
      );
    }
  }
  if (payload.modelFamily) {
    conditions.push(eq(requestLogs.physicalModelFamily, payload.modelFamily));
  }
  if (payload.modality === 'text') {
    conditions.push(eq(requestLogs.hasTextOutput, true));
  } else if (payload.modality === 'image') {
    conditions.push(eq(requestLogs.hasImageOutput, true));
  } else if (payload.modality === 'none') {
    conditions.push(
      and(eq(requestLogs.hasTextOutput, false), eq(requestLogs.hasImageOutput, false))!,
    );
  } else if (payload.modality === 'unknown') {
    conditions.push(and(isNull(requestLogs.hasTextOutput), isNull(requestLogs.hasImageOutput))!);
  }
  if (payload.model) {
    const pattern = `%${payload.model}%`;
    const modelCondition = or(
      like(requestLogs.model, pattern),
      like(requestLogs.mappedModel, pattern),
    );
    if (modelCondition) {
      conditions.push(modelCondition);
    }
  }
  if (payload.statusMode === 'unfinished') {
    conditions.push(and(eq(requestLogs.outcome, 'in_progress'), isNull(requestLogs.completedAt))!);
  } else if (payload.statusMode === 'no-status') {
    conditions.push(isNull(requestLogs.status));
  } else if (payload.statusMode === 'exact' && payload.status === undefined) {
    conditions.push(sql`1=0`);
  } else if (payload.statusMode && /^[1-5]xx$/u.test(payload.statusMode)) {
    const lower = Number(payload.statusMode[0]) * 100;
    conditions.push(and(gte(requestLogs.status, lower), lt(requestLogs.status, lower + 100))!);
  } else if (
    payload.status !== undefined &&
    (payload.statusMode === 'exact' || !payload.statusMode)
  ) {
    conditions.push(eq(requestLogs.status, payload.status));
  }
  if (payload.trafficClass) {
    conditions.push(eq(requestLogs.trafficClass, payload.trafficClass));
  }
  if (payload.requestId) {
    conditions.push(like(requestLogs.id, `%${payload.requestId}%`));
  }
  if (payload.search) {
    const pattern = `%${payload.search}%`;
    const searchCondition = or(
      like(requestLogs.id, pattern),
      like(requestLogs.url, pattern),
      like(requestLogs.method, pattern),
      like(requestLogs.protocol, pattern),
      like(requestLogs.operation, pattern),
      like(requestLogs.model, pattern),
      like(requestLogs.mappedModel, pattern),
      like(requestLogs.sessionId, pattern),
      like(requestLogs.username, pattern),
      sql`CAST(${requestLogs.status} AS TEXT) LIKE ${pattern}`,
    );
    if (searchCondition) {
      conditions.push(searchCondition);
    }
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}
