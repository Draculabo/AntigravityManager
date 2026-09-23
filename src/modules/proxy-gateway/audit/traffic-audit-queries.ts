import Database from 'better-sqlite3';
import { and, count, desc, eq, gte, isNull, like, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  auditAdminEvents,
  requestLogs,
  trafficAuditSchema,
  upstreamAttempts,
} from './traffic-audit.schema';
import type { TrafficAuditWorkerCommand } from './traffic-audit.worker-protocol';

type TrafficAuditDatabase = BetterSQLite3Database<typeof trafficAuditSchema>;

interface BodyDescriptorRow {
  chunk_count: number;
  completed_at: number | null;
  direction: string;
  dropped_reason: string | null;
  error_summary: string | null;
  id: string;
  kind: string;
  logical_bytes: number;
  oversized: number;
  owner_id: string;
  owner_kind: string;
  parse_error_offset: number | null;
  partial: number;
  representation: string;
  sha256: string | null;
  sha256_scope: string;
  state: string;
  stored_bytes: number;
  terminal_status: string | null;
}

interface PayloadChunkRow {
  byteLength: number;
  payload: Buffer;
  sequence: number;
}

interface SystemListRow {
  [key: string]: unknown;
  hasImageOutput: number | null;
  hasTextOutput: number | null;
}

const BODY_REFS_SQL =
  "SELECT p.*,r.request_id owner_id,'parent' owner_kind,r.direction FROM audit_payloads p " +
  'JOIN request_body_refs r ON r.payload_id=p.id WHERE r.request_id=? UNION ALL ' +
  "SELECT p.*,r.attempt_id owner_id,'attempt' owner_kind,r.direction FROM audit_payloads p " +
  'JOIN attempt_body_refs r ON r.payload_id=p.id JOIN upstream_attempts a ON a.id=r.attempt_id WHERE a.parent_id=?';

export class TrafficAuditQueries {
  public constructor(
    private readonly raw: Database.Database,
    private readonly orm: TrafficAuditDatabase,
  ) {}

