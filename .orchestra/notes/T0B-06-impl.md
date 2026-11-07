# T0B-06 impl (writer)
- Added `db/migrations/20261105000700_core__create_membership_branches.sql` (C0 §10 table, `app.tg_scope_user_only` INVOKER + both `__scope_user_only` triggers, ENABLE/FORCE RLS, 3 `__tenant` policies, grants, `__audit` trigger) and `20261105000800_app__create_identity_definers.sql` (19 DEFINERs, text copied mechanically from C2 05-SCHEMA §10.3, REVOKE PUBLIC + lims_api/lims_worker grants). `db/policies/core.sql` gains the membership_branches policies.
- [CONV] `SET LOCAL check_function_bodies = off`: bodies read `identity.*` tables that C2 creates in a later stage.
- [CONV] `identity_is_breached` / `identity_tenants_for_email_hmacs` omitted (T0B-05 / C2); dropped from the §10.3 REVOKE list and their two GRANT lines omitted, so the migration does not reference missing functions.
- [CONV] Timestamps 0700/0800 leave no slot before 0600; T0B-05 must pick a later stamp if it must precede.
- OPEN 1: identity owner policies (C2 §5.4/§10.1) not created — tables are C2 DDL; static test prints NOTE, live fixture covers them. C2 must ship them with its tables.
- OPEN 2: pgTAP suites NOT run (no psql/pg_prove on this host). Node: T0B-06 14/14, tests/db 67/67 pass.
