APPROVE

# T0B-04 review (reviewer)
- Range a08733c..HEAD has only `.orchestra/notes/T0B-04-verify.cmd`. I also reviewed the T0B-04 deliverables already merged into base (72290dd impl, 6e7209b debug): `db/seeds/003_audit__g_cs_access_actions.sql`, `db/policies/audit.sql`, `db/migrations/20261105000600_audit__create_audit_tables.sql`, `tests/db/T0B-04.audit-seed-policies.test.mjs`, `db/tests/audit/T0B-04_audit.test.sql`.
- Names: tables, columns, constraints, indexes and the 7 policies match 05-SCHEMA §3.6/§3.7/§5 and the §10 DDL (lines 1680-1713) verbatim. Seed = §3.7 base list ∪ 03-IC §13.1 (91 codes). `patient.demographics_access` and reserved `legacy_document.download` are excluded, as the spec requires.
- Tenant isolation: ENABLE+FORCE RLS on both tables. SELECT policies have tenant bind + `is_staff_or_system()` + CR-C2-010 centre clause in cast form `::uuid[]` (08 A28.6). No UPDATE/DELETE policy. Only `lims_owner` can insert into audit_log. Partner/portal/patient inserts are bound to their own actor_id (08 A23.3).
- Grants: lims_app has SELECT on audit_log only (AC-0B-5.3) and SELECT+INSERT on access_log. No UPDATE on either table (AC-0B-4.3). The coded set is read-only.
- Indexes: request_id and partial support_session indexes exist on both tables (08 A28.6).
- No PHI, no secrets. Only owned paths touched (tests in tests/db, db/tests).
- Ran: `node --test tests/db/T0B-04.audit-seed-policies.test.mjs`, 10/10 pass.
- Not verified: the pgTAP file was not run (no psql/pg_prove on PATH), so the live-DB grant tests (42501 checks) are unproven. Run it on the first DB-equipped CI.
- Note (no change needed): the seed header names `tools/codegen/gen-access-actions.ts` (T0C-05, not yet built). When it ships, its output must match this file byte-for-byte; the impl note records this as [CONV].
