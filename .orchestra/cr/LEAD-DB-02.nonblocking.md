```
Title: CR-C0-<nnn>: SP-2 step (b) - graphile_worker install is missing from the dev stack runner (and so from the CI jobs that use it)
From: lead (found 2026-11-13 while pushing main to a Supabase test project)
To owner: C0-0A (tools/devstack/up.ts step 4 + compose `migrate`) and C0-0B (AC-0B-6.1; 05-SCHEMA sec.2 `graphile_worker` row)
Type: tooling / bug
Blocking? yes for `pnpm dev:up` and for the CI jobs that call it (.github/workflows/pr.yml job `migrations`, nightly.yml), by code reading. Not run: dev:up and CI were not run for this note.
Problem (observed 2026-11-13; Supabase test project, Atlas 1.3.1 community): after the first 12 migrations, migration 20261105001200_app__create_queue_wrapper.sql failed at
    CREATE FUNCTION app.queue_depth() ... FROM graphile_worker.jobs j ...
    pq: relation "graphile_worker.jobs" does not exist at position 7:8 (42P01)
  The file's own header (lines 4-5) says: "graphile_worker is installed by the runner between step 1 and this file (SP-2 step b). LD-31 / CR T0B-05 item 3: no
  check_function_bodies fallback; a deploy without step (b) fails here at migrate time." 05-SCHEMA sec.2, `graphile_worker` row: "installed by the migration runner inside
  the D-201 grant/revoke window, per SP-2".
  Where step (b) exists today: db/tests/run-suites.sh (lines 33-43: (a) files below 20261105001200, (b) `PGOPTIONS='-c role=lims_queue' graphile-worker --schema-only` as
  lims_migrator on a direct connection, (c) 001200 onward) and db/tests/billing_isolatable/T0B-11_billing_isolatable.sh (lines 44-45). Both apply files with psql, not Atlas.
  Where it is not: tools/devstack/up.ts step 4 (line 75) runs compose service `migrate` (tools/devstack/compose.yaml lines 181-187), which is one `atlas migrate apply` over the
  whole db/migrations directory. `grep -i graphile` over tools/ and .github/ returns no match. pr.yml (job `migrations`, step "dev stack, fresh apply": `pnpm dev:up --ci`) and
  nightly.yml (`pnpm dev:up --ci`) reach migrations through that runner. Conclusion from reading the code, not from running it: a fresh dev:up applies 001200 without step (b).
  Also observed, separate, not investigated: pr.yml and nightly.yml call `pnpm db:migrate` and `pnpm db:seed`, but the root package.json has no `db*` script (workspace packages not checked).
Proposed change (exact):
  1. The runner (tools/devstack/up.ts + compose `migrate`, and any other runner that calls Atlas) applies in three phases:
       a. atlas migrate apply --to-version 20261105001100   (001100 grants lims_queue CREATE on the database and on schema app)
       b. graphile-worker@0.18.0 --schema-only as lims_migrator with session role lims_queue (PGOPTIONS='-c role=lims_queue', direct connection)
       c. atlas migrate apply                              (001200 builds the wrapper and revokes the CREATE grants)
     Skip (a) and (b) when schema graphile_worker already exists. Keep the split version in one constant, with a check that the next migration is the one whose header names SP-2 step (b).
  2. Hosted/pooled targets: the Supabase session pooler ignored PGOPTIONS in the lead test (probe returned current_user = lims_migrator). There, run `runMigrations` from the
     graphile-worker library with a pg Pool whose `connect` handler issues `SET ROLE lims_queue`. That worked on the test project (graphile_worker owner = lims_queue). It is a
     fallback for pooled hosts, not a replacement for the direct-connection form.
Backward compatible? yes.
Tenant/security impact: none beyond SP-2 / D-201. lims_queue held CREATE on the database and on schema app only between 001100 and 001200; on the test project
  `has_database_privilege(lims_queue, CREATE)` and `has_schema_privilege(lims_queue, app, CREATE)` were false after 001200.
IRD/regulatory impact: n/a
Alternatives considered: a check_function_bodies = off fallback in 001200 (rejected by LD-31); installing the queue schema inside a migration file (SP-2: graphile-worker owns its
  versioned schema); installing at worker start (services/worker runs no DDL).
Tests that will prove it: `pnpm dev:up --ci` from an empty volume reaches the end through Atlas; AC-0B-6.1 (01-PRD line 157) passes through the three phases; a lint/test that
  fails if tools/ or .github/ run one `atlas migrate apply` over the full directory without a graphile_worker step before 20261105001200; db/tests/run-suites.sh unchanged.
Evidence: lead run 2026-11-13 (see LEAD-DB-01). A working sequence exists in C:\LIMS-state\push-cloud.ps1 (outside the repo; its assembled form has not been run).
```
