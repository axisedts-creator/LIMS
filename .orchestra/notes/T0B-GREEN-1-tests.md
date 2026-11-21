# T0B-GREEN-1 tests (tester)
- Edited (pgTAP, db/tests): anatomic C11 schema+behaviour, payments C15 schema+behaviour, inventory C12 schema+behaviour, micro C10 schema+behaviour, quality C9 schema+behaviour, smartreport C14 behaviour. New: tests/db/T0B-GREEN-1.pgtap.test.mjs (wraps run-suites.sh).
- Run: `.orchestra/notes/T0B-GREEN-1-verify.cmd` (node --test tests/db/T0B-GREEN-1.pgtap.test.mjs, ~6 min, needs docker). Single suite: `bash db/tests/run-suites.sh db/tests/<dir>/T0B-13.Cn_<kind>.test.sql`.
- Result: 107 not ok before, 5 after; the 5 are REAL (db defects), left red and unedited: C14 behaviour 357/370/373, C15 behaviour 373, C11 behaviour 432. The node test passes only when no other `not ok` and no psql abort.
- Classification per assertion, per-suite before/after counts, what each changed assertion proves now: .orchestra/notes/T0B-GREEN-1.md. CRs: .orchestra/cr/T0B-GREEN-1.*.md and T0B-GREEN-1-device-actor.nonblocking.md.
- Not covered: the isolation probes (db/tests/isolation) and db/tests/views (C9-T20.v_pub_qc_summary), outside this task's directories.
