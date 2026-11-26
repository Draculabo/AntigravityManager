import type Database from 'better-sqlite3';
import type { Query } from 'drizzle-orm';

/** Stream an ORM-built SELECT without buffering the result set. Select column names must match Row. */
export function iterateSqliteQuery<Row>(
  database: Database.Database,
  query: { toSQL(): Query },
): IterableIterator<Row> {
  const { sql, params } = query.toSQL();
  return database.prepare<unknown[], Row>(sql).iterate(...params);
}
