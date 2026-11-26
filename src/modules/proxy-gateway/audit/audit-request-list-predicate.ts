import {
  and,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/sqlite-core';
import { requestLogs, upstreamAttempts } from './traffic-audit.schema';
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
    conditions.push(eq(observedAuditClient(requestLogs.requestHeaders), payload.client));
  }
  if (payload.sessionId) {
    conditions.push(eq(requestLogs.sessionId, payload.sessionId));
  }
  if (payload.accountId) {
    conditions.push(eq(requestLogs.attributedAccountId, payload.accountId));
  }
  if (payload.attemptAccountId || payload.attemptModel || payload.usageState) {
    const asOf = payload.usageAsOf ?? payload.to;
    const attempts = new QueryBuilder();
    const observed = and(
      eq(upstreamAttempts.parentId, requestLogs.id),
      asOf === undefined ? undefined : lte(upstreamAttempts.timestamp, asOf),
    );
    const generation = and(
      observed,
      or(
        eq(upstreamAttempts.usageScope, 'generation'),
        and(isNull(upstreamAttempts.usageScope), eq(requestLogs.trafficClass, 'model')),
      ),
    );
    const query = () => attempts.select({ id: upstreamAttempts.id }).from(upstreamAttempts);
    if (payload.attemptAccountId || payload.attemptModel) {
      conditions.push(
        exists(
          query().where(
            and(
              generation,
              payload.attemptAccountId
                ? eq(upstreamAttempts.accountId, payload.attemptAccountId)
                : undefined,
              payload.attemptModel ? eq(upstreamAttempts.model, payload.attemptModel) : undefined,
            ),
          ),
        ),
      );
    } else if (payload.usageState) {
      const matching = or(exists(query().where(generation)), notExists(query().where(observed)));
      if (matching) {
        conditions.push(matching);
      }
    }
    if (payload.usageState === 'retried') {
      conditions.push(exists(query().where(generation).limit(1).offset(1)));
    } else if (payload.usageState === 'failed') {
      const failed = or(
        gte(requestLogs.status, 400),
        inArray(requestLogs.outcome, [
          'upstream_error',
          'internal_error',
          'timeout',
          'auth_failed',
        ]),
      );
      if (failed) {
        conditions.push(failed);
      }
      conditions.push(
        asOf === undefined
          ? isNotNull(requestLogs.completedAt)
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
