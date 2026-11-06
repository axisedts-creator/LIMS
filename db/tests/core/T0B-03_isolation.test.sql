-- T0B-03 live-DB assertions, part 2: tenant isolation probes, centre scope, fail-closed, non-staff actors, helpers-positive, GUC-bound owner policies
-- (AC-0B-3.1 .. 3.7 incl. 3.6a/3.6b, AC-0B-2.4 (DEFINER helpers under FORCE RLS); 05-SCHEMA §10 schema tests 17, 24, 33(audit viewer scope);
--  08 A12.1, A17 P-16, A19.1, A23.3, A28.6). Synthetic data only; one rolled-back txn; RLS is never disabled.
-- Run: pg_prove -d <db> db/tests/core/T0B-03_isolation.test.sql   (pgTAP in schema `extensions`)
-- Decision followed: `device` stays INSIDE the staff guard (08 A19.1, schema test 24) — it overrides the looser wording of AC-0B-3.6a.
-- Tables of T0B-05 (core.event_log, core.idempotency_keys) are asserted only when they exist; otherwise a skip is reported.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-0000000000' || lpad(k, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.cl(p_type text, p_tenant text DEFAULT NULL, p_sub text DEFAULT '99', p_mem text DEFAULT NULL, p_extra jsonb DEFAULT '{}') RETURNS text
LANGUAGE sql AS $$ SELECT (jsonb_strip_nulls(jsonb_build_object('actor_type', p_type, 'tenant_id', pg_temp.id(p_tenant), 'sub', pg_temp.id(p_sub),
  'membership_id', pg_temp.id(p_mem))) || p_extra)::text $$;
