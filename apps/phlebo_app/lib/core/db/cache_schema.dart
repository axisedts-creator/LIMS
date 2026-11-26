// PHLEBO-UI-FULL-1: cache.db DDL, verbatim from 05-SCHEMA B.1 (read-only snapshot, replaced by SyncEngine on every
// changed pull). cache.db is disposable: a schema mismatch is handled by deleting it and pulling again.
import 'cache_db.dart';

abstract final class CacheSchema {
  static const _ddl = [
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS routes (route_id TEXT PRIMARY KEY NOT NULL, centre_id TEXT NOT NULL, version INTEGER NOT NULL)',
    '''CREATE TABLE IF NOT EXISTS visits (
  visit_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL, route_id TEXT NOT NULL REFERENCES routes(route_id),
  route_sequence INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('assigned','in_progress','completed','failed','cancelled')),
  kind TEXT NOT NULL, window_start TEXT, window_end TEXT, order_id TEXT,
  patient_full_name TEXT, patient_phone_e164 TEXT, patient_birth_on TEXT,
  patient_unavailable INTEGER NOT NULL DEFAULT 0,
  address_text TEXT, landmark TEXT, latitude TEXT, longitude TEXT, note_for_phlebotomist TEXT,
  balance_due_paisa INTEGER, balance_as_of TEXT, balance_unavailable INTEGER NOT NULL DEFAULT 0,
  specimens_stale INTEGER NOT NULL DEFAULT 0
)''',
    '''CREATE TABLE IF NOT EXISTS visit_specimens (
  specimen_id TEXT PRIMARY KEY NOT NULL, visit_id TEXT NOT NULL REFERENCES visits(visit_id),
  barcode TEXT NOT NULL CHECK (length(barcode) BETWEEN 1 AND 20),
  specimen_type_code TEXT NOT NULL, container_code TEXT, status TEXT NOT NULL
)''',
    'CREATE INDEX IF NOT EXISTS visit_specimens_barcode ON visit_specimens(barcode)',
    '''CREATE TABLE IF NOT EXISTS reasons (set_code TEXT NOT NULL, code TEXT NOT NULL, display TEXT NOT NULL, requires_text INTEGER NOT NULL,
  PRIMARY KEY (set_code, code))''',
    'CREATE TABLE IF NOT EXISTS payment_methods (code TEXT PRIMARY KEY NOT NULL, display TEXT NOT NULL, requires_reference INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS handover_centres (centre_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL)',
  ];

  static Future<void> ensure(CacheDb db) async {
    for (final s in _ddl) {
      await db.execute(s);
    }
  }
}
