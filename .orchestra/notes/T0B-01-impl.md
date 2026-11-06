# T0B-01 impl (writer)
- Files: `db/bootstrap/00_roles.sql` (11 roles, memberships INHERIT/SET, session guards), `db/bootstrap/01_database.sql` (D-201 CREATE WITH GRANT OPTION to lims_owner only, CONNECT, PUBLIC lockdown, pg_trgm/btree_gin in `extensions`). Both verbatim from 05-SCHEMA §1.
- [CONV] idle_in_transaction_session_timeout 30s/120s and lims_owner GRANT OPTION, as already marked [CONV] in 05-SCHEMA §1.
- Comments: dropped the literal word "pgtap" from 01_database.sql comment (static test forbids it); meaning kept.
- Run: `node --test tests/db/T0B-01.bootstrap.test.mjs` → 8/8 pass. pgTAP suite NOT run (no psql/pg_prove/DB in this lane).
- Open: SP-3 must confirm pg_trgm/btree_gin + `extensions` schema in supabase/postgres:17.6.1.136, and Supabase service-role CONNECT grants (UNVERIFIED; left as comment).
- Review round: both review items were test-only (fixed by tester in 6dd5189); no impl change needed. Node suite re-run 8/8 pass.
- Open: files are not idempotent (CREATE ROLE fails on rerun) — matches spec "run once per cluster"; use psql ON_ERROR_STOP=1.
