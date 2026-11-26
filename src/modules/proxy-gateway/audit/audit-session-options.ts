import type Database from 'better-sqlite3';
import { and, asc, between, desc, eq, gt, lt, lte, max, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  AUDIT_SESSION_OPTIONS_LIMIT,
  AuditSessionOptionSchema,
  AuditSessionOptionsResultSchema,
  type AuditSessionOptionsWorkerInput,
} from './audit-session-options.schema';
import { readAuditSessionTitles } from './audit-session-titles';
import { requestLogs } from './traffic-audit.schema';

export function readAuditSessionOptions(
  db: Database.Database,
  input: AuditSessionOptionsWorkerInput,
) {
  return drizzle(db).transaction((tx) => {
    const lastSeen = max(requestLogs.timestamp);
    if (input.kind === 'selected') {
      const row = tx
        .select({ sessionId: requestLogs.sessionId, lastSeen })
        .from(requestLogs)
        .where(
          and(
            eq(requestLogs.sessionId, input.sessionId),
            eq(requestLogs.trafficClass, 'model'),
            lte(requestLogs.timestamp, input.asOf),
          ),
        )
        .groupBy(requestLogs.sessionId)
        .get();
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
    const { cursor } = input;
    const options = AuditSessionOptionSchema.array().parse(
      tx
        .select({ sessionId: requestLogs.sessionId, lastSeen })
        .from(requestLogs)
        .where(
          and(
            eq(requestLogs.trafficClass, 'model'),
            between(requestLogs.timestamp, input.from ?? 0, through),
            between(sql<number>`length(cast(${requestLogs.sessionId} as blob))`, 1, 512),
          ),
        )
        .groupBy(requestLogs.sessionId)
        .having(
          cursor
            ? or(
                lt(lastSeen, cursor.lastSeen),
                and(eq(lastSeen, cursor.lastSeen), gt(requestLogs.sessionId, cursor.sessionId)),
              )
            : undefined,
        )
        .orderBy(desc(lastSeen), asc(requestLogs.sessionId))
        .limit(AUDIT_SESSION_OPTIONS_LIMIT + 1)
        .all(),
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
  });
}
