# T0B-11 tests (tester, round 3, LD-51)
- `tests/db/T0B-11.billing-export.test.mjs` (node, no DB, 19 tests): D16 DDL rule + CLI contract + PGOPTIONS read_only/row_security=off. Unchanged.
- `db/tests/billing_isolatable/T0B-11_billing_isolatable.sh`: live AC-0B-6.4 (docker). Unchanged.
- NEW tracked live helpers: `db/tests/billing_isolatable/live/bin/psql`, `live/shim.mjs` (moved from gitignored coverage/t0b11live, behaviour kept), `db/tests/billing_isolatable/run-live.cmd` (PATH + NODE_OPTIONS shim, runs the .sh, exits with its code).
- Verify: `.orchestra\notes\T0B-11-verify.cmd` = node test, then `call db\tests\billing_isolatable\run-live.cmd`. Harness log must show `ok - AC-0B-6.4`.
- Round 4 fix: .sh build_db now creates schema `extensions` in the fresh restore DB before pgtap/01_database.sql (review item 1).
- NOT verified: live run not executed by me (LD-51: agent sessions blocked from docker/psql); seed-vs-DDL validity unproven until harness log.
