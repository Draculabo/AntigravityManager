CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  completed_at INTEGER,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  protocol TEXT NOT NULL,
  traffic_class TEXT NOT NULL CHECK(traffic_class IN ('model','auxiliary','ipc','system')),
  operation TEXT,
  model TEXT,
  mapped_model TEXT,
  attributed_account_id TEXT,
  physical_model TEXT,
  physical_model_family TEXT,
  has_text_output INTEGER,
  has_image_output INTEGER,
  session_id TEXT,
  client_ip TEXT,
  username TEXT,
  request_headers TEXT NOT NULL,
  request_query TEXT,
  status INTEGER,
  duration_ms INTEGER,
  outcome TEXT NOT NULL,
  error TEXT,
  response_headers TEXT,
  response_partial INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  reasoning_tokens INTEGER
);

CREATE TABLE IF NOT EXISTS upstream_attempts (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL REFERENCES request_logs(id) ON DELETE CASCADE,
  attempt_index INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  completed_at INTEGER,
  operation TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  account_id TEXT,
  account_id_hash TEXT,
  model TEXT,
  request_headers TEXT NOT NULL,
  status INTEGER,
  duration_ms INTEGER,
  outcome TEXT NOT NULL,
  error TEXT,
  response_headers TEXT,
  response_partial INTEGER NOT NULL DEFAULT 0,
  account_generation_hash TEXT,
  account_subject_hash TEXT,
  account_grant_hash TEXT,
  usage_scope TEXT CHECK(usage_scope IN ('generation','non-generation')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  reasoning_tokens INTEGER,
  timing_json TEXT
);

CREATE TABLE IF NOT EXISTS audit_payloads (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES request_logs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  representation TEXT NOT NULL,
  state TEXT NOT NULL,
  logical_bytes INTEGER NOT NULL DEFAULT 0,
  stored_bytes INTEGER NOT NULL DEFAULT 0,
  raw_bytes INTEGER,
  sha256 TEXT,
  sha256_scope TEXT NOT NULL DEFAULT 'unavailable',
  chunk_count INTEGER NOT NULL DEFAULT 0,
  oversized INTEGER NOT NULL DEFAULT 0,
  partial INTEGER NOT NULL DEFAULT 0,
  terminal_status TEXT,
  parse_error_offset INTEGER,
  error_summary TEXT,
  dropped_reason TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_payload_chunks (
  payload_id TEXT NOT NULL REFERENCES audit_payloads(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  payload BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  encoding TEXT NOT NULL DEFAULT 'raw',
  PRIMARY KEY(payload_id,seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS request_body_refs (
  request_id TEXT NOT NULL REFERENCES request_logs(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('request','response')),
  payload_id TEXT NOT NULL REFERENCES audit_payloads(id) ON DELETE CASCADE,
  PRIMARY KEY(request_id,direction)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS attempt_body_refs (
  attempt_id TEXT NOT NULL REFERENCES upstream_attempts(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('request','response')),
  payload_id TEXT NOT NULL REFERENCES audit_payloads(id) ON DELETE CASCADE,
  PRIMARY KEY(attempt_id,direction)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS audit_drop_stats (
  traffic_class TEXT NOT NULL,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL,
  dropped_bytes INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY(traffic_class,reason)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS audit_admin_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  affected_count INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_request_timestamp ON request_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_protocol_timestamp ON request_logs(protocol,timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_class_timestamp ON request_logs(traffic_class,timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_model_timestamp ON request_logs(model,timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_status_timestamp ON request_logs(status,timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_account_timestamp ON request_logs(attributed_account_id,timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_family_timestamp ON request_logs(physical_model_family,timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_session_timestamp ON request_logs(session_id,timestamp DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_parent_order ON upstream_attempts(parent_id,attempt_index);
CREATE INDEX IF NOT EXISTS idx_attempt_usage_range ON upstream_attempts(account_id,model,timestamp);
CREATE INDEX IF NOT EXISTS idx_attempt_subject_usage_range ON upstream_attempts(account_subject_hash,model,timestamp);
CREATE INDEX IF NOT EXISTS idx_payload_request_created ON audit_payloads(request_id,created_at);
CREATE INDEX IF NOT EXISTS idx_payload_retention ON audit_payloads(state,created_at);
CREATE INDEX IF NOT EXISTS idx_payload_disk_eviction ON audit_payloads(created_at,id) WHERE stored_bytes>0;
DROP INDEX IF EXISTS idx_payload_stored_bytes;
