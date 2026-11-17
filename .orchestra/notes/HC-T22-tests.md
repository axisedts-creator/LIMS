# HC-T22 tests (tester)
- apps/phlebo_app/__tests__/db_keys_test.dart — DbKeys: 64-hex Random.secure keys, `phlebo.cache_db_key`/`phlebo.outbox_db_key`, stable, independent, new key after delete.
- .../db_wipe_test.dart — DbWipe: key deleted BEFORE files (observed at key-delete time), db+WAL+SHM removed, cache-then-outbox order, outbox untouched by cache purge, idempotent, crash leftovers, key-delete failure surfaces, restored backup unreadable.
- .../db_forensics_test.dart — REAL CacheDb/OutboxDb (host, needs SQLCipher/sqlite3mc hook): header != "SQLite format 3" (open+closed), no plaintext PHI/barcode in db/-wal/-shm, key never on disk, wrong key / deleted key -> open throws, WAL + foreign_keys pragmas.
- .../db_ci_guards_test.dart — core/db files exist, Random.secure only, flutter_secure_storage only (no prefs/print), `PRAGMA key`, pubspec pins drift 2.35.3 + sqlite3 3.x.y + flutter_secure_storage + hook `source: sqlcipher|sqlite3mc` (app or root pubspec).
- support/db_fixture.dart — FakeKeyStore, raw-byte helpers.
Run: .orchestra\notes\HC-T22-verify.cmd (NOT run by me yet; expected now: compile fail, lib/core/db missing). ASSUMED API in each test header (SecureKeyStore, DbKeys, CacheDb/OutboxDb.open/execute/select/close, DbWipe). Impl needs new pubspec deps (drift, sqlite3, flutter_secure_storage) and likely a root-pubspec hook entry.
