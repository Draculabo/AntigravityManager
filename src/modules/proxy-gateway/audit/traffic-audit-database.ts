import fs from 'node:fs';
import Database from 'better-sqlite3';

const SCHEMA_VERSION = 4;

export function configureTrafficAuditDatabase(database: Database.Database): void {
  database.pragma('auto_vacuum = INCREMENTAL');
  if (database.pragma('auto_vacuum', { simple: true }) !== 2) {
    database.exec('VACUUM');
  }
  if (database.pragma('auto_vacuum', { simple: true }) !== 2) {
    throw new Error('Traffic audit database could not enable incremental vacuum');
  }
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  database.pragma('temp_store = MEMORY');
  database.pragma('cache_size = -16000');
}

export function openTrafficAuditDatabase(databasePath: string): Database.Database {
  let database = new Database(databasePath);
  const schemaVersion = Number(database.pragma('user_version', { simple: true }));
  const hasRequestLogs = Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_logs'")
      .get(),
  );
  if (schemaVersion > SCHEMA_VERSION) {
    database.close();
    throw new Error(`Unsupported traffic audit schema version: ${schemaVersion}`);
  }
  if (hasRequestLogs && schemaVersion < SCHEMA_VERSION) {
    database.close();
    const backupPath = `${databasePath}.schema-v${schemaVersion}-backup-${Date.now()}`;
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${databasePath}${suffix}`;
      if (fs.existsSync(source)) {
        fs.renameSync(source, `${backupPath}${suffix}`);
      }
    }
    database = new Database(databasePath);
  }
  return database;
}

export function initializeTrafficAuditSchema(database: Database.Database): void {
  const schemaVersion = Number(database.pragma('user_version', { simple: true }));
  if (!Number.isInteger(schemaVersion) || schemaVersion > SCHEMA_VERSION) {
    throw new Error(`Unsupported traffic audit schema version: ${schemaVersion}`);
  }
  const hasRequestLogs = Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_logs'")
      .get(),
  );
  const hasPayloads = Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_payloads'")
      .get(),
  );
  if (schemaVersion === SCHEMA_VERSION && hasRequestLogs && !hasPayloads) {
    throw new Error(
      'Unsupported prototype traffic audit schema; preserve the prototype database and create a fresh database',
    );
  }

  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS request_logs (' +
      'id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, completed_at INTEGER, method TEXT NOT NULL,' +
      'url TEXT NOT NULL, protocol TEXT NOT NULL,' +
      "traffic_class TEXT NOT NULL CHECK(traffic_class IN ('model','auxiliary','ipc','system'))," +
      'operation TEXT, model TEXT, mapped_model TEXT, attributed_account_id TEXT,' +
      'physical_model TEXT, physical_model_family TEXT, has_text_output INTEGER, has_image_output INTEGER,' +
      'session_id TEXT, client_ip TEXT, username TEXT, request_headers TEXT NOT NULL, request_query TEXT,' +
      'status INTEGER, duration_ms INTEGER, outcome TEXT NOT NULL, error TEXT, response_headers TEXT,' +
      'response_partial INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER, output_tokens INTEGER,' +
      'cached_tokens INTEGER, reasoning_tokens INTEGER' +
      ');' +
      'CREATE TABLE IF NOT EXISTS upstream_attempts (' +
      'id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES request_logs(id) ON DELETE CASCADE,' +
      'attempt_index INTEGER NOT NULL, timestamp INTEGER NOT NULL, completed_at INTEGER, operation TEXT NOT NULL,' +
      'endpoint TEXT NOT NULL, account_id TEXT, account_id_hash TEXT, model TEXT, request_headers TEXT NOT NULL,' +
      'status INTEGER, duration_ms INTEGER, outcome TEXT NOT NULL, error TEXT, response_headers TEXT,' +
      'response_partial INTEGER NOT NULL DEFAULT 0' +
      ');' +
      'CREATE TABLE IF NOT EXISTS audit_payloads (' +
      'id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES request_logs(id) ON DELETE CASCADE,' +
      'kind TEXT NOT NULL, representation TEXT NOT NULL, state TEXT NOT NULL,' +
      'logical_bytes INTEGER NOT NULL DEFAULT 0, stored_bytes INTEGER NOT NULL DEFAULT 0, raw_bytes INTEGER,' +
      "sha256 TEXT, sha256_scope TEXT NOT NULL DEFAULT 'unavailable', chunk_count INTEGER NOT NULL DEFAULT 0," +
      'oversized INTEGER NOT NULL DEFAULT 0, partial INTEGER NOT NULL DEFAULT 0, terminal_status TEXT,' +
      'parse_error_offset INTEGER, error_summary TEXT, dropped_reason TEXT, created_at INTEGER NOT NULL,' +
      'completed_at INTEGER' +
      ');' +
      'CREATE TABLE IF NOT EXISTS audit_payload_chunks (' +
      'payload_id TEXT NOT NULL REFERENCES audit_payloads(id) ON DELETE CASCADE,' +
      'seq INTEGER NOT NULL, payload BLOB NOT NULL, byte_length INTEGER NOT NULL,' +
      "encoding TEXT NOT NULL DEFAULT 'raw', PRIMARY KEY(payload_id,seq)" +
      ') WITHOUT ROWID;' +
      'CREATE TABLE IF NOT EXISTS request_body_refs (' +
      'request_id TEXT NOT NULL REFERENCES request_logs(id) ON DELETE CASCADE,' +
      "direction TEXT NOT NULL CHECK(direction IN ('request','response'))," +
      'payload_id TEXT NOT NULL REFERENCES audit_payloads(id) ON DELETE CASCADE,' +
      'PRIMARY KEY(request_id,direction)' +
      ') WITHOUT ROWID;' +
      'CREATE TABLE IF NOT EXISTS attempt_body_refs (' +
      'attempt_id TEXT NOT NULL REFERENCES upstream_attempts(id) ON DELETE CASCADE,' +
      "direction TEXT NOT NULL CHECK(direction IN ('request','response'))," +
      'payload_id TEXT NOT NULL REFERENCES audit_payloads(id) ON DELETE CASCADE,' +
      'PRIMARY KEY(attempt_id,direction)' +
      ') WITHOUT ROWID;' +
      'CREATE TABLE IF NOT EXISTS audit_drop_stats (traffic_class TEXT NOT NULL,reason TEXT NOT NULL,' +
      'count INTEGER NOT NULL,dropped_bytes INTEGER NOT NULL DEFAULT 0,last_seen INTEGER NOT NULL,' +
      'PRIMARY KEY(traffic_class,reason)) WITHOUT ROWID;' +
      'CREATE TABLE IF NOT EXISTS audit_admin_events (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL,' +
      'operation TEXT NOT NULL, outcome TEXT NOT NULL, affected_count INTEGER, error TEXT);' +
      'CREATE INDEX IF NOT EXISTS idx_request_timestamp ON request_logs(timestamp DESC);' +
      'CREATE INDEX IF NOT EXISTS idx_request_protocol_timestamp ON request_logs(protocol,timestamp DESC);' +
      'CREATE INDEX IF NOT EXISTS idx_request_class_timestamp ON request_logs(traffic_class,timestamp DESC);' +
      'CREATE INDEX IF NOT EXISTS idx_request_model_timestamp ON request_logs(model,timestamp DESC);' +
      'CREATE INDEX IF NOT EXISTS idx_request_status_timestamp ON request_logs(status,timestamp DESC);' +
      'CREATE INDEX IF NOT EXISTS idx_request_account_timestamp ON request_logs(attributed_account_id,timestamp DESC);' +
      'CREATE INDEX IF NOT EXISTS idx_request_family_timestamp ON request_logs(physical_model_family,timestamp DESC);' +
      'CREATE INDEX IF NOT EXISTS idx_request_session_timestamp ON request_logs(session_id,timestamp DESC);' +
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_parent_order ON upstream_attempts(parent_id,attempt_index);' +
      'CREATE INDEX IF NOT EXISTS idx_payload_request_created ON audit_payloads(request_id,created_at);' +
      'CREATE INDEX IF NOT EXISTS idx_payload_retention ON audit_payloads(state,created_at);' +
      "INSERT INTO schema_meta(key,value) VALUES('schema_version','4') " +
      "ON CONFLICT(key) DO UPDATE SET value='4';" +
      "INSERT INTO schema_meta(key,value) VALUES('layout','classified-chunked-payload-v4') " +
      "ON CONFLICT(key) DO UPDATE SET value='classified-chunked-payload-v4';",
  );
  database.pragma(`user_version = ${SCHEMA_VERSION}`);
}
