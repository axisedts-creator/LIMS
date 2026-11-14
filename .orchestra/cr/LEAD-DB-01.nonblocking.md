```
Title: CR-C0-<nnn>: SP-5 follow-up - revision-table rights for lims_queue and lims_reporting_lookup (Atlas writes the revision row as the current role)
From: lead (found 2026-11-13 while pushing main to a Supabase test project)
To owner: C0-0A (tools/devstack/up.ts step 4 + compose `migrate`) and C0-0B (db/bootstrap; 05-SCHEMA sec.2 `migrations_meta` row; AC-0B-6.1)
Type: schema / bootstrap / runner
Blocking? yes for `pnpm dev:up` and for the CI jobs that call it (.github/workflows/pr.yml job `migrations`, nightly.yml), IF Atlas behaves on a local stack as it did in the
  test below. Not run: dev:up and CI were not run for this note (code read only).
Problem (observed 2026-11-13; Supabase test project, Postgres 17.11, Atlas 1.3.1 community, runner role lims_migrator):
  Apply from empty failed inside db/migrations/20261105000000_app__create_schemas.sql. Atlas printed "31 sql statements ok, 1 with errors"; the last
  statement shown was `SET LOCAL ROLE lims_queue;` (file line 27), then
    Error: sql/migrate: write revision: pq: permission denied for schema migrations_meta at column 13 (42501)
  The file's transaction rolled back; nothing was applied.
  Rights that exist today: SP-5.md "Condition 1" (db/meta/decisions/SP-5.md lines 51-57): USAGE on migrations_meta and default privileges SELECT, INSERT, UPDATE to
  lims_owner only. tools/devstack/up.ts lines 64-68 repeat exactly that as "dev glue until db/bootstrap carries it". db/bootstrap/ (00_roles.sql, 01_database.sql) has no
  migrations_meta at all. 05-SCHEMA sec.2 (line 108) lists migrations_meta with `USAGE` granted to: none.
  Migrations that switch role mid-file: 20261105000000 (line 27 lims_queue, line 29 lims_reporting_lookup), 20261105001200 (line 7 lims_queue),
  20261105001900 (line ~1163 lims_reporting_lookup).
  Inferred, not read from Atlas source: Atlas records progress as the role that is current at that moment. SP-5 assumed the row is written after
  `SET LOCAL ROLE lims_owner`; 20261105000000 ends on lims_owner (line 31) yet failed at its first lims_queue statement. With the grants below, all 22 migrations applied.
  Why lane tests did not see it: db/tests/run-suites.sh applies files with psql (`MIG --single-transaction -f`), not Atlas, so no revision rows are written.
Proposed change (exact), runner-scoped, no standing grant:
  1. The runner, as lims_migrator (owner of migrations_meta), around every `atlas migrate apply` (tools/devstack/up.ts step 4 and any other runner that calls Atlas):
       before:  GRANT USAGE ON SCHEMA migrations_meta TO lims_queue, lims_reporting_lookup;
                GRANT SELECT, INSERT, UPDATE ON migrations_meta.atlas_schema_revisions TO lims_queue, lims_reporting_lookup;
       after (always, also on failure):
                REVOKE SELECT, INSERT, UPDATE ON migrations_meta.atlas_schema_revisions FROM lims_queue, lims_reporting_lookup;
                REVOKE USAGE ON SCHEMA migrations_meta FROM lims_queue, lims_reporting_lookup;
     Not tested: a brand-new database where the revision table does not exist yet. In the lead test the table already existed (the first failed run created it), so the
     explicit table GRANT worked. For the empty case the owner should add `ALTER DEFAULT PRIVILEGES FOR ROLE lims_migrator IN SCHEMA migrations_meta GRANT SELECT, INSERT,
     UPDATE ON TABLES TO lims_queue, lims_reporting_lookup` before the first apply and revoke it afterwards, and prove it in the test below.
  2. 05-SCHEMA sec.2, migrations_meta row, `USAGE` granted to: currently `none`; change to "lims_owner (SP-5); lims_queue, lims_reporting_lookup only while a migration run is in
     progress (runner-scoped, revoked after)".
Backward compatible? yes (additive; nothing standing changes).
Tenant/security impact: why not a standing grant: lims_worker inherits lims_queue (05-SCHEMA line 54 `GRANT lims_queue TO lims_worker WITH INHERIT TRUE, SET FALSE`;
  services/worker/src/core/DECISIONS.md line 7), so a standing INSERT/UPDATE on the revision table would let a runtime login rewrite migration history. Runner-scoped grants
  leave lims_queue, lims_reporting_lookup and lims_app with no access to migrations_meta outside a run. No RLS change.
IRD/regulatory impact: n/a
Alternatives considered: standing grant to both roles (rejected, lims_worker reason above); moving the role switches out of the migration files (contradicts 05-SCHEMA sec.10
  "queue wrapper" and the D-201 window); making lims_migrator own the wrapper objects (changes the ownership model).
Tests that will prove it: db/tests/roles - after a runner apply, has_schema_privilege('lims_queue'|'lims_reporting_lookup','migrations_meta','USAGE') = false and
  has_table_privilege(..., 'migrations_meta.atlas_schema_revisions','INSERT') = false; `pnpm dev:up --ci` from an empty volume applies all migrations through Atlas
  (AC-0B-6.1, 01-PRD line 157). Do not use run-suites.sh alone as proof: it does not go through Atlas.
Evidence: lead run 2026-11-13: first apply failed as above; with the temporary grants all 22 migrations applied; after the revoke the check
  `has_table_privilege(lims_queue|lims_reporting_lookup, revision table, INSERT)` was false. Related: LEAD-DB-02 (graphile_worker install step).
```
