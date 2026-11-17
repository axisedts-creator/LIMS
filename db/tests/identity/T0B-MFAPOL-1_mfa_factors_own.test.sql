-- T0B-MFAPOL-1 (LD-252; CR-C0-T0B-REVIEW-1-003 / LD-232 item 4; C2 05-SCHEMA s5.3, s5.4, s11 test 3; 08 A28.1, A15.2, LD-216, LD-221) live-DB assertions for
--   migration 20261116010000_identity__narrow_mfa_factors_own_policies.sql: mfa_factors__select__own / __insert__own / __update__own all use
--   user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id())      (the tenant-less IS NOT DISTINCT FROM branch is gone; nothing else changes).
-- (a) claims {sub = platform user, aal = aal1, scope = platform} see 0 tenant-less factor rows      (b) the same claims UPDATE the tenant-less factor: 0 rows
-- (c) the same claims INSERT a tenant-less factor: 42501                                              (d) a partner / tenant user still reads and inserts its own tenant row
-- (e) a platform user at aal2 still reads the tenant-less row through mfa_factors__select__platform.
-- Same helper shapes and fixtures as T0B-10.C2_policies.test.sql (seeded tenants A/B, seeded partner membership; RLS never disabled; synthetic data only; one rolled-back transaction).
-- Run: pg_prove -d <migrated db WITH the new migration> db/tests/identity/T0B-MFAPOL-1_mfa_factors_own.test.sql   (superuser; pgTAP in schema `extensions`; seeds loaded; from the repo root)
-- NOT RUN in the lane (no psql / docker): neither this file nor the migration has been run by its author; before the migration the (a), (b), (c) assertions FAIL, as they must.
-- FOUNDER STEP: run db/tests/run-suites.sh (T0B-10.C2_policies tests 63 and 72 and the AUTH-MFA-COMPLETE-1 suite must pass) BEFORE push-cloud.ps1 applies the migration.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c200-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.sysc(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', p_tenant, 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true) $$;
CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE cols text := (SELECT string_agg(quote_ident(k), ',') FROM jsonb_object_keys(p_row) k);
BEGIN EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, p_row::text); END $f$;
-- run p_sql as p_role with p_claims; mode n = count of a query, w = ROW_COUNT of a statement; errors -> 'E' || SQLSTATE
CREATE FUNCTION pg_temp.x(p_role text, p_claims jsonb, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; END IF;
    r := 'n=' || n;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.cstaff(p_tenant uuid, p_sub uuid, p_mem uuid, p_type text DEFAULT 'user') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', p_sub, 'membership_id', p_mem) $$;
CREATE FUNCTION pg_temp.cplat(p_aal text, p_scope text, p_staff uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', 'user', 'scope', p_scope, 'aal', p_aal, 'platform_staff_id', p_staff, 'sub', pg_temp.uid(101)) $$;
-- INSERT text of one factor row: p_id fixture number (gotrue id = p_id + 100), p_tenant NULL = tenant-less, p_user = owner of the row, created_by/updated_by = that user
CREATE FUNCTION pg_temp.insf(p_id int, p_tenant uuid, p_user uuid) RETURNS text LANGUAGE sql AS $$
  SELECT format('INSERT INTO identity.mfa_factors (id, tenant_id, user_id, gotrue_factor_id, status, created_by, updated_by) VALUES (%L, %L, %L, %L, %L, %L, %L)',
    pg_temp.uid(p_id), p_tenant, p_user, pg_temp.uid(p_id + 100), 'unverified', p_user, p_user) $$;

-- ===================================================================================================================================== fixtures
CREATE TEMP TABLE partner_m AS SELECT id, user_id FROM core.memberships WHERE tenant_id = pg_temp.ta() AND actor_type = 'partner' ORDER BY id LIMIT 1;
SELECT is((SELECT count(*)::int FROM partner_m), 1, 'fixture: seeded partner membership (tenant A)');
SELECT pg_temp.sysc(pg_temp.ta());
SELECT pg_temp.ins('identity.platform_staff', jsonb_build_object('id', pg_temp.uid(1), 'user_id', pg_temp.uid(101), 'email_normalized', 'platform.admin@synthetic.example', 'display_name', 'Synthetic Platform Admin',
  'role_code', 'platform_superadmin', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
-- the platform user's tenant-less factor (tenant_id NULL, user_id = the claims sub), a tenant staff factor and the partner's factor
SELECT pg_temp.ins('identity.mfa_factors', jsonb_build_object('id', pg_temp.uid(35), 'tenant_id', NULL, 'user_id', pg_temp.uid(101), 'gotrue_factor_id', pg_temp.uid(135), 'status', 'verified', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.mfa_factors', jsonb_build_object('id', pg_temp.uid(32), 'tenant_id', pg_temp.ta(), 'user_id', '01a1a98a-ac40-7000-8000-00000000a300', 'gotrue_factor_id', pg_temp.uid(132), 'status', 'verified', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.mfa_factors', jsonb_build_object('id', pg_temp.uid(33), 'tenant_id', pg_temp.ta(), 'user_id', (SELECT user_id FROM partner_m), 'gotrue_factor_id', pg_temp.uid(133), 'status', 'verified', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));

-- ===================================================================================================================================== catalog: the three policies are exactly narrowed
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'mfa_factors' AND policyname IN ('mfa_factors__select__own', 'mfa_factors__insert__own', 'mfa_factors__update__own')), 3,
  'catalog: the three mfa_factors __own policies exist (none dropped, none renamed)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'mfa_factors' AND policyname LIKE 'mfa\_factors\_\_%\_\_own'
    AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~* 'distinct'), 0, 'catalog: no __own policy keeps the IS NOT DISTINCT FROM tenant branch');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'mfa_factors' AND policyname LIKE 'mfa\_factors\_\_%\_\_own' AND roles = '{lims_app}'), 3,
  'catalog: the __own policies stay TO lims_app');

