# HC-T24 impl (writer)
- New: lib/core/platform/{monotonic_clock,boot_id,platform_channel}.dart, lib/core/sync/clock_anchor.dart, lib/features/outbox/data/{outbox_schema,outbox_repository,outbox_lock,sha256,time_format}.dart; android MainActivity.kt (channel handler); .orchestra/notes/HC-T24-spike.md.
- [CONV] MonotonicClock.nowMs() is sync (tests fix it); the real channel is async, so PlatformMonotonicClock is a SampledMonotonicClock and every capture/anchor/batch calls freshMonotonicMs() (sample then read).
- [CONV] one FIFO lock per OutboxDb connection (Expando) serialises all multi-statement writes; BEGIN IMMEDIATE/COMMIT/ROLLBACK.
- [CONV] body_json built by string assembly, stored payload_json spliced raw (byte-stable); anchors in a batch = those its mutations reference (≤20); payload cap 8 KB (REQ-SEC-080); PHI-key denylist at any depth.
- [CONV] when a batch's rows are all answered, rows get batch_id=NULL before the batches row is deleted (FK in B.2 DDL has no ON DELETE).
- Tests: 4 HC-T24 files run with flutter test, 54 pass, 1 failed (spike-note guard) before HC-T24-spike.md existed; re-run needed to confirm. Not run: flutter analyze, full suite, real device.
- Open: spike items UNVERIFIED (no device); no 401/refresh or HTTP wiring (belongs to later sync task); MainActivity.kt edit is outside the three listed paths but required by outbox_ci_guards_test.
