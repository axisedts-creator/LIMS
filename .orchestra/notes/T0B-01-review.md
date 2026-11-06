CHANGES

Implementation (`db/bootstrap/00_roles.sql`, `01_database.sql`) is verbatim 05-SCHEMA §1 (roles, attrs, INHERIT/SET options, D-201 single CREATE WITH GRANT OPTION to lims_owner, CONNECT, PUBLIC lockdown, extensions); no secrets, no invented names. Static suite `node --test tests/db/T0B-01.bootstrap.test.mjs` 8/8 pass. Defects are in the pgTAP suite, which would fail/error on a real bootstrapped DB:

1. `db/tests/roles/00_bootstrap_roles.test.sql:36-41` — temp table `m` filters only on `u.rolname LIKE 'lims\_%'`, so it also captures `GRANT pg_monitor TO lims_monitor` (00_roles.sql:20) as row `('pg_monitor','lims_monitor',true,true)`; the expected VALUES list omits it, so `results_eq` fails. Fix: change line 36 to `WHERE u.rolname LIKE 'lims\_%' AND g.rolname LIKE 'lims\_%';` (pg_monitor membership is already asserted separately at line 42).

2. `db/tests/roles/00_bootstrap_roles.test.sql:70-71` — set-returning `aclexplode()` in WHERE raises `ERROR: set-returning functions are not allowed in WHERE`, aborting the transaction and every later assertion. Fix: replace with
   `SELECT is_empty($$SELECT a.privilege_type FROM pg_database d, aclexplode(d.datacl) a WHERE d.datname = current_database() AND a.grantee = 0$$, 'ALL on database revoked from PUBLIC');`

Not verified: pgTAP suite not executed (no DB/psql in lane); schema test 30 `has_schema_privilege(..., 'app', ...)` requires T0B-02 schema `app` to exist (suite documented as run on migrated DB — OK).
