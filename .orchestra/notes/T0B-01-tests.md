# T0B-01 tests (tester)
- `tests/db/T0B-01.bootstrap.test.mjs` — static checks of `db/bootstrap/00_roles.sql` + `01_database.sql` (attrs, memberships INHERIT/SET, pw vars, D-201 single CREATE grant, PUBLIC lockdown, CONNECT, extensions). Run: `node --test tests/db/T0B-01.bootstrap.test.mjs`
- `db/tests/roles/00_bootstrap_roles.test.sql` — pgTAP vs live bootstrapped DB (AC-0B-1.1/1.2, schema test 30 no standing CREATE, escalation, GRANT OPTION). Run: `pg_prove -d <db> db/tests/roles/00_bootstrap_roles.test.sql` (needs pgTAP in schema `extensions`, test DB only).
- Status: node suite fails now — `db/bootstrap/*.sql` missing. pgTAP not run (no psql/DB here).
- Assumes PG16+ `pg_auth_members.inherit_option/set_option`; module-schema owner check excludes Supabase/system schemas (vacuous until T0B-02+).
