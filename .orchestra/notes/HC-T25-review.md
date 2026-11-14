APPROVE
HC-T25 review (reviewer), diff 271c7717..060350ff.
- Checks run: `flutter test` push/pull/ci_guards = 49/49 pass; `flutter analyze` on the 5 changed Dart files = no issues.
- done_when: same batch_id + key + byte-identical body on retry (lost answer, drop, 503, 409 in_progress, 401 refresh, restart), proven by a byte comparison against batches.body_json; 422 common.idempotency_key_reused -> reformAfterKeyReused gives a new batch_id (cap 2 per cycle, then blocked); snapshot replace = one BEGIN IMMEDIATE/DELETE every table/insert/COMMIT tx, ROLLBACK on error with old cache and cursor kept and no ack.
- Names match the spec: TRD §6.2-6.4 paths and A4 body fields, 05-SCHEMA B.1 tables, columns and meta keys, B.2 device_state keys, errors via LimsErrorCodes. Backoff 5s/15s/45s/2min/5min is from TRD §7.2. Nothing invented.
- Security: no logging, no secrets, every call goes through the pinned ApiClient, a TLS failure is reported apart from offline, and the session is checked before every call (S-4). Server RLS, permissions and rate tier don't apply (client-only task).
- Paths: only apps/phlebo_app (lib/core/sync and __tests__) plus the role notes files.
- Non-blocking, outside this task's ACs: device_command 'wipe' (US-13-5) is ignored; meta.tenant_timezone is never written because SnapshotDto has no field for it; Prism was replaced by FakeHcServer (no generated OpenAPI in the repo). The pre-existing db_ci_guards failure in core/db/outbox_db.dart:1 comes from HC-T22.
