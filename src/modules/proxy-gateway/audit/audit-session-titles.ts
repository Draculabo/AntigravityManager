import type Database from 'better-sqlite3';
import {
  AuditConversationBodySchema,
  firstAuditUserText,
  prepareAuditConversationBodyReader,
} from './audit-conversation-text';
import { AUDIT_SESSION_TITLE_LIMIT } from './usage-overview.schema';

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
  const findCandidates = db.prepare(`
    WITH initial AS MATERIALIZED (
      SELECT id,timestamp FROM request_logs WHERE session_id=? AND timestamp<=?
      AND traffic_class='model' ORDER BY timestamp,id LIMIT 32
    )
    SELECT p.id, p.stored_bytes AS storedBytes, p.chunk_count AS chunkCount
    FROM initial r
    JOIN request_body_refs ref ON ref.request_id=r.id AND ref.direction='request'
    JOIN audit_payloads p ON p.id=ref.payload_id AND p.request_id=r.id
    WHERE p.completed_at<=? AND p.kind='json' AND p.representation='sanitized_json'
      AND p.state='complete' AND p.partial=0 AND p.oversized=0
      AND p.stored_bytes BETWEEN 1 AND ? AND p.chunk_count BETWEEN 1 AND ?
    ORDER BY r.timestamp, r.id LIMIT 4`);
  const readBody = prepareAuditConversationBodyReader(db);
  const candidates = AuditConversationBodySchema.array();
  for (const key of keys) {
    const bodies = candidates.parse(
      findCandidates.all(key, to, to, TITLE_BODY_LIMIT, TITLE_CHUNK_LIMIT),
    );
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
