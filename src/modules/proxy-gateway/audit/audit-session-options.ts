import type Database from 'better-sqlite3';
import {
  AUDIT_SESSION_OPTIONS_LIMIT,
  AuditSessionOptionSchema,
  AuditSessionOptionsResultSchema,
  type AuditSessionOptionsWorkerInput,
} from './audit-session-options.schema';
import { readAuditSessionTitles } from './audit-session-titles';

export function readAuditSessionOptions(
  db: Database.Database,
  input: AuditSessionOptionsWorkerInput,
) {
  return db.transaction(() => {
    if (input.kind === 'selected') {
      const row = db
        .prepare(
          `
        SELECT session_id sessionId, MAX(timestamp) lastSeen FROM request_logs
        WHERE session_id=? AND traffic_class='model' AND timestamp<=?
        GROUP BY session_id`,
        )
        .get(input.sessionId, input.asOf);
      if (!row) {
        return { rows: [] };
      }
      const option = AuditSessionOptionSchema.parse(row);
      const title = readAuditSessionTitles(db, [option.sessionId], input.asOf).get(
        option.sessionId,
      );
      return AuditSessionOptionsResultSchema.parse({ rows: [{ ...option, title }] });
    }

    const through = Math.min(
      input.asOf,
      input.cursor?.through ?? input.to ?? input.asOf,
      input.to ?? input.asOf,
    );
    const options = AuditSessionOptionSchema.array().parse(
      db
        .prepare(
          `
      SELECT session_id sessionId, MAX(timestamp) lastSeen FROM request_logs
      WHERE traffic_class='model' AND timestamp BETWEEN @from AND @through
        AND length(CAST(session_id AS BLOB)) BETWEEN 1 AND 512
      GROUP BY session_id
      HAVING @lastSeen IS NULL OR lastSeen<@lastSeen OR (lastSeen=@lastSeen AND session_id>@sessionId)
      ORDER BY lastSeen DESC, session_id ASC LIMIT @limit`,
        )
        .all({
          from: input.from ?? 0,
          through,
          lastSeen: input.cursor?.lastSeen ?? null,
          sessionId: input.cursor?.sessionId ?? null,
          limit: AUDIT_SESSION_OPTIONS_LIMIT + 1,
        }),
    );
    const page = options.slice(0, AUDIT_SESSION_OPTIONS_LIMIT);
    const titles = readAuditSessionTitles(
      db,
      page.map(({ sessionId }) => sessionId),
      through,
    );
    const needle = input.text?.toLowerCase();
    const rows = page.flatMap((option) => {
      const title = titles.get(option.sessionId);
      if (
        needle &&
        !title?.toLowerCase().includes(needle) &&
        !option.sessionId.toLowerCase().includes(needle)
      ) {
        return [];
      }
      return [{ ...option, title }];
    });
    const last = page.at(-1);
    const next = options.length > page.length && last ? { ...last, through } : undefined;
    return AuditSessionOptionsResultSchema.parse({ rows, next });
  })();
}