CREATE FUNCTION pg_temp.as_x(p_role text, p_claims text, p_sql text, p_mode text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := 'v=' || coalesce(r, '<null>');
    ELSIF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := 'n=' || n;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := 'n=' || n; END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.w(c text, s text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.as_x('lims_api', c, s, 'w') $$;
CREATE FUNCTION pg_temp.n(c text, s text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.as_x('lims_api', c, s, 'n') $$;
CREATE FUNCTION pg_temp.v(c text, s text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.as_x('lims_api', c, s, 'v') $$;
CREATE FUNCTION pg_temp.uA() RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.cl('user', '01', '31', '41') $$;      -- staff A, centre A1 only
CREATE FUNCTION pg_temp.hubA() RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.cl('user', '01', '32', '42') $$;    -- staff A, all_centres
CREATE FUNCTION pg_temp.uB() RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.cl('user', '02', '33', '43') $$;

-- ---------- fixtures ----------
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id('01'), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active', pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('02'), 'lab_b', 'Lab B Pvt Ltd', 'Lab B', 'suspended', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.branches (id, tenant_id, branch_code, name, created_by, updated_by) VALUES
  (pg_temp.id('11'), pg_temp.id('01'), 'BA', 'Branch A', pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('12'), pg_temp.id('02'), 'BB', 'Branch B', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.collection_centres (id, tenant_id, branch_id, centre_code, name, centre_kind, created_by, updated_by) VALUES
  (pg_temp.id('21'), pg_temp.id('01'), pg_temp.id('11'), 'CA1', 'Centre A1', 'own', pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('22'), pg_temp.id('01'), pg_temp.id('11'), 'CA2', 'Centre A2', 'own', pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('23'), pg_temp.id('02'), pg_temp.id('12'), 'CB1', 'Centre B1', 'own', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.users (tenant_id, id, display_name, email_hmac, created_by, updated_by) VALUES
  (pg_temp.id('01'), pg_temp.id('31'), 'User 31', NULL, pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('01'), pg_temp.id('32'), 'User 32', NULL, pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('01'), pg_temp.id('34'), 'User 34', NULL, pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('01'), pg_temp.id('35'), 'User 35', decode(repeat('ab', 32), 'hex'), pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('02'), pg_temp.id('33'), 'User 33', decode(repeat('ab', 32), 'hex'), pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, all_centres, partner_role, created_by, updated_by) VALUES
  (pg_temp.id('41'), pg_temp.id('01'), pg_temp.id('31'), 'user',    false, NULL,             pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('42'), pg_temp.id('01'), pg_temp.id('32'), 'user',    true,  NULL,             pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('43'), pg_temp.id('02'), pg_temp.id('33'), 'user',    false, NULL,             pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('44'), pg_temp.id('01'), pg_temp.id('34'), 'patient', false, NULL,             pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('45'), pg_temp.id('01'), pg_temp.id('35'), 'partner', false, 'partner_member', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.membership_centres (tenant_id, membership_id, centre_id, created_by) VALUES (pg_temp.id('01'), pg_temp.id('41'), pg_temp.id('21'), pg_temp.id('99'));
INSERT INTO core.roles (id, tenant_id, role_code, display_name, created_by, updated_by) VALUES
  (pg_temp.id('51'), pg_temp.id('01'), 'admin', 'Admin', pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('52'), pg_temp.id('02'), 'admin', 'Admin', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.g_permissions (code, module, privileged, phase) VALUES ('lab.result.view', 'lab', false, '1') ON CONFLICT DO NOTHING;
INSERT INTO core.role_permissions (tenant_id, role_id, permission_code, created_by) VALUES
  (pg_temp.id('01'), pg_temp.id('51'), 'lab.result.view', pg_temp.id('99')), (pg_temp.id('02'), pg_temp.id('52'), 'lab.result.view', pg_temp.id('99'));
INSERT INTO core.membership_roles (tenant_id, membership_id, role_id, created_by) VALUES
  (pg_temp.id('01'), pg_temp.id('41'), pg_temp.id('51'), pg_temp.id('99')), (pg_temp.id('02'), pg_temp.id('43'), pg_temp.id('52'), pg_temp.id('99'));
INSERT INTO audit.audit_log (id, tenant_id, centre_id, schema_name, table_name, row_id, action, actor_id, actor_type, created_by) VALUES
  (pg_temp.id('81'), pg_temp.id('01'), NULL,            'core', 'branches', pg_temp.id('11'), 'INSERT', pg_temp.id('99'), 'user', pg_temp.id('99')),
  (pg_temp.id('82'), pg_temp.id('01'), pg_temp.id('21'), 'core', 'branches', pg_temp.id('11'), 'UPDATE', pg_temp.id('99'), 'user', pg_temp.id('99')),
  (pg_temp.id('83'), pg_temp.id('01'), pg_temp.id('22'), 'core', 'branches', pg_temp.id('11'), 'UPDATE', pg_temp.id('99'), 'user', pg_temp.id('99')),
  (pg_temp.id('84'), pg_temp.id('02'), NULL,            'core', 'branches', pg_temp.id('12'), 'INSERT', pg_temp.id('99'), 'user', pg_temp.id('99'));
INSERT INTO audit.g_cs_access_actions (code, display) VALUES ('patient.view', 'Patient view') ON CONFLICT DO NOTHING;
INSERT INTO audit.access_log (id, tenant_id, centre_id, actor_id, actor_type, action, entity_type, outcome, created_by) VALUES
  (pg_temp.id('91'), pg_temp.id('01'), NULL,            pg_temp.id('99'), 'user', 'patient.view', 'patient', 'allowed', pg_temp.id('99')),
  (pg_temp.id('92'), pg_temp.id('01'), pg_temp.id('21'), pg_temp.id('99'), 'user', 'patient.view', 'patient', 'allowed', pg_temp.id('99')),
  (pg_temp.id('93'), pg_temp.id('01'), pg_temp.id('22'), pg_temp.id('99'), 'user', 'patient.view', 'patient', 'allowed', pg_temp.id('99')),
  (pg_temp.id('94'), pg_temp.id('02'), NULL,            pg_temp.id('99'), 'user', 'patient.view', 'patient', 'allowed', pg_temp.id('99'));
SET LOCAL session_replication_role = origin;

-- precondition: FORCE RLS is on for everything the DEFINER helpers touch (AC-0B-2.4)
SELECT is(relforcerowsecurity AND relrowsecurity, true, 'FORCE RLS on ' || relname)
  FROM pg_class WHERE oid IN ('core.memberships'::regclass, 'core.membership_centres'::regclass);

-- ================= AC-0B-3.1: claims of tenant A never see tenant B =================
-- (table, tenant column, expected visible rows of tenant A for a centre-scoped staff user, sql to insert a TENANT B row for the 3.2 probe)
CREATE TEMP TABLE probe (t text, tcol text, a_rows int, ins_b text) ON COMMIT DROP;
INSERT INTO probe VALUES
 ('core.tenants', 'id', 1, format($$INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, created_by, updated_by) VALUES (%L, 'lab_x', 'X', 'X', %L, %L)$$, pg_temp.id('02'), pg_temp.id('31'), pg_temp.id('31'))),
 ('core.branches', 'tenant_id', 1, format($$INSERT INTO core.branches (id, tenant_id, branch_code, name, created_by, updated_by) VALUES (%L, %L, 'BX', 'X', %L, %L)$$, pg_temp.id('b1'), pg_temp.id('02'), pg_temp.id('31'), pg_temp.id('31'))),
 ('core.collection_centres', 'tenant_id', 2, format($$INSERT INTO core.collection_centres (id, tenant_id, branch_id, centre_code, name, centre_kind, created_by, updated_by) VALUES (%L, %L, %L, 'CX', 'X', 'own', %L, %L)$$, pg_temp.id('b2'), pg_temp.id('02'), pg_temp.id('12'), pg_temp.id('31'), pg_temp.id('31'))),
 ('core.users', 'tenant_id', 4, format($$INSERT INTO core.users (tenant_id, id, display_name, created_by, updated_by) VALUES (%L, %L, 'X', %L, %L)$$, pg_temp.id('02'), pg_temp.id('b3'), pg_temp.id('31'), pg_temp.id('31'))),
 ('core.memberships', 'tenant_id', 4, format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, status, created_by, updated_by) VALUES (%L, %L, %L, 'patient', 'deactivated', %L, %L)$$, pg_temp.id('b4'), pg_temp.id('02'), pg_temp.id('33'), pg_temp.id('31'), pg_temp.id('31'))),
 ('core.membership_centres', 'tenant_id', 1, format($$INSERT INTO core.membership_centres (tenant_id, membership_id, centre_id, created_by) VALUES (%L, %L, %L, %L)$$, pg_temp.id('02'), pg_temp.id('43'), pg_temp.id('23'), pg_temp.id('31'))),
 ('core.roles', 'tenant_id', 1, format($$INSERT INTO core.roles (id, tenant_id, role_code, display_name, created_by, updated_by) VALUES (%L, %L, 'other', 'X', %L, %L)$$, pg_temp.id('b5'), pg_temp.id('02'), pg_temp.id('31'), pg_temp.id('31'))),
 ('core.role_permissions', 'tenant_id', 1, format($$INSERT INTO core.role_permissions (tenant_id, role_id, permission_code, created_by) VALUES (%L, %L, 'lab.result.view', %L)$$, pg_temp.id('02'), pg_temp.id('52'), pg_temp.id('31'))),
 ('core.membership_roles', 'tenant_id', 1, format($$INSERT INTO core.membership_roles (tenant_id, membership_id, role_id, created_by) VALUES (%L, %L, %L, %L)$$, pg_temp.id('02'), pg_temp.id('43'), pg_temp.id('52'), pg_temp.id('31'))),
 ('audit.access_log', 'tenant_id', 2, format($$INSERT INTO audit.access_log (id, tenant_id, actor_id, actor_type, action, entity_type, outcome, created_by) VALUES (%L, %L, %L, 'user', 'patient.view', 'patient', 'allowed', %L)$$, pg_temp.id('b6'), pg_temp.id('02'), pg_temp.id('31'), pg_temp.id('31')));

SELECT is(pg_temp.n(pg_temp.uA(), format('SELECT 1 FROM %s WHERE %I = %L', t, tcol, pg_temp.id('02'))), 'n=0', 'AC-0B-3.1: tenant A claims see 0 rows of tenant B in ' || t) FROM probe;
SELECT is(pg_temp.n(pg_temp.uA(), format('SELECT 1 FROM %s', t)), 'n=' || a_rows, 'positive control: tenant A claims see exactly their ' || a_rows || ' row(s) in ' || t) FROM probe;
SELECT is(pg_temp.n(pg_temp.uB(), format('SELECT 1 FROM %s WHERE %I = %L', t, tcol, pg_temp.id('01'))), 'n=0', 'AC-0B-3.1 (mirror): tenant B claims see 0 rows of tenant A in ' || t) FROM probe;
SELECT is(pg_temp.n(pg_temp.uA(), $$SELECT 1 FROM audit.audit_log WHERE tenant_id = pg_temp.id('02')$$), 'n=0', 'AC-0B-3.1: audit_log has no tenant B rows for tenant A claims');

-- ================= AC-0B-3.2: INSERT of a tenant B row by tenant A claims -> 42501 =================
SELECT is(left(pg_temp.w(pg_temp.uA(), ins_b), 6), 'E42501', 'AC-0B-3.2: tenant A claims inserting a tenant B row into ' || t || ' -> 42501') FROM probe;
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_type) VALUES (%L, %L, 'core', 'branches', 'INSERT', 'user')$$,
  pg_temp.id('b7'), pg_temp.id('01'))), 6), 'E42501', 'AC-0B-5.3 / 3.2: lims_api cannot INSERT into audit_log at all');

