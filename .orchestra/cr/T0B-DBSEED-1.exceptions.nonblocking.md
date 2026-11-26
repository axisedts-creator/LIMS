Title: CR-C0-T0B-DBSEED-1: registry tables the isolation-probe fixtures cannot fully seed (LD-233 exceptions)
From chunk: C0 (lane C0-0B, task T0B-DBSEED-1)            To owner: C0-0B
Type: bug
Blocking? no (the three probes keep failing only their step-1 actor precondition; every other registry table is seeded)
Problem (AC-0B-3.2/3.6, LD-233): the probe of a shared_with table needs one row per step-9 actor (partner 35, portal a3, patient 34) for tenant A,
plus a tenant B row. For the tables below the migrations' own keys allow fewer tenant-A rows than that, so no valid synthetic row set exists
without disabling a constraint. db/tools/gen-isolation-probes.ts emits no rows for them (output of `node db/tools/gen-isolation-probes.ts --report`).

Exceptions (one per line, `table: reason`):
- engagement.booking_centres: UNIQUE (tenant_id, centre_id) and tenant A has only two centres (21, 22), so at most two tenant-A rows; three actor-owned rows are impossible
- partners.settings: PRIMARY KEY (tenant_id) allows exactly one row per tenant, so rows owned by partner, portal and patient actors cannot coexist
- reporting.settings: UNIQUE (tenant_id) allows exactly one row per tenant, so rows owned by partner, portal and patient actors cannot coexist

Proposed change (exact): none in db/. Owner decision needed: either (a) drop shared_with for these per-tenant singleton tables in db/meta/tables.yaml
(if non-staff actors are not meant to own rows there), or (b) change the generated step-1 actor precondition to accept a single row whose owner column
is any one fixture actor. Neither is in this task's scope (LD-233 RULES: no spec/registry/assertion change).
Backward compatible? yes. Tenant/security impact: none (tests only; synthetic rows; REQ-SEC-041/136).
Alternatives considered: more centres (core preamble rows are byte-frozen by the "no assertion weakened" baseline); disabling the key (forbidden).
Tests that will prove it: tests/db/T0B-DBSEED-1.fixtures.test.mjs; founder rerun `LIMS_SKIP_GEN=1 bash db/tests/run-suites.sh <probe files>`.

Status 2026-11-26 (owner-approved, option (b) in effect): the generator now emits the tenant A / B rows of these three tables and skips only the actor-owned rows that cannot exist; the probe drops that actor's step-1 precondition and step 9 asserts the tenant boundary for it. The entries above stay as the record of WHY no actor-owned row exists; tests/db/T0B-DBSEED-1.fixtures.test.mjs reads them as "actor rows impossible", not "no rows".
