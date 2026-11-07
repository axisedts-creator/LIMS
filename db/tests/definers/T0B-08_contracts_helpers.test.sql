-- T0B-08 DEFINER contract tests, helpers stage (AC-0B-2.4; 05-SCHEMA §4.3 owner-policy rule; §10 schema test 13, 21):
--   app.has_all_centres, app.current_centre_ids, app.is_platform_actor, app.tg_row_audit, and the module-policy helpers
--   app.current_partner_id, app.engagement_account_id, app.engagement_patient_ids, app.engagement_patient_visible.
-- Each test first asserts relforcerowsecurity = true on every touched table (from pg_class), then non-empty results where the fixture expects rows.
-- Helpers that read tables of later chunks (partners.*, engagement.*) are asserted only when those tables exist; otherwise an explicit skip() is reported.
-- Run from the repo root: pg_prove -d <db> db/tests/definers/T0B-08_contracts_helpers.test.sql   (superuser; pgTAP in schema `extensions`)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\ir ../fixtures/T0B-06_identity_standin.sql

CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-0000000000' || lpad(k, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.x(p_role text, p_claims text, p_sql text, p_mode text DEFAULT 'v') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSIF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := 'n=' || n;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := 'n=' || n; END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.cl(p_type text, p_tenant text, p_sub text, p_mem text) RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', pg_temp.id(p_tenant), 'sub', pg_temp.id(p_sub), 'membership_id', pg_temp.id(p_mem))::text $$;
CREATE FUNCTION pg_temp.chk(p_exists boolean, p_got text, p_want text, p_descr text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT p_exists THEN RETURN skip('object not present yet: ' || p_descr, 1); END IF;
  RETURN is(p_got, p_want, p_descr);
END $f$;

-- ---------- fixtures ----------
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id('01'), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.branches (id, tenant_id, branch_code, name, created_by, updated_by) VALUES (pg_temp.id('11'), pg_temp.id('01'), 'BA', 'Branch A', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.collection_centres (id, tenant_id, branch_id, centre_code, name, centre_kind, created_by, updated_by) VALUES
  (pg_temp.id('21'), pg_temp.id('01'), pg_temp.id('11'), 'CA1', 'Centre A1', 'own', pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('22'), pg_temp.id('01'), pg_temp.id('11'), 'CA2', 'Centre A2', 'own', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.users (tenant_id, id, display_name, created_by, updated_by) VALUES
  (pg_temp.id('01'), pg_temp.id('31'), 'User 31', pg_temp.id('99'), pg_temp.id('99')), (pg_temp.id('01'), pg_temp.id('32'), 'User 32', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, all_centres, created_by, updated_by) VALUES
  (pg_temp.id('41'), pg_temp.id('01'), pg_temp.id('31'), 'user', false, pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('42'), pg_temp.id('01'), pg_temp.id('32'), 'user', true,  pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.membership_centres (tenant_id, membership_id, centre_id, created_by) VALUES (pg_temp.id('01'), pg_temp.id('41'), pg_temp.id('21'), pg_temp.id('99'));
INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, is_active, created_by, updated_by) VALUES
  (pg_temp.id('61'), pg_temp.id('81'), 'a@example.test', 'Staff A', 'platform_admin', true,  pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('62'), pg_temp.id('82'), 'b@example.test', 'Staff B', 'platform_admin', false, pg_temp.id('99'), pg_temp.id('99'))
  ON CONFLICT DO NOTHING;
SET LOCAL session_replication_role = origin;

-- ---------- FORCE RLS on every table the helpers touch (asserted from pg_class at the start, AC-0B-2.4) ----------
SELECT is(relforcerowsecurity, true, 'AC-0B-2.4 ' || oid::regclass || ' has relforcerowsecurity = true before the contract tests run')
  FROM pg_class WHERE oid IN ('core.memberships'::regclass, 'core.membership_centres'::regclass, 'audit.audit_log'::regclass, 'identity.platform_staff'::regclass);

-- ---------- app.has_all_centres / app.current_centre_ids (touch core.memberships, core.membership_centres through the owner policies) ----------
SELECT is(pg_temp.x('lims_api', pg_temp.cl('user','01','31','41'), 'SELECT app.has_all_centres()'), 'false', 'has_all_centres: centre-scoped staff -> false (non-empty lookup under FORCE RLS)');
SELECT is(pg_temp.x('lims_api', pg_temp.cl('user','01','32','42'), 'SELECT app.has_all_centres()'), 'true',  'has_all_centres: all-centres staff -> true');
SELECT is(pg_temp.x('lims_api', pg_temp.cl('user','01','31','41'), 'SELECT app.current_centre_ids()'), '{' || pg_temp.id('21') || '}', 'current_centre_ids: centre-scoped staff -> exactly {A1}');
SELECT is(pg_temp.x('lims_api', pg_temp.cl('user','01','32','42'), 'SELECT cardinality(app.current_centre_ids())'), '0', 'current_centre_ids: all-centres staff has no explicit centre rows');
SELECT is(pg_temp.x('lims_worker', pg_temp.cl('user','01','31','41'), 'SELECT app.current_centre_ids()'), '{' || pg_temp.id('21') || '}', 'current_centre_ids works for lims_worker too');
-- a membership id of another tenant, and no claims, resolve to nothing (fail closed)
SELECT is(pg_temp.x('lims_api', pg_temp.cl('user','02','31','41'), 'SELECT app.has_all_centres()'), 'false', 'has_all_centres: membership of another tenant -> false');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT app.has_all_centres()'), 'false', 'has_all_centres: no claims -> false');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT cardinality(coalesce(app.current_centre_ids(), ARRAY[]::uuid[]))'), '0', 'current_centre_ids: no claims -> empty');
-- the lookup is not available to a plain session without the DEFINER: lims_app cannot read the membership rows directly with these claims' GUC absent
SELECT is(pg_temp.x('lims_api', pg_temp.cl('patient','01','31','41'), 'SELECT 1 FROM core.membership_centres', 'n'), 'n=0', 'non-staff claims read no membership_centres rows directly');

-- ---------- app.is_platform_actor (touches identity.platform_staff SELECT via platform_staff__select__owner_only; schema test 21) ----------
SELECT is(pg_temp.x('lims_api', jsonb_build_object('scope','platform','aal','aal2','platform_staff_id',pg_temp.id('61'),'sub',pg_temp.id('81'))::text, 'SELECT app.is_platform_actor()'),
  'true', 'schema test 13: is_platform_actor = true for platform claims of an active staff row (non-empty under FORCE RLS)');
SELECT is(pg_temp.x('lims_api', jsonb_build_object('scope','platform','aal','aal2','platform_staff_id',pg_temp.id('62'),'sub',pg_temp.id('82'))::text, 'SELECT app.is_platform_actor()'),
  'false', 'schema test 13: is_platform_actor = false for an inactive staff row');
SELECT is(pg_temp.x('lims_api', jsonb_build_object('scope','platform','aal','aal1','platform_staff_id',pg_temp.id('61'),'sub',pg_temp.id('81'))::text, 'SELECT app.is_platform_actor()'),
  'false', 'is_platform_actor = false at aal1');
SELECT is(pg_temp.x('lims_api', jsonb_build_object('scope','platform','aal','aal2','platform_staff_id',pg_temp.id('61'),'sub',pg_temp.id('99'))::text, 'SELECT app.is_platform_actor()'),
  'false', 'is_platform_actor = false when sub is not the staff row''s user');
SELECT is(pg_temp.x('lims_api', pg_temp.cl('user','01','31','41'), 'SELECT app.is_platform_actor()'), 'false', 'is_platform_actor = false for tenant claims');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT app.is_platform_actor()'), 'false', 'is_platform_actor = false with no claims');
-- lims_app cannot read platform_staff directly (policy is TO lims_owner only; 08 A10.5)
SELECT is(pg_temp.x('lims_api', jsonb_build_object('scope','platform','aal','aal2','platform_staff_id',pg_temp.id('61'),'sub',pg_temp.id('81'))::text,
                    'SELECT 1 FROM identity.platform_staff', 'n'), 'n=0', 'a platform session reads 0 identity.platform_staff rows directly (owner policy only)');

-- ---------- app.tg_row_audit (touches audit.audit_log INSERT via audit_log__insert__owner_only) ----------
SELECT is(pg_temp.x('lims_api', pg_temp.cl('user','01','32','42'), format($$UPDATE core.branches SET name = 'Branch A2' WHERE id = %L$$, pg_temp.id('11')), 'w'), 'n=1',
  'tg_row_audit: the audited UPDATE succeeds under FORCE RLS on audit.audit_log');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE table_name = 'branches' AND row_id = pg_temp.id('11') AND action = 'UPDATE' AND tenant_id = pg_temp.id('01')), 1,
  'tg_row_audit: exactly one audit_log row was written (non-empty owner INSERT policy path)');