-- ===================================================================================================================================== (a) platform user at aal1 sees no tenant-less factor row
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal1', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.mfa_factors WHERE tenant_id IS NULL'), 'n=0',
  '(a) platform claims at aal1 (sub = platform user) read 0 tenant-less factor rows (C2_policies test 63 shape)');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal1', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.mfa_factors'), 'n=0', '(a) platform claims at aal1 read no mfa_factors row at all');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'tenant', pg_temp.uid(1)), 'SELECT 1 FROM identity.mfa_factors'), 'n=0', '(a) scope <> platform: 0 rows (C2_policies test 72 shape)');
-- NULL = NULL is gone: a tenant-bound claim whose sub is the platform user does not match the tenant-less row either
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), pg_temp.uid(101), '01a1a98a-ac40-7000-8000-00000000a500'), 'SELECT 1 FROM identity.mfa_factors WHERE tenant_id IS NULL'), 'n=0',
  '(a) claims with a tenant and sub = platform user read 0 tenant-less rows');
-- claims with no tenant and no platform scope at all (bare sub)
SELECT is(pg_temp.x('lims_app', jsonb_build_object('actor_type', 'user', 'sub', pg_temp.uid(101)), 'SELECT 1 FROM identity.mfa_factors'), 'n=0', '(a) claims carrying only sub = platform user read 0 rows');

-- ===================================================================================================================================== (b) the same claims cannot UPDATE the tenant-less factor
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal1', 'platform', pg_temp.uid(1)), format($$UPDATE identity.mfa_factors SET friendly_name = 'hijack' WHERE id = %L$$, pg_temp.uid(35)), 'w'), 'n=0',
  '(b) platform claims at aal1 UPDATE of the tenant-less factor changes 0 rows');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal1', 'platform', pg_temp.uid(1)), format($$UPDATE identity.mfa_factors SET status = 'removed' WHERE user_id = %L$$, pg_temp.uid(101)), 'w'), 'n=0',
  '(b) platform claims at aal1 cannot change the factor status by user_id either');
SELECT is((SELECT friendly_name FROM identity.mfa_factors WHERE id = pg_temp.uid(35)), NULL::text, '(b) the tenant-less factor row is unchanged');
SELECT is((SELECT status FROM identity.mfa_factors WHERE id = pg_temp.uid(35)), 'verified', '(b) the tenant-less factor status is unchanged');

-- ===================================================================================================================================== (c) the same claims cannot INSERT a tenant-less factor
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal1', 'platform', pg_temp.uid(1)), pg_temp.insf(36, NULL, pg_temp.uid(101)), 'w'), 'E42501',
  '(c) platform claims at aal1 INSERT of a tenant-less factor raises 42501');
SELECT is((SELECT count(*)::int FROM identity.mfa_factors WHERE id = pg_temp.uid(36)), 0, '(c) no tenant-less factor row was inserted');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'tenant', pg_temp.uid(1)), pg_temp.insf(36, NULL, pg_temp.uid(101)), 'w'), 'E42501', '(c) scope <> platform: INSERT of a tenant-less factor raises 42501');

-- ===================================================================================================================================== (d) tenant / partner users keep their own tenant rows
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'), $$SELECT 1 FROM identity.mfa_factors WHERE user_id = '01a1a98a-ac40-7000-8000-00000000a300'$$), 'n=1',
  '(d) tenant staff user reads its own tenant factor');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner'), 'SELECT 1 FROM identity.mfa_factors'), 'n=1',
  '(d) partner reads its own tenant factor (and no other)');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner'), format($$UPDATE identity.mfa_factors SET friendly_name = 'mine' WHERE id = %L$$, pg_temp.uid(33)), 'w'),
  'n=1', '(d) partner updates its own tenant factor');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'), pg_temp.insf(37, pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300'), 'w'),
  'n=1', '(d) tenant staff user inserts its own tenant factor');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner'), pg_temp.insf(38, pg_temp.ta(), (SELECT user_id FROM partner_m)), 'w'),
  'n=1', '(d) partner inserts its own tenant factor');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner'), pg_temp.insf(39, pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300'), 'w'),
  'E42501', '(d) partner cannot insert a factor for another user (user_id still bound)');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner'), pg_temp.insf(40, NULL, (SELECT user_id FROM partner_m)), 'w'),
  'E42501', '(d) a tenant-bound partner cannot insert a tenant-less factor either');

-- ===================================================================================================================================== (e) platform at aal2 still reads the tenant-less row through __platform
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.mfa_factors WHERE tenant_id IS NULL'), 'n=1',
  '(e) platform claims at aal2 read the tenant-less factor (mfa_factors__select__platform)');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.mfa_factors WHERE tenant_id IS NOT NULL'), 'n=0', '(e) platform claims read no tenant factor');

SELECT * FROM finish();
ROLLBACK;
