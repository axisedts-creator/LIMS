// HC-T24: outbox.db DDL, verbatim from 05-SCHEMA B.2. Idempotent; never resets next_device_seq.
import '../../../core/db/outbox_db.dart';

class OutboxSchema {
  static const List<String> _ddl = [
    'CREATE TABLE IF NOT EXISTS device_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)',
    '''CREATE TABLE IF NOT EXISTS batches (
  batch_id TEXT PRIMARY KEY NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL
)''',
    '''CREATE TABLE IF NOT EXISTS clock_anchors (
  anchor_id TEXT PRIMARY KEY NOT NULL,
  server_time TEXT NOT NULL,
  device_wall_time TEXT NOT NULL,
  monotonic_ms INTEGER NOT NULL,
  boot_id TEXT NOT NULL,
  created_seq INTEGER NOT NULL
)''',
    '''CREATE TABLE IF NOT EXISTS mutation_log (
  client_mutation_id TEXT PRIMARY KEY NOT NULL,
  device_seq INTEGER NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('visit.arrived','visit.identity_checked','visit.consent_recorded','specimen.collected',
        'specimen.not_collected','payment.captured','visit.completed','visit.failed','handover.recorded')),
  visit_id TEXT,
  visit_label TEXT,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  captured_wall_time TEXT NOT NULL,
  anchor_id TEXT NOT NULL REFERENCES clock_anchors(anchor_id),
  elapsed_since_anchor_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','sending','applied','duplicate','held','rejected')) DEFAULT 'pending',
  outcome_code TEXT,
  batch_id TEXT REFERENCES batches(batch_id),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  terminal_at TEXT
)''',
    'CREATE INDEX IF NOT EXISTS mutation_log_state_seq ON mutation_log(state, device_seq)',
    'CREATE INDEX IF NOT EXISTS mutation_log_visit ON mutation_log(visit_id, device_seq)',
    "INSERT OR IGNORE INTO device_state (key, value) VALUES ('next_device_seq', '1')",
  ];

  static Future<void> ensure(OutboxDb db) async {
    for (final s in _ddl) {
      await db.execute(s);
    }
  }
}
