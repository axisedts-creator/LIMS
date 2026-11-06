APPROVE

Re-review after `[writer]/[tester] T0B-01 review fixes`. Both prior defects fixed:
1. `db/tests/roles/00_bootstrap_roles.test.sql:36` membership temp table now filters `g.rolname LIKE 'lims\_%'` (pg_monitor asserted separately, line 42).
2. `db/tests/roles/00_bootstrap_roles.test.sql:70-71` aclexplode moved to FROM (no SRF in WHERE).

`db/bootstrap/00_roles.sql` and `01_database.sql` are verbatim 05-SCHEMA §1 (11 roles, attrs, INHERIT/SET options, D-201 single CREATE WITH GRANT OPTION to lims_owner, CONNECT, PUBLIC lockdown, extensions). No secrets (passwords via psql vars), no invented names, no PHI; files within db/ paths. pgTAP suite covers every §1 CI assertion in scope for T0B-01 plus schema test 30 (publication check belongs to the later audit migration). `node --test tests/db/T0B-01.bootstrap.test.mjs`: 8/8 pass.

Not verified: pgTAP suite not executed (no DB in lane); schema-`app` checks need T0B-02 migrated DB.
