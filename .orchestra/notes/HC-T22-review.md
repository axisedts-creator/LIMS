APPROVE

HC-T22 review (diff b2b76d35..HEAD)
- Root pubspec.yaml: only the LD-129 block was added (hooks / user_defines / sqlite3 / source: sqlcipher, block style). Nothing else in the file changed.
- db/meta/decisions/T0-03-dependencies.md: one sentence records the pick (hook source: sqlcipher), and no version changed. The table has no sqlite3 row, so the sentence sits at the end of the file. That is fine.
- sqlcipher_flutter_libs is not added. No secrets, no PHI, no RLS/route/permission surface in this change. Both paths are covered by the CR-C17-016/LD-129 approval.
- Earlier db code (8f63559b): the key is deleted before close and the -wal/-shm/db files are removed. openRaw never falls back to plaintext and checks the key with a read of sqlite_master.
- Re-ran HC-T22-verify: 41/41 pass. The log shows SQLCipher hmac errors on wrong or deleted keys, which confirms the hook is active.
- Not verified: Android/iOS device builds, and the real flutter_secure_storage adapter.
