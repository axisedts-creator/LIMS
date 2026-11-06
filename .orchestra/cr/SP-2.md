```
Title: CR-C0-<nnn>: SP-2 partial — record lims_worker residual queue-owner privilege (CV §5.9) and split the D-201 install window
From chunk: C0 (SP-2)      To owner: C0-0A (program conventions CV §5.9) · C0-0B (05-SCHEMA §10) · 07-SECURITY §6 owner
Type: schema
Blocking? no for SP-2 · T0B-05 must use the 3-step window below; T0D-09 uses parsedCronItems
Problem: SP-2 (db/meta/decisions/SP-2.md) shows that Graphile Worker 0.18.0 needs owner rights: its _private_* tables have RLS
  enabled with 0 policies. lims_worker inherits lims_queue, so it can CREATE/ALTER/DROP in graphile_worker and ALTER/DROP
  app.enqueue_job / app.queue_depth. CV §5.9 still says "queue privileges per 04 D6 (UNVERIFIED …)". Also the 05-SCHEMA §10 queue
  wrapper puts the graphile_worker install inside one SET LOCAL ROLE transaction. The install runs on its own connection, so it
  cannot see an uncommitted GRANT.
Proposed change (exact):
  1. CV §5.9 lims_worker row, Purpose: replace "queue privileges per 04 D6 (UNVERIFIED — C0 tests a pre-installed schema without
     DDL rights first)" with "member of lims_queue (INHERIT): holds owner rights on graphile_worker objects and app.enqueue_job /
     app.queue_depth (SP-2 partial — required by Graphile Worker's RLS-without-policies tables); no CREATE on app, other schemas
     or the database; runs no DDL at start".
  2. 07-SECURITY §6 DB privilege note: append "SP-2 outcome: partial — residual = lims_worker owner rights on graphile_worker and
     the two app queue wrappers (services/worker/src/core/DECISIONS.md); worker does not migrate at start."
  3. 05-SCHEMA §10 queue wrapper: split into (a) migration that commits GRANT CREATE ON DATABASE / ON SCHEMA app TO lims_queue;
     (b) runner step `PGOPTIONS='-c role=lims_queue' graphile-worker --schema-only -c postgres://lims_migrator@<host>/<db>`
     (direct connection); (c) migration creating app.enqueue_job / app.queue_depth as lims_queue and revoking both CREATEs. The
     runner re-runs (c)'s revokes if (b) or (c) fails. Optional: drop the `::smallint` cast on max_attempts (0.18.0 add_job takes integer).
Backward compatible? yes (documents current behaviour; no role or grant change)
Tenant/security impact: no RLS change on LIMS tables, no PHI, no new surface. Residual DDL limited to the queue schema (REQ-SEC-029/030 spirit; 08 A25 D-201)
IRD/regulatory impact: n/a
Alternatives considered: DML-only worker role (tested: fails on RLS); adding policies to graphile_worker tables (vendor schema
  change, rejected); pg-boss (research 03 §4.1; not needed, since outcome is partial, not fail).
Tests that will prove it: db/tests/roles — lims_worker has no CREATE on app/database (has_*_privilege = f); lims_queue has no
  CREATE on database/app after migrate; lims_api gets "permission denied for schema graphile_worker" on add_job.
```
