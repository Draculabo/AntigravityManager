import type Database from 'better-sqlite3';

const SCHEMA_VERSION = 3;
const OWNED_TABLES = new Set([
  'thinking_meta',
  'thinking_sessions',
  'thinking_records',
  'thinking_tool_links',
]);

/** Replaces scalar-only history, without migrating it or deleting database files. */
export function initializeThoughtStoreSchema(database: Database.Database): void {
  const version = Number(database.pragma('user_version', { simple: true }));
  if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) {
    throw new Error(`Unsupported Thought Store schema version: ${version}`);
  }
  // Never reset a database containing another feature's data, even if a caller
  // accidentally supplies its path. SQLite owns WAL/SHM and transaction rollback.
  const objects = database
    .prepare(
      "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','trigger')",
    )
    .all();
  if (
    objects.some(
      (entry) =>
        !entry ||
        typeof entry !== 'object' ||
        Reflect.get(entry, 'type') !== 'table' ||
        !OWNED_TABLES.has(String(Reflect.get(entry, 'name'))),
    )
  ) {
    throw new Error('Thought Store database contains unowned objects; replacement refused');
  }
  database
    .transaction(() => {
      if (version < 2) {
        database.exec(
          'DROP TABLE IF EXISTS thinking_tool_links; DROP TABLE IF EXISTS thinking_records; DROP TABLE IF EXISTS thinking_sessions; DROP TABLE IF EXISTS thinking_meta;',
        );
      }
      if (version === 2) {
        database.exec(
          'ALTER TABLE thinking_records ADD COLUMN operation_id TEXT;' +
            'ALTER TABLE thinking_records ADD COLUMN causal_anchor TEXT;' +
            'ALTER TABLE thinking_records ADD COLUMN completed_at INTEGER;' +
            "ALTER TABLE thinking_records ADD COLUMN capture_state TEXT NOT NULL DEFAULT 'legacy';",
        );
      }
      database.exec(
        'CREATE TABLE IF NOT EXISTS thinking_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
          'CREATE TABLE IF NOT EXISTS thinking_sessions (session_key TEXT PRIMARY KEY, last_accessed INTEGER NOT NULL, ended_at INTEGER);' +
          'CREATE TABLE IF NOT EXISTS thinking_records (' +
          'id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL REFERENCES thinking_sessions(session_key) ON DELETE CASCADE,' +
          "fingerprint TEXT NOT NULL, operation_id TEXT, causal_anchor TEXT, completed_at INTEGER, capture_state TEXT NOT NULL DEFAULT 'legacy', thought BLOB, thought_bytes INTEGER NOT NULL DEFAULT 0, signature TEXT," +
          'part_signatures TEXT NOT NULL, signature_bytes INTEGER NOT NULL,' +
          'tool_ids TEXT NOT NULL, tool_names TEXT NOT NULL, primary_tool_id TEXT, visible TEXT NOT NULL,' +
          'model TEXT, source_family TEXT, oversized INTEGER NOT NULL DEFAULT 0, oversized_bytes INTEGER,' +
          'oversized_sha256 TEXT, created_at INTEGER NOT NULL, last_accessed INTEGER NOT NULL);' +
          'CREATE INDEX IF NOT EXISTS idx_thought_sequence ON thinking_records(session_key,id ASC);' +
          'CREATE INDEX IF NOT EXISTS idx_thought_latest ON thinking_records(session_key,id DESC);' +
          'CREATE INDEX IF NOT EXISTS idx_thought_tool ON thinking_records(session_key,primary_tool_id) WHERE primary_tool_id IS NOT NULL;' +
          'CREATE INDEX IF NOT EXISTS idx_thought_fingerprint ON thinking_records(session_key,fingerprint);' +
          'CREATE INDEX IF NOT EXISTS idx_thought_operation ON thinking_records(session_key,operation_id);' +
          'CREATE INDEX IF NOT EXISTS idx_thought_causal ON thinking_records(session_key,causal_anchor,model);' +
          'CREATE TABLE IF NOT EXISTS thinking_tool_links(record_id INTEGER NOT NULL REFERENCES thinking_records(id) ON DELETE CASCADE,position INTEGER NOT NULL,completed_at INTEGER NOT NULL,PRIMARY KEY(record_id,position));' +
          'CREATE INDEX IF NOT EXISTS idx_thought_tool_expiry ON thinking_tool_links(completed_at,record_id,position);' +
          'CREATE INDEX IF NOT EXISTS idx_thought_accessed ON thinking_sessions(last_accessed ASC);',
      );
      database
        .prepare(
          "INSERT INTO thinking_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(String(SCHEMA_VERSION));
      // Readback belongs to the same transaction; failure rolls back the reset.
      database
        .prepare(
          'SELECT part_signatures, signature_bytes, operation_id, causal_anchor, completed_at, capture_state FROM thinking_records LIMIT 0',
        )
        .all();
      database.pragma(`user_version = ${SCHEMA_VERSION}`);
    })
    .immediate();
}