SELECT is(pg_temp.x('lims_api', pg_temp.cl('user','01','32','42'),
  format($$INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, row_id, action, actor_type, created_by) VALUES (%L, %L, 'core', 'branches', %L, 'INSERT', 'user', %L)$$,
         pg_temp.id('88'), pg_temp.id('01'), pg_temp.id('11'), pg_temp.id('99')), 'w'), 'E42501:permission denied for table audit_log', 'lims_api cannot INSERT audit_log directly (no grant)');

-- ---------- module-policy helpers (read tables of C13 / C16; present only after those chunks' DDL) ----------
SELECT pg_temp.chk(to_regclass('partners.partner_users') IS NOT NULL AND to_regclass('partners.partners') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.cl('partner','01','31','41'), 'SELECT app.current_partner_id()'), '<null>',
  'current_partner_id (touches partners.partner_users, partners.partners; relforcerowsecurity) returns NULL for a partner claim with no partner_users row');
SELECT pg_temp.chk(to_regclass('engagement.accounts') IS NOT NULL, pg_temp.x('lims_api', pg_temp.cl('patient','01','31','41'), 'SELECT app.engagement_account_id()'), '<null>',
  'engagement_account_id (touches engagement.accounts, core.memberships; relforcerowsecurity) returns NULL for a patient claim with no account');
SELECT pg_temp.chk(to_regclass('engagement.account_patient_links') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.cl('patient','01','31','41'), 'SELECT cardinality(coalesce(app.engagement_patient_ids(), ARRAY[]::uuid[]))'), '0',
  'engagement_patient_ids (touches engagement.account_patient_links; relforcerowsecurity) returns no ids without links');
SELECT pg_temp.chk(to_regclass('engagement.account_patient_links') IS NOT NULL,
  pg_temp.x('lims_api', pg_temp.cl('patient','01','31','41'), format('SELECT app.engagement_patient_visible(%L, now())', pg_temp.id('55'))), 'false',
  'engagement_patient_visible (touches engagement.account_patient_links; relforcerowsecurity) is false without a link');

SELECT * FROM finish();
ROLLBACK;
