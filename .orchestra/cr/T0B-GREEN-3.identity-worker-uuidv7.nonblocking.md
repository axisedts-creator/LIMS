Title: CR-C0-T0B-GREEN-3-002: lims_worker has no EXECUTE on app.uuidv7() although worker SQL calls it
From chunk: C0 (lane C0-0B, T0B-GREEN-3)   To owner: C0-0B (grant migration) — lead decision; no grant or migration was edited here
Type: schema (grant)
Blocking? no for the database tests (2 assertions stay red as REAL); the two quality worker consumers below would fail with 42501 at runtime on a real database.

Problem: services/worker/src/jobs/quality/consumers/lab.result.verified.v1.ts:13 (`VALUES (app.uuidv7(), ...)`) and instruments.result.received.v1.ts:11 (`SELECT app.uuidv7(), ...`) run as lims_worker. app.uuidv7() (20261105000100_app__create_context_helpers.sql:96)
 has proacl {lims_owner=X/lims_owner} only: no PUBLIC (default privileges), no lims_worker. The T0B-ASYNC-1 catalog test lists it as a function the worker calls (kept equal to services/worker/src/core/__tests__/worker-sql-functions.test.ts).
Evidence (pinned image, 2026-11-18, `bash db/tests/run-suites.sh db/tests/identity/T0B-ASYNC-1_worker_grants.test.sql`): not ok 58 "lims_worker may execute every overload of app.uuidv7", not ok 59 summary (have: app.uuidv7(), want: empty).
Proposed change (exact): new migration `GRANT EXECUTE ON FUNCTION app.uuidv7() TO lims_worker;` (the function is a pure generator, no data access), or, if the lead prefers, move the id generation of those two consumers to the application (@lims/shared-ts uuidv7) and drop `uuidv7` from the worker list.
Backward compatible? yes.
Tenant/security impact: none beyond one more EXECUTE on a side-effect-free function (it reads clock_timestamp() and gen_random_uuid()); no RLS change.
Alternatives considered: weakening assertion 58/59 (rejected: they are the contract that no worker-called function is closed).
Tests that will prove it: T0B-ASYNC-1_worker_grants.test.sql 58 and 59 go green unchanged.
