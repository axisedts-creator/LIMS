APPROVE

Re-review (round 3) of `git diff c82eac2..HEAD` (C6-T10) after c134e0c + dd2c3f9.
1. O4 `common.immutable_record` — fixed: fake db models `reporting.report_versions` (tenant + status IN + snapshot match); tests cover released/superseded reject (state, readiness, no writes/jobs), draft passes, other file / other tenant pass with TENANT_A in lookup, ready file skips lookup.
2. Concurrent confirm race — fixed: `repo.lockOrderItem` (`SELECT 1 FROM reporting.report_order_items WHERE tenant_id = $1 AND order_item_id = $2 FOR UPDATE`) is the first statement in `reassemble()`; static test asserts lock-before-count. Lock order (own input_files row, then item rows) is the same on every path, so no deadlock.
Names, tenant predicates, static SQL, no PHI in logs/labels, owned paths, no secrets: still OK.
Ran: api vitest 4 files 162/162 pass; worker vitest 2 files 40/40 pass.

Non-blocking (carry forward): race only statically asserted — needs db-harness check. O6 SQL and `inReleasedVersion` not run on a live DB. `test_names` [] until catalogue port. ClamAV / qpdf sandbox / RLS not exercised here (C6-T12, db harness). confirm/withdraw do not bump `reports.version`.
