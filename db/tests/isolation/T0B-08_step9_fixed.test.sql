-- T0B-08 probe step 9, registry-driven (02-TRD §4.5 step 9; AC-0B-3.6a, AC-0B-3.6b; 05-SCHEMA §10 schema test 24; 08 A17 P-16, A23.3).
-- Claims of actor type partner, portal and patient of tenant A read 0 rows from every registered tenant table that is not shared_with;
-- on the shared_with tables core.event_log and audit.access_log they read 0 rows too and may INSERT only rows carrying their own actor id;
-- on core.idempotency_keys they see only their own rows. A staff control proves the seeded rows are really there (the zeros are not vacuous).
-- The per-table generated probes (gen-isolation-probes.ts) repeat step 9 for each table; this file is the fixed, registry-wide guard.
-- Run from the repo root: pg_prove -d <db> db/tests/isolation/T0B-08_step9_fixed.test.sql   (superuser; pgTAP in schema `extensions`)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\i db/tests/isolation/_registry.sql

CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-0000000000' || lpad(k, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.x(p_role text, p_claims text, p_sql text, p_mode text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := 'n=' || n;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := 'n=' || n; END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.actor(p_type text, p_sub text) RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', pg_temp.id('01'), 'sub', pg_temp.id(p_sub))::text $$;
CREATE TEMP TABLE actors(a, sub) AS VALUES ('partner','a1'),('portal','a2'),('patient','a3');