-- ================= AC-0B-3.3: UPDATE / DELETE of tenant B rows affect 0 rows =================
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.branches SET name = 'hijack' WHERE tenant_id = %L$$, pg_temp.id('02'))), 'n=0', 'AC-0B-3.3: UPDATE branches of tenant B -> 0 rows');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.collection_centres SET name = 'hijack' WHERE tenant_id = %L$$, pg_temp.id('02'))), 'n=0', 'AC-0B-3.3: UPDATE centres of tenant B -> 0 rows');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.users SET display_name = 'hijack' WHERE tenant_id = %L$$, pg_temp.id('02'))), 'n=0', 'AC-0B-3.3: UPDATE users of tenant B -> 0 rows');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.memberships SET status = 'deactivated' WHERE tenant_id = %L$$, pg_temp.id('02'))), 'n=0', 'AC-0B-3.3: UPDATE memberships of tenant B -> 0 rows');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.roles SET display_name = 'hijack' WHERE tenant_id = %L$$, pg_temp.id('02'))), 'n=0', 'AC-0B-3.3: UPDATE roles of tenant B -> 0 rows');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.tenants SET display_name = 'hijack' WHERE id = %L$$, pg_temp.id('02'))), 'n=0', 'AC-0B-3.3: UPDATE tenant B -> 0 rows');
SELECT is(pg_temp.w(pg_temp.uA(), format($$DELETE FROM core.membership_centres WHERE tenant_id = %L$$, pg_temp.id('02'))), 'n=0', 'AC-0B-3.3: DELETE membership_centres of tenant B -> 0 rows');
SELECT is(pg_temp.w(pg_temp.uA(), format($$DELETE FROM core.role_permissions WHERE tenant_id = %L$$, pg_temp.id('02'))), 'n=0', 'AC-0B-3.3: DELETE role_permissions of tenant B -> 0 rows');
SELECT is(pg_temp.w(pg_temp.uA(), format($$DELETE FROM core.membership_roles WHERE tenant_id = %L$$, pg_temp.id('02'))), 'n=0', 'AC-0B-3.3: DELETE membership_roles of tenant B -> 0 rows');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$DELETE FROM core.branches WHERE tenant_id = %L$$, pg_temp.id('01'))), 6), 'E42501', 'class M: no DELETE grant on branches (even for the own tenant)');
SELECT is((SELECT count(*)::int FROM core.branches WHERE tenant_id = pg_temp.id('02') AND name = 'Branch B'), 1, 'tenant B branch untouched after the hijack attempts');
SELECT is((SELECT count(*)::int FROM core.membership_centres WHERE tenant_id = pg_temp.id('01')), 1, 'own-tenant membership_centres row untouched by the cross-tenant delete');

