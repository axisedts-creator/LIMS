# T-15 spike: audit store subscription owner and RLS behaviour

Scope: 02-TRD §10.3 "UNVERIFIED → spike T-15", 05-SCHEMA §3.2 (`audit_writer` row), §4 (RLS bullet), PLAN risk R3.
Applies to both LD-45 profiles: `full` = database `auditstore` on its own PostgreSQL 17 instance (port 5433) on the dr
host; `lean` (prod default) and dev = database `lims_audit` in the same cluster as the application database.

## Subscription owner

- Owner: `audit_writer` (as 05-SCHEMA §3.2), created with `run_as_owner = true`.
- Why: on PG 16+ the apply worker by default (`run_as_owner = false`) switches to the **table owner** for every change,
  so the subscription owner must be able to `SET ROLE auditstore_owner` - that membership gives UPDATE/DELETE/TRUNCATE
  and breaks AC-18.3. With `run_as_owner = true` the apply worker writes as `audit_writer` itself, which needs only
  `INSERT` (the publication `lims_audit_ship` is `publish = 'insert'`, so no UPDATE/DELETE ever arrives).
  The fallback in §3.2 ("`auditstore_owner` becomes the subscription owner") is therefore not needed.
- Creating it as a non-superuser (PG 16+): `audit_writer` is granted `pg_create_subscription` and `CREATE` on the
  store database (schema.sql). Neither gives any privilege on the replicated tables; `auditstore_roles.sql` asserts
  `audit_writer` has no UPDATE/DELETE/TRUNCATE and no path to `auditstore_owner`.
- A non-superuser owner implies `password_required = true`: the conninfo carries the `lims_audit_ship` password
  (from the secret store, rendered by role `auditstore` with `no_log`) and the publisher must authenticate it with
  `scram-sha-256` (a `trust` line would make the apply worker refuse to connect).
- Slot: always pre-created on the publisher with `pg_create_logical_replication_slot('audit_ship', 'pgoutput')`, and the
  subscription uses `create_slot = false`, `slot_name = 'audit_ship'`, `copy_data = false`, `streaming = on`. In `lean`
  publisher and subscriber share a cluster, where `CREATE SUBSCRIPTION ... create_slot = true` hangs (PG docs: create
  the slot separately); doing the same in `full` keeps one code path.

## RLS behaviour

- Publisher tables are ENABLE + FORCE RLS (02-CONVENTIONS); no policy names `lims_audit_ship`, which is
  `REPLICATION NOBYPASSRLS` (CR-C1-002). A plain `SELECT` by it returns zero rows.
- Logical decoding (`pgoutput`) reads WAL, not the table through the executor, so RLS does not filter what is streamed.
  The only RLS-checked path is the initial table sync (COPY), which refuses/filters rows for a non-BYPASSRLS role; it is
  never used because `copy_data = false` (go-live start, no initial copy).
- Store tables have no RLS and no policy (05-SCHEMA §3.1, §3.6): access is by role only.

## Evidence and verdict

- Live proof: `infra/tests/integration/test_t15_live.py` (LD-45 `lean` shape, FORCE RLS publisher, `create_slot=false`,
  insert < 60 s, publisher delete not propagated, role assertions, digest, drift). Requires PG 17 binaries
  (`LIMS_T15_LIVE=1`); it has NOT been run on the authoring machine. If it fails on the RLS case, switch to the 02-TRD
  §10.3 fallback (SECURITY DEFINER export function) with a CR to C0-0B in `.orchestra/cr/`.
- Verdict: UNVERIFIED. Expected outcome from documented PostgreSQL 17 behaviour: CONFIRMED (owner `audit_writer`,
  `run_as_owner = true`, scram). It may be marked CONFIRMED only after the first green run of the live test (Linux + PG 17;
  not possible on the Windows authoring machine), with its output pasted in `.orchestra/notes/T-15-impl.md`. A red run
  means FALLBACK + CR (see above).

## Scale triggers (LD-45)

Move from `lean` to `full` (separate store instance on its own host) when any holds: sustained CPU > 60 % or RAM > 80 %
at peak for 7 days, DB > 150 GB, or a second lab group signs. In `lean` the tamper evidence must leave the host through
the nightly digests shipped to the backup host (LD-45) and the `ops_audit` stream (02-TRD §10.3): NOT YET IMPLEMENTED —
see `.orchestra/cr/T-15.md`.