-- ---------- fixtures (tenant A and B; triggers off) ----------
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id('01'), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active', pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('02'), 'lab_b', 'Lab B Pvt Ltd', 'Lab B', 'active', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.branches (id, tenant_id, branch_code, name, created_by, updated_by) VALUES
  (pg_temp.id('11'), pg_temp.id('01'), 'BA', 'Branch A', pg_temp.id('99'), pg_temp.id('99')), (pg_temp.id('12'), pg_temp.id('02'), 'BB', 'Branch B', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.users (tenant_id, id, display_name, created_by, updated_by) VALUES (pg_temp.id('01'), pg_temp.id('31'), 'User 31', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, all_centres, created_by, updated_by) VALUES
  (pg_temp.id('41'), pg_temp.id('01'), pg_temp.id('31'), 'user', true, pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, row_id, action, actor_id, actor_type, created_by) VALUES
  (pg_temp.id('81'), pg_temp.id('01'), 'core', 'branches', pg_temp.id('11'), 'INSERT', pg_temp.id('99'), 'user', pg_temp.id('99'));
INSERT INTO audit.g_cs_access_actions (code, display) VALUES ('patient.view', 'Patient view') ON CONFLICT DO NOTHING;
INSERT INTO audit.access_log (id, tenant_id, actor_id, actor_type, action, entity_type, outcome, created_by) VALUES
  (pg_temp.id('91'), pg_temp.id('01'), pg_temp.id('99'), 'user', 'patient.view', 'patient', 'allowed', pg_temp.id('99'));
SET LOCAL session_replication_role = origin;

-- staff control: the seeded rows are visible to a staff member of tenant A
SELECT is(pg_temp.x('lims_api', pg_temp.actor('user', '99'), 'SELECT 1 FROM ' || t, 'n'), 'n=1', 'probe step 9 control: staff of tenant A sees the seeded row of ' || t)
  FROM unnest(ARRAY['core.branches','core.users','core.memberships','audit.audit_log','audit.access_log']) t;

-- probe step 9: every registered tenant table that is not shared_with reads 0 rows for partner, portal and patient claims of tenant A
SELECT is(pg_temp.x('lims_api', pg_temp.actor(a.a, a.sub), 'SELECT 1 FROM ' || to_regclass(g.tbl)::text, 'n'), 'n=0',
          'probe step 9: ' || a.a || ' claims read 0 rows of ' || g.tbl)
  FROM registry g, actors a
 WHERE g.class <> 'G' AND NOT g.rls_exempt AND to_regclass(g.tbl) IS NOT NULL AND cardinality(g.shared_with) = 0;

-- probe step 9 on the shared_with tables: event_log / access_log read 0 rows for every non-staff actor
SELECT is(pg_temp.x('lims_api', pg_temp.actor(a.a, a.sub), 'SELECT 1 FROM ' || to_regclass(g.tbl)::text, 'n'), 'n=0',
          'probe step 9: ' || a.a || ' claims read 0 rows of shared_with table ' || g.tbl)
  FROM registry g, actors a WHERE g.tbl IN ('core.event_log', 'audit.access_log') AND to_regclass(g.tbl) IS NOT NULL;

-- own-actor INSERT into audit.access_log is allowed; another actor id or another tenant is refused (42501)
SELECT is(pg_temp.x('lims_api', pg_temp.actor(a.a, a.sub), format($$INSERT INTO audit.access_log (id, tenant_id, actor_id, actor_type, action, entity_type, outcome, created_by)
    VALUES (gen_random_uuid(), %L, %L, %L, 'patient.view', 'patient', 'allowed', %L)$$, pg_temp.id('01'), pg_temp.id(a.sub), a.a, pg_temp.id(a.sub)), 'w'), 'n=1',
  'probe step 9: ' || a.a || ' may INSERT an access_log row carrying its own actor id')
  FROM actors a;
SELECT is(pg_temp.x('lims_api', pg_temp.actor(a.a, a.sub), format($$INSERT INTO audit.access_log (id, tenant_id, actor_id, actor_type, action, entity_type, outcome, created_by)
    VALUES (gen_random_uuid(), %L, %L, %L, 'patient.view', 'patient', 'allowed', %L)$$, pg_temp.id('01'), pg_temp.id('99'), a.a, pg_temp.id(a.sub)), 'w'), 'E42501',
  'probe step 9: ' || a.a || ' INSERT into access_log with another actor id fails 42501')
  FROM actors a;
SELECT is(pg_temp.x('lims_api', pg_temp.actor(a.a, a.sub), format($$INSERT INTO audit.access_log (id, tenant_id, actor_id, actor_type, action, entity_type, outcome, created_by)
    VALUES (gen_random_uuid(), %L, %L, %L, 'patient.view', 'patient', 'allowed', %L)$$, pg_temp.id('02'), pg_temp.id(a.sub), a.a, pg_temp.id(a.sub)), 'w'), 'E42501',
  'probe step 9: ' || a.a || ' INSERT into access_log for tenant B fails 42501')
  FROM actors a;
-- a non-shared table refuses any non-staff INSERT
SELECT is(pg_temp.x('lims_api', pg_temp.actor(a.a, a.sub), format($$INSERT INTO core.branches (id, tenant_id, branch_code, name, created_by, updated_by)
    VALUES (gen_random_uuid(), %L, 'ZZ', 'x', %L, %L)$$, pg_temp.id('01'), pg_temp.id(a.sub), pg_temp.id(a.sub)), 'w'), 'E42501',
  'probe step 9: ' || a.a || ' INSERT into non-shared core.branches fails 42501')
  FROM actors a;

-- core.idempotency_keys (shared_with): own rows only
SELECT CASE WHEN to_regclass('core.idempotency_keys') IS NULL THEN skip('object not present yet: probe step 9 core.idempotency_keys own-rows test', 1)
            ELSE is(pg_temp.x('lims_api', pg_temp.actor(a.a, a.sub), format($$INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, expires_at)
    VALUES (%L, %L, 'own1', 'POST', '/x', decode(repeat('00', 32), 'hex'), 'in_progress', now() + interval '1 day')$$, pg_temp.id('01'), pg_temp.id(a.sub)), 'w'), 'n=1',
    'probe step 9: ' || a.a || ' may INSERT its own core.idempotency_keys row') END
  FROM actors a;
SELECT CASE WHEN to_regclass('core.idempotency_keys') IS NULL THEN skip('object not present yet: probe step 9 core.idempotency_keys see-own-only test', 1)
            ELSE is(pg_temp.x('lims_api', pg_temp.actor(a.a, a.sub), 'SELECT 1 FROM core.idempotency_keys', 'n'), 'n=1',
    'probe step 9: ' || a.a || ' sees only its own core.idempotency_keys row (3 actors inserted, 1 visible)') END
  FROM actors a;

SELECT * FROM finish();
ROLLBACK;
