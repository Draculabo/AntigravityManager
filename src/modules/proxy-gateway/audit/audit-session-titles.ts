import type Database from 'better-sqlite3';
import { and, asc, between, eq, lte, placeholder } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  AuditConversationBodySchema,
  firstAuditUserText,
  prepareAuditConversationBodyReader,
} from './audit-conversation-text';
import { AUDIT_SESSION_TITLE_LIMIT } from './usage-overview.schema';
import { auditPayloads, requestBodyRefs, requestLogs } from './traffic-audit.schema';

const TITLE_BODY_LIMIT = 128 * 1024;
const TITLE_CHUNK_LIMIT = 64;

function truncateTitle(text: string) {
  if (text.length <= AUDIT_SESSION_TITLE_LIMIT) {
    return text;
  }
  const prefix = text.slice(0, AUDIT_SESSION_TITLE_LIMIT - 1).replace(/\p{Surrogate}$/u, '');
  return `${prefix.trimEnd()}…`;
}

export function readAuditSessionTitles(db: Database.Database, keys: string[], to: number) {
  const titles = new Map<string, string>();
  if (!keys.length) {
    return titles;
  }
  const orm = drizzle(db);
  const initial = orm
    .select({ id: requestLogs.id, timestamp: requestLogs.timestamp })
    .from(requestLogs)
    .where(
      and(
        eq(requestLogs.sessionId, placeholder('key')),
        lte(requestLogs.timestamp, to),
        eq(requestLogs.trafficClass, 'model'),
      ),
    )
    .orderBy(asc(requestLogs.timestamp), asc(requestLogs.id))
    .limit(32)
    .as('initial');
  const findCandidates = orm
    .select({
      id: auditPayloads.id,
      storedBytes: auditPayloads.storedBytes,
      chunkCount: auditPayloads.chunkCount,
    })
    .from(initial)
    .innerJoin(
      requestBodyRefs,
      and(eq(requestBodyRefs.requestId, initial.id), eq(requestBodyRefs.direction, 'request')),
    )
    .innerJoin(
      auditPayloads,
      and(eq(auditPayloads.id, requestBodyRefs.payloadId), eq(auditPayloads.requestId, initial.id)),
    )
    .where(
      and(
        lte(auditPayloads.completedAt, to),
        eq(auditPayloads.kind, 'json'),
        eq(auditPayloads.representation, 'sanitized_json'),
        eq(auditPayloads.state, 'complete'),
        eq(auditPayloads.partial, false),
        eq(auditPayloads.oversized, false),
        between(auditPayloads.storedBytes, 1, TITLE_BODY_LIMIT),
        between(auditPayloads.chunkCount, 1, TITLE_CHUNK_LIMIT),
      ),
    )
    .orderBy(asc(initial.timestamp), asc(initial.id))
    .limit(4)
    .prepare();
  const readBody = prepareAuditConversationBodyReader(db);
  const candidates = AuditConversationBodySchema.array();
  for (const key of keys) {
    const bodies = candidates.parse(findCandidates.all({ key }));
    for (const body of bodies) {
      const root = readBody(body);
      const title = root && firstAuditUserText(root);
      if (title) {
        titles.set(key, truncateTitle(title));
        break;
      }
    }
  }
  return titles;
}