-- ================= AC-0B-3.4 + schema test 33: centre scope on the two audit tables =================
SELECT is(pg_temp.n(pg_temp.uA(), $$SELECT 1 FROM audit.audit_log WHERE centre_id = pg_temp.id('22')$$), 'n=0', 'AC-0B-3.4: centre-scoped staff (A1) sees no audit_log row of centre A2');
SELECT is(pg_temp.n(pg_temp.uA(), $$SELECT 1 FROM audit.audit_log$$), 'n=2', 'test 33: centre-scoped staff sees centre NULL + own centre rows of audit_log only');
SELECT is(pg_temp.n(pg_temp.uA(), $$SELECT 1 FROM audit.audit_log WHERE centre_id IS NULL OR centre_id = pg_temp.id('21')$$), 'n=2', 'test 33: ... and they are exactly those');
SELECT is(pg_temp.n(pg_temp.uA(), $$SELECT 1 FROM audit.access_log WHERE centre_id = pg_temp.id('22')$$), 'n=0', 'AC-0B-3.4: no access_log row of centre A2 for the A1 user');
SELECT is(pg_temp.n(pg_temp.uA(), $$SELECT 1 FROM audit.access_log$$), 'n=2', 'test 33: access_log is scoped the same way');
SELECT is(pg_temp.n(pg_temp.hubA(), $$SELECT 1 FROM audit.audit_log$$), 'n=3', 'all_centres staff sees all three tenant-A audit rows');
SELECT is(pg_temp.n(pg_temp.hubA(), $$SELECT 1 FROM audit.access_log WHERE centre_id = pg_temp.id('22')$$), 'n=1', 'all_centres staff sees centre A2 access_log rows');
SELECT is(pg_temp.n(pg_temp.cl('device', '01', '99', NULL, jsonb_build_object('centre_id', pg_temp.id('21'))), $$SELECT 1 FROM audit.audit_log$$), 'n=2',
  'device with centre claim A1 is scoped to NULL + A1 (current_centre_ids reads the centre_id claim)');
SELECT is(pg_temp.n(pg_temp.cl('system', '01', '99'), $$SELECT 1 FROM audit.audit_log$$), 'n=3', 'system actor of tenant A sees every centre (has_all_centres true)');

-- ================= AC-0B-3.5: cross-tenant parent reference fails =================
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.collection_centres (id, tenant_id, branch_id, centre_code, name, centre_kind, created_by, updated_by) VALUES (%L, %L, %L, 'CZ', 'X', 'own', %L, %L)$$,
  pg_temp.id('c1'), pg_temp.id('01'), pg_temp.id('12'), pg_temp.id('31'), pg_temp.id('31'))), 6), 'E23503', 'AC-0B-3.5: centre of tenant A under tenant B branch -> 23503 (composite FK)');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, created_by, updated_by) VALUES (%L, %L, %L, 'patient', %L, %L)$$,
  pg_temp.id('c2'), pg_temp.id('01'), pg_temp.id('33'), pg_temp.id('31'), pg_temp.id('31'))), 6), 'E23503', 'AC-0B-3.5: membership of tenant A for a tenant B user -> 23503');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.membership_roles (tenant_id, membership_id, role_id, created_by) VALUES (%L, %L, %L, %L)$$,
  pg_temp.id('01'), pg_temp.id('42'), pg_temp.id('52'), pg_temp.id('31'))), 6), 'E23503', 'AC-0B-3.5: membership_roles referencing a tenant B role -> 23503');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.membership_centres (tenant_id, membership_id, centre_id, created_by) VALUES (%L, %L, %L, %L)$$,
  pg_temp.id('01'), pg_temp.id('42'), pg_temp.id('23'), pg_temp.id('31'))), 6), 'E23503', 'AC-0B-3.5: membership_centres referencing a tenant B centre -> 23503');
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.role_permissions (tenant_id, role_id, permission_code, created_by) VALUES (%L, %L, 'lab.result.view', %L)$$,
  pg_temp.id('01'), pg_temp.id('52'), pg_temp.id('31'))), 6), 'E23503', 'AC-0B-3.5: role_permissions referencing a tenant B role -> 23503');

