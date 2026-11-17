# HC-T25 impl (writer)
- Files: apps/phlebo_app/lib/core/sync/sync_engine.dart (new; only file touched). Exposes SyncEngine, SyncSession, SyncStatus, SyncCycleResult per the fixture header.
- Push: outstandingBatch() ?? formBatch(); stored bodyJson decoded -> ApiClient.postJson(idempotencyKey: batchId) (ApiClient re-encodes; round trip is byte-identical, tests prove it). 422 key_reused -> reformAfterKeyReused, max 2 per cycle, then blocked.
- Pull/replace: one cache.db tx (BEGIN IMMEDIATE, DELETE every table, insert, COMMIT/ROLLBACK); any failure -> retryLater, old cache + cursor stay, no ack. Unchanged pull: balances + server_time_at_pull only.
- [CONV] retry ladder 5s/15s/45s/2min/5min in memory, reset on a fully ok cycle; 5xx/429/409 in_progress/transport = retryLater; TLS = tlsFailure; 401 after refresh or session_expired = sessionExpired; other 4xx (426, 409 device_not_registered) = blocked.
- [CONV] max_device_seq_acked = max device_seq in a terminal state (0 if none); device_state keys last_successful_push_at / _pull_at / last_ack_cursor.
- Results: sync_engine_push/pull/ci_guards 3 files pass. Full `flutter test __tests__`: 195 pass, 1 fail = db_ci_guards_test "no log( in core/db" — pre-existing, not mine: comment "mutation log (05-SCHEMA B.2)" in lib/core/db/outbox_db.dart:1 matches `\blog\s*\(` (HC-T22 file, not owned by this task).
- Open: device_command 'wipe' (US-13-5) is ignored here; Prism not used (tester's FakeHcServer); schedulers/timers belong to the caller.
