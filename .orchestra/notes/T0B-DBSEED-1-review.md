APPROVE

Reviewed (round 2, after LD-249): git diff 10e58dc99..HEAD (18 regenerated fixture files, tests/db/T0B-DBSEED-1.fixtures.test.mjs regex, review note) plus the generator state from 918395fb6 / 07780c4bc.
1. Previous item 1 fixed: db/tests/fixtures/probe-rows/micro.sql:81-83 micro.instrument_records rows now carry organism_code_raw = 'probe-n' with record_kind 'organism_id', so instrument_records__payload__ck holds. The generator (db/tools/gen-isolation-probes.ts:1153-1156) now reports "CHECK ... not satisfiable statically" and drops the candidate instead of emitting it; --report prints no such line.
2. Previous item 2 fixed: --report prints no "collides with a partial UNIQUE index" warning (gen-isolation-probes.ts:1001); the static test asserts none outside the exceptions CR.
3. The tester's test change widens the regex (matches both "not satisfied" and "not satisfiable"); it is not a weakening.
Ran: node --test tests/db/T0B-DBSEED-1.fixtures.test.mjs: 30/30 pass. gen-isolation-probes --check: ok (438 probe files, 18 fixture files current). db/seeds unchanged since 13a5e1cf5. No migration, policy or spec change in range. Probe assertions byte-identical to baseline (asserted by test).
Non-blocking, as before: catalog.analytes and inventory.stores extra parent rows 8 and 10 not built (optional demand rows only).
NOT RUN: SQL / pgTAP suites. The founder rerun (LIMS_SKIP_GEN=1 bash db/tests/run-suites.sh <probe files>) is still the real check.