-- ================= AC-0B-3.6a / 3.6b + schema test 24: non-staff actors =================
SELECT is(pg_temp.v(pg_temp.cl(a, '01', '99', m), 'SELECT app.has_all_centres()::text'), 'v=false', 'AC-0B-3.6a: has_all_centres() is false for ' || a)
  FROM (VALUES ('patient','44'), ('partner','45'), ('portal',NULL), ('device',NULL)) v(a, m);
SELECT is(pg_temp.n(pg_temp.cl(a, '01', '99', m), format('SELECT 1 FROM %s', t)), 'n=0', 'AC-0B-3.6a/b: ' || a || ' claims read 0 rows of ' || t)
  FROM (VALUES ('patient','44'), ('partner','45'), ('portal',NULL)) v(a, m),
       unnest(ARRAY['core.tenants','core.branches','core.collection_centres','core.users','core.memberships','core.membership_centres','core.roles',
         'core.role_permissions','core.membership_roles','audit.audit_log','audit.access_log']) t;
SELECT is(pg_temp.n(pg_temp.cl('device', '01', '99'), 'SELECT 1 FROM core.branches'), 'n=1', '08 A19.1: device claims still pass the staff guard');
SELECT is(pg_temp.n(pg_temp.cl('device', '01', '99'), 'SELECT 1 FROM core.tenants'), 'n=1', '08 A19.1: device sees its own tenant row');
SELECT is(pg_temp.n(pg_temp.cl('user', '01', '99'), 'SELECT 1 FROM core.branches'), 'n=1', 'plain user claims see their tenant');
-- shared_with: audit.access_log — INSERT own rows only, never SELECT
SELECT is(pg_temp.w(pg_temp.cl(a, '01', s, m), format($$INSERT INTO audit.access_log (id, tenant_id, actor_id, actor_type, action, entity_type, outcome, created_by)
  VALUES (%L, %L, %L, %L, 'patient.view', 'patient', 'allowed', %L)$$, pg_temp.id(i), pg_temp.id('01'), pg_temp.id(s), a, pg_temp.id(s))), 'n=1', 'schema test 24: ' || a || ' may INSERT its own access_log row')
  FROM (VALUES ('patient','44','a1'), ('partner','45','a2'), ('portal','a3','a3')) v(a, m, i) CROSS JOIN LATERAL (SELECT CASE a WHEN 'patient' THEN '34' WHEN 'partner' THEN '35' ELSE 'a3' END AS s) x;
SELECT is(left(pg_temp.w(pg_temp.cl(a, '01', s), format($$INSERT INTO audit.access_log (id, tenant_id, actor_id, actor_type, action, entity_type, outcome, created_by)
  VALUES (%L, %L, %L, %L, 'patient.view', 'patient', 'allowed', %L)$$, pg_temp.id('a9'), pg_temp.id('01'), pg_temp.id('31'), a, pg_temp.id(s))), 6), 'E42501',
  'schema test 24: ' || a || ' inserting with another actor id -> 42501')
  FROM (VALUES ('patient','34'), ('partner','35'), ('portal','a3')) v(a, s);
SELECT is(left(pg_temp.w(pg_temp.cl(a, '01', s), format($$INSERT INTO audit.access_log (id, tenant_id, actor_id, actor_type, action, entity_type, outcome, created_by)
  VALUES (%L, %L, %L, %L, 'patient.view', 'patient', 'allowed', %L)$$, pg_temp.id('a9'), pg_temp.id('02'), pg_temp.id(s), a, pg_temp.id(s))), 6), 'E42501',
  'schema test 24: ' || a || ' inserting into another tenant -> 42501')
  FROM (VALUES ('patient','34'), ('partner','35'), ('portal','a3')) v(a, s);
SELECT is(left(pg_temp.w(pg_temp.cl(a, '01', s), format($$INSERT INTO core.branches (id, tenant_id, branch_code, name, created_by, updated_by) VALUES (%L, %L, 'ZZ', 'X', %L, %L)$$,
  pg_temp.id('a8'), pg_temp.id('01'), pg_temp.id(s), pg_temp.id(s))), 6), 'E42501', 'schema test 24: ' || a || ' inserting into non-shared core.branches -> 42501')
  FROM (VALUES ('patient','34'), ('partner','35'), ('portal','a3')) v(a, s);
SELECT is(pg_temp.n(pg_temp.cl(a, '01', s), 'SELECT 1 FROM audit.access_log'), 'n=0', 'schema test 24: ' || a || ' reads 0 rows of access_log (even its own)')
  FROM (VALUES ('patient','34'), ('partner','35'), ('portal','a3')) v(a, s);
