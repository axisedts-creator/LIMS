# C15 plan tasks skipped (not in task JSON)

- PG-T21 — eSewa UAT verification: needs staging + UAT keys (REQ-SEC-136), manual recorded checks; deferred to M5.
- PG-T22 — Khalti sandbox verification incl. refund API: needs sandbox keys and staging; deferred to M5.
- PG-T23 — Production enablement checklist: no files; founder/security sign-offs (RB-9, F-08); blocked on CR-C15-008 (C1) and T21/T22.

Notes: the plan has no explicit B4 row. AC ids use `AC-PG-<story>.<n>` (story 11b kept as `11b`). PG-T01 "C0 cores" dependency is not a task id, so `depends` is empty. DB integration tests in PG-T04/T08/T09/T13 wait on C0 DDL (T0B-13); unit/sim tests do not. PG-T20 `depends` omits skipped T21–T23.