  public list(payload: Extract<TrafficAuditWorkerCommand, { operation: 'list' }>['payload']) {
    if (payload.trafficClass === 'system') {
      return this.listSystem(payload);
    }
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
    if (payload.accountId) {
      conditions.push(eq(requestLogs.attributedAccountId, payload.accountId));
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
      conditions.push(
        and(eq(requestLogs.outcome, 'in_progress'), isNull(requestLogs.completedAt))!,
      );
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
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const totalQuery = this.orm.select({ value: count() }).from(requestLogs);
    const itemsQuery = this.orm
      .select({
        attributedAccountId: requestLogs.attributedAccountId,
        completedAt: requestLogs.completedAt,
        durationMs: requestLogs.durationMs,
        id: requestLogs.id,
        hasImageOutput: requestLogs.hasImageOutput,
        hasTextOutput: requestLogs.hasTextOutput,
        inputTokens: requestLogs.inputTokens,
        mappedModel: requestLogs.mappedModel,
        method: requestLogs.method,
        model: requestLogs.model,
        outcome: requestLogs.outcome,
        outputTokens: requestLogs.outputTokens,
        physicalModel: requestLogs.physicalModel,
        physicalModelFamily: requestLogs.physicalModelFamily,
        protocol: requestLogs.protocol,
        recordKind: sql<'request'>`'request'`,
        status: requestLogs.status,
        timestamp: requestLogs.timestamp,
        trafficClass: requestLogs.trafficClass,
        url: requestLogs.url,
      })
      .from(requestLogs);
    const total = where ? totalQuery.where(where).get()?.value : totalQuery.get()?.value;
    const items = (where ? itemsQuery.where(where) : itemsQuery)
      .orderBy(desc(requestLogs.timestamp))
      .limit(payload.limit)
      .offset(payload.offset)
      .all();
    return { items, total: total ?? 0 };
  }

  private listSystem(
    payload: Extract<TrafficAuditWorkerCommand, { operation: 'list' }>['payload'],
  ) {
    const clauses = ["traffic_class='system'"];
    const bindings: Record<string, number | string> = {};
    if (payload.from !== undefined) {
      clauses.push('timestamp>=@from');
      bindings.from = payload.from;
    }
    if (payload.to !== undefined) {
      clauses.push('timestamp<=@to');
      bindings.to = payload.to;
    }
    if (payload.status !== undefined) {
      if (payload.statusMode === 'exact' || !payload.statusMode) {
        clauses.push('status=@status');
        bindings.status = payload.status;
      }
    }
    if (payload.statusMode === 'exact' && payload.status === undefined) {
      clauses.push('1=0');
    }
    if (payload.statusMode === 'unfinished') {
      clauses.push("outcome='in_progress' AND completed_at IS NULL");
    } else if (payload.statusMode === 'no-status') {
      clauses.push('status IS NULL');
    } else if (payload.statusMode && /^[1-5]xx$/u.test(payload.statusMode)) {
      const lower = Number(payload.statusMode[0]) * 100;
      clauses.push('status>=@statusLower AND status<@statusUpper');
      bindings.statusLower = lower;
      bindings.statusUpper = lower + 100;
    }
    if (payload.accountId || payload.modelFamily || payload.modality) {
      clauses.push('1=0');
    }
    const requestWhere = clauses.join(' AND ');
    const requestSearch = payload.search
      ? ' AND (id LIKE @search OR url LIKE @search OR method LIKE @search OR protocol LIKE @search ' +
        'OR operation LIKE @search OR model LIKE @search OR mapped_model LIKE @search ' +
        'OR session_id LIKE @search OR username LIKE @search OR CAST(status AS TEXT) LIKE @search)'
      : '';
    const adminClauses: string[] = [];
    if (payload.from !== undefined) {
      adminClauses.push('timestamp>=@from');
    }
    if (payload.to !== undefined) {
      adminClauses.push('timestamp<=@to');
    }
    if (
      payload.statusMode === 'unfinished' ||
      payload.statusMode === 'exact' ||
      (payload.statusMode && /^[1-5]xx$/u.test(payload.statusMode)) ||
      (payload.status !== undefined && !payload.statusMode)
    ) {
      adminClauses.push('1=0');
    }
    if (payload.accountId || payload.modelFamily || payload.modality) {
      adminClauses.push('1=0');
    }
    if (payload.search) {
      adminClauses.push('(operation LIKE @search OR outcome LIKE @search OR error LIKE @search)');
    }
    const adminWhere = adminClauses.length > 0 ? ` WHERE ${adminClauses.join(' AND ')}` : '';
    if (payload.search) {
      bindings.search = `%${payload.search}%`;
    }
    const union =
      'SELECT id,timestamp,completed_at completedAt,duration_ms durationMs,method,model,' +
      'mapped_model mappedModel,attributed_account_id attributedAccountId,' +
      'physical_model physicalModel,physical_model_family physicalModelFamily,' +
      'has_text_output hasTextOutput,has_image_output hasImageOutput,' +
      'input_tokens inputTokens,output_tokens outputTokens,' +
      "outcome,protocol,'request' recordKind,status,traffic_class trafficClass,url " +
      `FROM request_logs WHERE ${requestWhere}${requestSearch} UNION ALL ` +
      "SELECT 'admin:'||id id,timestamp,NULL completedAt,NULL durationMs,'ADMIN' method,NULL model," +
      'NULL mappedModel,NULL attributedAccountId,NULL physicalModel,NULL physicalModelFamily,' +
      'NULL hasTextOutput,NULL hasImageOutput,NULL inputTokens,NULL outputTokens,' +
      "outcome,'admin-event' protocol,'admin' recordKind,NULL status," +
      "'system' trafficClass,'/admin/'||operation url FROM audit_admin_events" +
      adminWhere;
    const items = this.raw
      .prepare<Record<string, number | string>, SystemListRow>(
        `${union} ORDER BY timestamp DESC LIMIT @limit OFFSET @offset`,
      )
      .all({ ...bindings, limit: payload.limit, offset: payload.offset })
      .map((row) => ({
        ...row,
        hasImageOutput: row.hasImageOutput === null ? null : Boolean(row.hasImageOutput),
        hasTextOutput: row.hasTextOutput === null ? null : Boolean(row.hasTextOutput),
      }));
    const total = this.raw.prepare(`SELECT COUNT(*) value FROM (${union})`).get(bindings) as
      | { value: number }
      | undefined;
    return { items, total: total?.value ?? 0 };
  }

  public filterOptions() {
    const accountIds = this.raw
      .prepare<[], { id: string }>(
        "SELECT DISTINCT account_id id FROM upstream_attempts WHERE account_id IS NOT NULL AND account_id<>'' ORDER BY account_id",
      )
      .all()
      .map((row) => row.id);
    const modelFamilies = this.raw
      .prepare<[], { id: string }>(
        "SELECT DISTINCT physical_model_family id FROM request_logs WHERE physical_model_family IS NOT NULL AND physical_model_family<>'' ORDER BY physical_model_family",
      )
      .all()
      .map((row) => row.id);
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
    const bodies = this.raw
      .prepare<[string, string], BodyDescriptorRow>(BODY_REFS_SQL)
      .all(id, id)
      .map(normalizeBodyDescriptor);
    return { attempts, bodies, recordKind: 'request' as const, request };
  }

  private descriptorForPayload(id: string) {
    const row = this.raw
      .prepare<
        [string, string],
        BodyDescriptorRow
      >("SELECT p.*,r.request_id owner_id,'parent' owner_kind,r.direction FROM audit_payloads p " + 'JOIN request_body_refs r ON r.payload_id=p.id WHERE p.id=? UNION ALL ' + "SELECT p.*,r.attempt_id owner_id,'attempt' owner_kind,r.direction FROM audit_payloads p " + 'JOIN attempt_body_refs r ON r.payload_id=p.id WHERE p.id=? LIMIT 1')
      .get(id, id);
    return row ? normalizeBodyDescriptor(row) : null;
  }

  public bodyPage(
    payload: Extract<TrafficAuditWorkerCommand, { operation: 'bodyPage' }>['payload'],
  ) {
    const body = this.descriptorForPayload(payload.bodyId);
    if (!body) {
      return null;
    }
    const rows = this.raw
      .prepare<
        [string, number],
        PayloadChunkRow
      >('SELECT seq sequence,payload,byte_length byteLength FROM audit_payload_chunks ' + 'WHERE payload_id=? AND seq>=? ORDER BY seq ASC')
      .iterate(payload.bodyId, payload.cursor);
    const chunks: Array<{ data: string; sequence: number }> = [];
    let bytes = 0;
    for (const row of rows) {
      if (chunks.length > 0 && bytes + row.byteLength > payload.limitBytes) {
        break;
      }
      chunks.push({ data: row.payload.toString('utf8'), sequence: row.sequence });
      bytes += row.byteLength;
      if (bytes >= payload.limitBytes) {
        break;
      }
    }
    const last = chunks.at(-1)?.sequence ?? payload.cursor - 1;
    const next = this.raw
      .prepare<
        [string, number],
        { sequence: number }
      >('SELECT seq sequence FROM audit_payload_chunks WHERE payload_id=? AND seq>? ' + 'ORDER BY seq ASC LIMIT 1')
      .get(payload.bodyId, last);
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
    const rows = this.raw
      .prepare<
        [string],
        PayloadChunkRow
      >('SELECT seq sequence,payload,byte_length byteLength FROM audit_payload_chunks ' + 'WHERE payload_id=? ORDER BY seq ASC')
      .iterate(payload.bodyId);
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
            sequence: startsInPreviousChunk ? previousSequence : row.sequence,
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
      previousSequence = row.sequence;
      previousLength = text.length;
    }
    return { matches, truncated: false };
  }
}

function normalizeBodyDescriptor(row: BodyDescriptorRow) {
  return {
    chunkCount: row.chunk_count,
    completedAt: row.completed_at,
    direction: row.direction,
    droppedReason: row.dropped_reason,
    errorSummary: row.error_summary,
    id: row.id,
    kind: row.kind,
    logicalBytes: row.logical_bytes,
    oversized: Boolean(row.oversized),
    ownerId: row.owner_id,
    ownerKind: row.owner_kind,
    parseErrorOffset: row.parse_error_offset,
    partial: Boolean(row.partial),
    representation: row.representation,
    sha256: row.sha256,
    sha256Scope: row.sha256_scope,
    state: row.state,
    storedBytes: row.stored_bytes,
    terminalStatus: row.terminal_status,
  };
}