SELECT is(pg_temp.n(pg_temp.hubA(), $$SELECT 1 FROM audit.access_log WHERE actor_type IN ('patient','partner','portal')$$), 'n=3', 'schema test 24: staff of tenant A see the three non-staff access rows');
SELECT is(pg_temp.n(pg_temp.cl('patient', '01', '34'), 'SELECT 1 FROM audit.audit_log'), 'n=0', 'schema test 24: patient reads 0 rows of audit_log');
-- T0B-05 tables (guarded)
SELECT is(pg_temp.w(pg_temp.cl(a, '01', s), format($$INSERT INTO core.event_log (tenant_id, event_id, event_type, producer, idempotency_key, aggregate_type, aggregate_id, aggregate_seq, occurred_at, envelope, created_by)
  VALUES (%L, %L, 'x.y', 'p', 'k-' || %L, 'agg', %L, 1, now(), '{}', %L)$$, pg_temp.id('01'), pg_temp.id(i), a, pg_temp.id('c0'), pg_temp.id(s))), 'n=1', 'schema test 24: ' || a || ' may INSERT its own event_log row')
  FROM (VALUES ('patient','34','e1'), ('partner','35','e2'), ('portal','a3','e3')) v(a, s, i) WHERE to_regclass('core.event_log') IS NOT NULL;
SELECT is(pg_temp.n(pg_temp.cl(a, '01', s), 'SELECT 1 FROM core.event_log'), 'n=0', 'schema test 24: ' || a || ' reads 0 event_log rows')
  FROM (VALUES ('patient','34'), ('partner','35'), ('portal','a3')) v(a, s) WHERE to_regclass('core.event_log') IS NOT NULL;
SELECT is(left(pg_temp.w(pg_temp.cl(a, '01', s), format($$INSERT INTO core.event_log (tenant_id, event_id, event_type, producer, idempotency_key, aggregate_type, aggregate_id, aggregate_seq, occurred_at, envelope, created_by)
  VALUES (%L, %L, 'x.y', 'p', 'k2', 'agg', %L, 1, now(), '{}', %L)$$, pg_temp.id('01'), pg_temp.id('e9'), pg_temp.id('c0'), pg_temp.id('31'))), 6), 'E42501', 'schema test 24: ' || a || ' event_log row with another created_by -> 42501')
  FROM (VALUES ('patient','34'), ('partner','35'), ('portal','a3')) v(a, s) WHERE to_regclass('core.event_log') IS NOT NULL;
SELECT is(pg_temp.n(pg_temp.uA(), $$SELECT 1 FROM core.event_log$$), 'n=3', 'schema test 24: staff of tenant A see the three inserted events') WHERE to_regclass('core.event_log') IS NOT NULL;
SELECT is(pg_temp.w(pg_temp.cl(a, '01', s), format($$INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, expires_at)
  VALUES (%L, %L, 'k1', 'POST', '/x', decode(repeat('ab', 32), 'hex'), 'in_progress', now() + interval '1 day')$$, pg_temp.id('01'), pg_temp.id(s))), 'n=1', 'schema test 24: ' || a || ' INSERT own idempotency key')
  FROM (VALUES ('patient','34'), ('partner','35'), ('portal','a3')) v(a, s) WHERE to_regclass('core.idempotency_keys') IS NOT NULL;
SELECT is(pg_temp.n(pg_temp.cl(a, '01', s), 'SELECT 1 FROM core.idempotency_keys'), 'n=1', 'schema test 24: ' || a || ' sees only its own idempotency row')
  FROM (VALUES ('patient','34'), ('partner','35'), ('portal','a3')) v(a, s) WHERE to_regclass('core.idempotency_keys') IS NOT NULL;
SELECT is(pg_temp.w(pg_temp.cl(a, '01', s), $$UPDATE core.idempotency_keys SET route = '/y'$$), 'n=1', 'schema test 24: ' || a || ' UPDATE affects only its own row')
  FROM (VALUES ('patient','34'), ('partner','35'), ('portal','a3')) v(a, s) WHERE to_regclass('core.idempotency_keys') IS NOT NULL;
SELECT is(pg_temp.w(pg_temp.cl(a, '01', s), $$DELETE FROM core.idempotency_keys WHERE state = 'in_progress'$$), 'n=1', 'schema test 24: ' || a || ' DELETE affects only its own in_progress row')
  FROM (VALUES ('patient','34'), ('partner','35'), ('portal','a3')) v(a, s) WHERE to_regclass('core.idempotency_keys') IS NOT NULL;
SELECT skip('core.event_log / core.idempotency_keys not created yet (T0B-05): schema test 24 platform-table half runs after T0B-05', 1) WHERE to_regclass('core.event_log') IS NULL OR to_regclass('core.idempotency_keys') IS NULL;

-- ================= AC-0B-3.7: no claims at all -> fail closed =================
SELECT is(pg_temp.n(c, format('SELECT 1 FROM %s', t)), 'n=0', 'AC-0B-3.7: ' || label || ' -> 0 rows of ' || t)
  FROM (VALUES (NULL::text, 'no claims'), ('', 'empty claims'), ('{}', 'empty claims object')) k(c, label),
       unnest(ARRAY['core.tenants','core.branches','core.collection_centres','core.users','core.memberships','core.membership_centres','core.roles',
         'core.role_permissions','core.membership_roles','audit.audit_log','audit.access_log']) t;
