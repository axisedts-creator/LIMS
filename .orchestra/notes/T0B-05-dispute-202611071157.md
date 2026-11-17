# T0B-05 dispute (writer, 2026-11-07)
Test: db/tests/core/T0B-05_queue.test.sql:49 `SELECT is((SELECT max_attempts FROM graphile_worker.jobs ...), 5, ...)`.
Run: `bash db/tests/run-suites.sh --no-seeds db/tests/core/T0B-05_platform.test.sql db/tests/core/T0B-05_queue.test.sql`
(graphile-worker@0.18.0 installed per LD-31; "Schema updated"). Platform file: 0 `not ok`. Queue file: ok 1-4, then
`psql:db/tests/core/T0B-05_queue.test.sql:49: ERROR:  function is(smallint, integer, unknown) does not exist`.
Why the test is wrong: graphile_worker 0.18.0 `jobs.max_attempts` is smallint; pgTAP has no is(smallint, integer). The impl is not at
fault. Fix: compare `5::smallint` (or cast the column `::int`). Tests 6-23 never ran, so their status is unknown.
Side issue: seed 010 fails `new row violates row-level security policy for table "tenants"` (T0B-09 ESCALATE), so the full run aborts
before suites; `--no-seeds` / LIMS_SKIP_SEEDS=1 added to run-suites.sh for local runs only.
