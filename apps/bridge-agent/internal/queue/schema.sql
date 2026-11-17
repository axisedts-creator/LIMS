CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL, protocol TEXT NOT NULL,
  started_at_agent TEXT NOT NULL, last_frame_at_agent TEXT NOT NULL,
  expected_fn INTEGER, frames INTEGER NOT NULL DEFAULT 0, retransmits INTEGER NOT NULL DEFAULT 0, naks_sent INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS session_chunks (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, nonce BLOB NOT NULL, ct BLOB NOT NULL, PRIMARY KEY (session_id, seq));
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('data','incomplete','host_query','attachment')),
  protocol TEXT NOT NULL CHECK (protocol IN ('astm','hl7v2','file_drop')),
  nonce BLOB NOT NULL, ct BLOB NOT NULL,
  meta_nonce BLOB NOT NULL, meta_ct BLOB NOT NULL,
  raw_sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  captured_at_agent TEXT NOT NULL, clock_offset_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','uploading','uploaded','rejected','oversize')),
  attempts INTEGER NOT NULL DEFAULT 0, last_error_code TEXT, next_attempt_at TEXT,
  uploaded_at TEXT, server_message_id TEXT, rejected_config_version INTEGER);
CREATE INDEX IF NOT EXISTS items__state_next ON items(state, next_attempt_at);
CREATE TABLE IF NOT EXISTS file_drop_seen (instrument_id TEXT NOT NULL, path_sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  mtime TEXT NOT NULL, file_sha256 TEXT NOT NULL, item_id TEXT, first_seen_at TEXT NOT NULL,
  PRIMARY KEY (instrument_id, path_sha256, size_bytes, mtime));
CREATE TABLE IF NOT EXISTS outbound (id TEXT PRIMARY KEY, instrument_id TEXT NOT NULL, nonce BLOB NOT NULL, ct BLOB NOT NULL,
  created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK (state IN ('pending','sent','failed')));