SELECT is(left(pg_temp.w('', format($$INSERT INTO core.branches (id, tenant_id, branch_code, name, created_by, updated_by) VALUES (%L, %L, 'ZZ', 'X', %L, %L)$$,
  pg_temp.id('a7'), pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 6), 'E42501', 'AC-0B-3.7: no claims -> INSERT refused (42501)');
SELECT is(pg_temp.w('', $$UPDATE core.branches SET name = 'x'$$), 'n=0', 'AC-0B-3.7: no claims -> UPDATE affects 0 rows');
SELECT is(pg_temp.as_x('lims_worker', '', 'SELECT 1 FROM core.memberships', 'n'), 'n=0', 'AC-0B-3.7: lims_worker without claims also reads nothing');

-- ================= helpers-positive (schema test 17; AC-0B-2.4): DEFINER helpers return real data with FORCE RLS on =================
SELECT is(pg_temp.v(pg_temp.uA(), 'SELECT app.has_all_centres()::text'), 'v=false', 'centre-scoped user: has_all_centres() = false');
SELECT is(pg_temp.v(pg_temp.uA(), 'SELECT array_to_string(app.current_centre_ids(), '','')'), 'v=' || pg_temp.id('21'), 'centre-scoped user: current_centre_ids() = {A1} (non-empty under FORCE RLS)');
SELECT is(pg_temp.v(pg_temp.hubA(), 'SELECT app.has_all_centres()::text'), 'v=true', 'all_centres user: has_all_centres() = true');
SELECT is(pg_temp.v(pg_temp.hubA(), 'SELECT coalesce(array_length(app.current_centre_ids(), 1), 0)::text'), 'v=0', 'all_centres user: current_centre_ids() empty (no association rows)');
SELECT is(pg_temp.v(pg_temp.cl('system', '01', '99'), 'SELECT app.has_all_centres()::text'), 'v=true', 'system actor with a tenant: has_all_centres() = true');
SELECT is(pg_temp.v(pg_temp.cl('system', NULL, '99'), 'SELECT app.has_all_centres()::text'), 'v=false', 'system actor without a tenant: has_all_centres() = false');
SELECT is(pg_temp.v(pg_temp.cl('device', '01', '99', NULL, jsonb_build_object('centre_id', pg_temp.id('22'))), 'SELECT array_to_string(app.current_centre_ids(), '','')'), 'v=' || pg_temp.id('22'),
  'device: current_centre_ids() = {centre_id claim}');
SELECT is(pg_temp.v(pg_temp.cl('user', '02', '31', '41'), 'SELECT app.has_all_centres()::text'), 'v=false', 'membership of tenant A under tenant B claims: false (tenant bound)');
SELECT is(pg_temp.v(pg_temp.cl('user', '02', '31', '41'), 'SELECT coalesce(array_length(app.current_centre_ids(), 1), 0)::text'), 'v=0', 'membership of tenant A under tenant B claims: no centres');
SELECT is(pg_temp.v(pg_temp.cl('patient', '01', '34', '44'), 'SELECT app.has_all_centres()::text'), 'v=false', 'patient: false');
SELECT is(pg_temp.v(NULL, 'SELECT app.has_all_centres()::text'), 'v=false', 'no claims: has_all_centres() = false');
SELECT is(pg_temp.v(NULL, 'SELECT coalesce(array_length(app.current_centre_ids(), 1), 0)::text'), 'v=0', 'no claims: current_centre_ids() = {}');
SELECT is(pg_temp.v(pg_temp.uA(), 'SELECT app.has_all_centres()::text'), 'v=false', 'helpers work with app.pre_user_id unset (schema test 17)');
-- membership deactivated -> helpers stop answering for it
SET LOCAL session_replication_role = replica;
UPDATE core.memberships SET status = 'deactivated' WHERE id IN (pg_temp.id('41'), pg_temp.id('42'));
SET LOCAL session_replication_role = origin;
SELECT is(pg_temp.v(pg_temp.hubA(), 'SELECT app.has_all_centres()::text'), 'v=false', 'deactivated all_centres membership: has_all_centres() = false (m.is_active)');
SELECT is(pg_temp.v(pg_temp.uA(), 'SELECT coalesce(array_length(app.current_centre_ids(), 1), 0)::text'), 'v=0', 'deactivated membership: current_centre_ids() empty');
SET LOCAL session_replication_role = replica;
UPDATE core.memberships SET status = 'active' WHERE id IN (pg_temp.id('41'), pg_temp.id('42'));
SET LOCAL session_replication_role = origin;

-- ================= schema test 17 (behavioural): GUC-bound core owner policies =================
DO $$ BEGIN PERFORM set_config('app.pre_user_id', pg_temp.id('31')::text, true), set_config('app.pre_tenant_id', pg_temp.id('01')::text, true),
       set_config('app.pre_tenant_code', 'lab_b', true), set_config('app.maintenance', 'platform_list_tenants', true); END $$;
-- a lims_api / lims_worker session with NO claims that sets the GUCs itself sees nothing (the policies are TO lims_owner only)
SELECT is(pg_temp.as_x(r, '', format('SELECT 1 FROM %s', t), 'n'), 'n=0', 'schema test 17: ' || r || ' + GUCs set + no claims -> 0 rows of ' || t)
  FROM unnest(ARRAY['lims_api','lims_worker']) r, unnest(ARRAY['core.memberships','core.users','core.tenants','core.roles','core.membership_roles']) t;
-- the owner role, with the GUC set, sees exactly the GUC-bound rows (fixture rows only)
SELECT is(pg_temp.as_x('lims_owner', '', format('SELECT 1 FROM %s WHERE %s', t, f), 'n'), 'n=' || e, 'owner policy ' || t || ' with GUC: ' || f || ' -> ' || e)
  FROM (VALUES
    ('core.memberships',     $$id IN (SELECT pg_temp.id('41')) $$, 1),
    ('core.memberships',     $$tenant_id = pg_temp.id('01') $$,    1),
    ('core.memberships',     $$tenant_id = pg_temp.id('02') $$,    0),
    ('core.users',           $$id = pg_temp.id('31') $$,           1),
    ('core.users',           $$id = pg_temp.id('32') $$,           0),
    ('core.tenants',         $$id IN (pg_temp.id('01'), pg_temp.id('02')) $$, 2),
    ('core.roles',           $$tenant_id = pg_temp.id('01') $$,    1),
    ('core.roles',           $$tenant_id = pg_temp.id('02') $$,    0),
    ('core.membership_roles',$$tenant_id = pg_temp.id('01') AND membership_id = pg_temp.id('41') $$, 1),
    ('core.membership_roles',$$tenant_id = pg_temp.id('02') $$,    0)) v(t, f, e);
DO $$ BEGIN PERFORM set_config('app.pre_user_id', '', true), set_config('app.pre_tenant_id', '', true), set_config('app.pre_tenant_code', '', true), set_config('app.maintenance', '', true); END $$;
SELECT is(pg_temp.as_x('lims_owner', '', format('SELECT 1 FROM %s', t), 'n'), 'n=0', 'GUCs empty: owner policy on ' || t || ' admits nothing')
  FROM unnest(ARRAY['core.memberships','core.users','core.tenants','core.roles','core.membership_roles']) t;
DO $$ BEGIN PERFORM set_config('app.maintenance', 'platform_list_tenants', true); END $$;
SELECT is(pg_temp.as_x('lims_owner', '', $$SELECT 1 FROM core.tenants WHERE id IN (pg_temp.id('01'), pg_temp.id('02'))$$, 'n'), 'n=2', 'tenants owner policy, platform_list_tenants branch: every tenant');
DO $$ BEGIN PERFORM set_config('app.maintenance', 'cron_tenant_ids', true); END $$;
SELECT is(pg_temp.as_x('lims_owner', '', $$SELECT 1 FROM core.tenants WHERE id IN (pg_temp.id('01'), pg_temp.id('02'))$$, 'n'), 'n=2', 'tenants owner policy, cron_tenant_ids branch: active + suspended tenants');
SET LOCAL session_replication_role = replica;
UPDATE core.tenants SET status = 'provisioning' WHERE id = pg_temp.id('02');
SET LOCAL session_replication_role = origin;
SELECT is(pg_temp.as_x('lims_owner', '', $$SELECT 1 FROM core.tenants WHERE id IN (pg_temp.id('01'), pg_temp.id('02'))$$, 'n'), 'n=1', 'cron_tenant_ids branch hides a provisioning tenant');
DO $$ BEGIN PERFORM set_config('app.maintenance', '', true), set_config('app.pre_tenant_code', 'lab_b', true); END $$;
SELECT is(pg_temp.as_x('lims_owner', '', $$SELECT 1 FROM core.tenants WHERE id IN (pg_temp.id('01'), pg_temp.id('02'))$$, 'n'), 'n=1', 'tenants owner policy, pre_tenant_code branch: exactly the tenant with that code (any status)');
DO $$ BEGIN PERFORM set_config('app.pre_tenant_code', '', true), set_config('app.maintenance', 'identity_tenants_for_email_hmacs', true); END $$;
SELECT is(pg_temp.as_x('lims_owner', '', $$SELECT 1 FROM core.users WHERE email_hmac IS NOT NULL$$, 'n'), 'n=2', 'users owner policy, e-mail HMAC maintenance branch admits only rows with email_hmac');
SELECT is(pg_temp.as_x('lims_owner', '', $$SELECT 1 FROM core.users WHERE email_hmac IS NULL$$, 'n'), 'n=0', '... and none without it');
SELECT is(pg_temp.as_x('lims_worker', '', $$SELECT 1 FROM core.users$$, 'n'), 'n=0', '... and lims_worker setting the same GUC sees 0 core.users rows (schema test 29)');
DO $$ BEGIN PERFORM set_config('app.maintenance', 'some_other_function', true); END $$;
SELECT is(pg_temp.as_x('lims_owner', '', format('SELECT 1 FROM %s', t), 'n'), 'n=0', 'another function''s maintenance name admits nothing on ' || t)
  FROM unnest(ARRAY['core.memberships','core.users','core.tenants','core.roles','core.membership_roles']) t;
DO $$ BEGIN PERFORM set_config('app.maintenance', '', true); END $$;

SELECT * FROM finish();
ROLLBACK;
