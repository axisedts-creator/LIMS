# HC-T22 impl (writer)
- Added apps/phlebo_app/lib/core/db/{keys,encrypted_db,cache_db,outbox_db,wipe}.dart; pubspec: drift 2.35.3, sqlite3 3.8.0, flutter_secure_storage 11.2.0 (exact) + app-level `hooks` (inert in a workspace).
- [CONV] SQLCipher chosen over sqlite3mc. [CONV] raw package:sqlite3 handles (execute/select) per the test API; drift is pinned (guard) but not yet used — schema/DAO tasks add it.
- Wipe: key deleted first (failure aborts before any file is touched), then close (WAL checkpoint) and delete -wal, -shm, db.
- LD-129 (CR-C17-016 approved): appended hooks/user_defines/sqlite3/source: sqlcipher block to ROOT pubspec.yaml; pick recorded as one sentence at end of db/meta/decisions/T0-03-dependencies.md (no sqlite3 row exists there; no version changed). Re-ran HC-T22 verify: 41/41 pass.
- Not run: android/ios device builds (SQLCipher hook per platform), real flutter_secure_storage adapter (FlutterSecureKeyStore untested on host).
