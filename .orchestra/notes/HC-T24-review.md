APPROVE

Reviewed `git diff c4795f8d..HEAD` (HC-T24) against 05-SCHEMA B.2, TRD §6.3, §7.2, §7.5, S-4.

- DDL is verbatim from B.2 (tables, CHECKs, FKs, indexes). `next_device_seq` starts at 1 and is never reset.
- Inv 1: the only UPDATEs touch state/outcome_code/batch_id/attempts/last_attempt_at/terminal_at. Enforced by a CI guard test.
- Inv 2: the row insert and the seq bump happen in one BEGIN IMMEDIATE transaction under a FIFO lock. enqueue completes only after COMMIT.
- Inv 3: the PushRequest shape matches §6.3 (device_id, batch_id, sent_at_device, anchors, now, mutations/captured). Limits: ≤100 mutations, ≤512 KB, ≤20 anchors. The frozen body is re-read byte for byte. A 422 `common.idempotency_key_reused` re-forms the batch; the batches row is deleted once its rows are terminal.
- Inv 4: purge runs at 24 h [CONV] and removes unreferenced anchors older than the newest one. Inv 5: `canLogout` is the local half of the logout check.
- Channel names, the UNVERIFIED spike notes (elapsedRealtime, BOOT_COUNT) and the iOS same-process DECISION are recorded in `HC-T24-spike.md`.
- Security: no logging or print. Payloads are checked against a PHI key denylist, and error messages carry only the key name. No secrets.
- Paths: everything is under `apps/phlebo_app` (owned by C17). MainActivity.kt is outside the brief's file glob but is needed for the channel handler.
- The reviewer ran the 4 HC-T24 test files: 56 passed ("All tests passed!").

Non-blocking: the kill-app test uses a second in-process connection, not a real process kill. `visit_label` content is not checked for PHI by this code; the caller supplies it.
