-- T0B-10.C2 policy-behaviour suite: tenant isolation, platform rows, __platform predicate, __own, actor guard (C2 05-SCHEMA §5, §11 tests 1-4, 26, 27; AC-0B-2.2, 3.1-3.5, 3.7).
-- The generated per-table probes (db/tests/isolation/identity.<t>.test.sql) are the AC-0B-3.x proof for every table; this file proves the identity-specific rules the
-- generator cannot know. Synthetic data only; one rolled-back transaction; RLS never disabled (fixtures are inserted by the superuser with system-actor claims).
-- Run from the repo root: pg_prove -d <db> db/tests/identity/T0B-10.C2_policies.test.sql   (pgTAP in schema `extensions`; seeds loaded; superuser)
-- Coverage map (C2 05-SCHEMA §11):
-- §11 test 1: tenant isolation (explicit cases; generated probes cover every table)
-- §11 test 2: platform rows invisible, D-216 Annex 1 exception
-- §11 test 3: __platform policies false for aal1 / inactive / wrong scope
-- §11 test 4: __own session policy
-- §11 test 26: staff-actor guard (partner / patient / portal claims)
-- §11 test 27: NULL-tenant rows are not audited
-- §11 test 32: pre-auth writes (identity system actor)
-- §11 test 34: platform claims after login (tail)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c200-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.h32(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '\x' || encode(sha256(convert_to(s, 'UTF8')), 'hex') $$;
CREATE TEMP SEQUENCE sq;
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
CREATE FUNCTION pg_temp.sess(p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE n int := nextval('sq');
BEGIN
  RETURN jsonb_build_object('id', pg_temp.uid(1000 + n), 'tenant_id', pg_temp.ta(), 'kind', 'tenant_staff', 'user_id', '01a1a98a-ac40-7000-8000-00000000a300',
    'membership_id', '01a1a98a-ac40-7000-8000-00000000a500', 'gotrue_session_id', pg_temp.uid(2000 + n), 'token_sha256', pg_temp.h32('tok' || n),
    'state', 'active', 'aal', 'aal1', 'refresh_token_enc', '\x01', 'access_token_enc', '\x01', 'enc_key_id', 'k1',
    'access_expires_at', now() + interval '1 hour', 'idle_timeout_minutes', 30, 'idle_expires_at', now() + interval '30 minutes',
    'absolute_expires_at', now() + interval '11 hours', 'expires_at', now() + interval '12 hours', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()) || p_over;
END $f$;

-- ===================================================================================================================================== fixtures
CREATE TEMP TABLE partner_m AS SELECT id, user_id FROM core.memberships WHERE tenant_id = pg_temp.ta() AND actor_type = 'partner' ORDER BY id LIMIT 1;
CREATE TEMP TABLE patient_m AS SELECT id, user_id FROM core.memberships WHERE tenant_id = pg_temp.ta() AND actor_type = 'patient' ORDER BY id LIMIT 1;
SELECT is((SELECT count(*)::int FROM partner_m), 1, 'fixture: seeded partner membership (tenant A)');
SELECT is((SELECT count(*)::int FROM patient_m), 1, 'fixture: seeded patient membership (tenant A)');
SELECT pg_temp.sysc(pg_temp.ta());
SELECT pg_temp.ins('identity.platform_staff', jsonb_build_object('id', pg_temp.uid(1), 'user_id', pg_temp.uid(101), 'email_normalized', 'platform.admin@synthetic.example', 'display_name', 'Synthetic Platform Admin',
  'role_code', 'platform_superadmin', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.tenant_settings', jsonb_build_object('tenant_id', pg_temp.ta(), 'legal_name_snapshot', 'Synthetic Lab Alpha', 'display_name', 'Synthetic Lab Alpha', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
-- platform Annex 1 rows: P1 referenced by tenant A settings, P2 unreferenced (D-216)
SELECT pg_temp.ins('identity.ird_annex_records', jsonb_build_object('id', pg_temp.uid(4001), 'tenant_id', NULL, 'annex_code', 'annex_1', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.ird_annex_records', jsonb_build_object('id', pg_temp.uid(4002), 'tenant_id', NULL, 'annex_code', 'annex_1', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.ird_annex_records', jsonb_build_object('id', pg_temp.uid(4003), 'tenant_id', pg_temp.ta(), 'annex_code', 'annex_2', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
UPDATE identity.tenant_settings SET ird_annex_1_record_id = pg_temp.uid(4001) WHERE tenant_id = pg_temp.ta();
SELECT pg_temp.sysc(pg_temp.tb());
SELECT pg_temp.ins('identity.tenant_settings', jsonb_build_object('tenant_id', pg_temp.tb(), 'legal_name_snapshot', 'Synthetic Lab Beta', 'display_name', 'Synthetic Lab Beta', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.ird_annex_records', jsonb_build_object('id', pg_temp.uid(4004), 'tenant_id', pg_temp.tb(), 'annex_code', 'annex_2', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.sessions', pg_temp.sess(jsonb_build_object('id', pg_temp.uid(11), 'tenant_id', pg_temp.tb(), 'user_id', '01a1a98a-ac40-7000-8000-00000000b300', 'membership_id', '01a1a98a-ac40-7000-8000-00000000b500')));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(21), 'tenant_id', pg_temp.tb(), 'event_type', 'login_succeeded', 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.mfa_factors', jsonb_build_object('id', pg_temp.uid(31), 'tenant_id', pg_temp.tb(), 'user_id', '01a1a98a-ac40-7000-8000-00000000b300', 'gotrue_factor_id', pg_temp.uid(131), 'status', 'verified', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.sysc(pg_temp.ta());
-- tenant A: two staff sessions (same user a300 and another user a301), one partner session, platform session
SELECT pg_temp.ins('identity.sessions', pg_temp.sess(jsonb_build_object('id', pg_temp.uid(12))));
SELECT pg_temp.ins('identity.sessions', pg_temp.sess(jsonb_build_object('id', pg_temp.uid(13))));
SELECT pg_temp.ins('identity.sessions', pg_temp.sess(jsonb_build_object('id', pg_temp.uid(14), 'user_id', '01a1a98a-ac40-7000-8000-00000000a301', 'membership_id', '01a1a98a-ac40-7000-8000-00000000a501')));
SELECT pg_temp.ins('identity.sessions', pg_temp.sess(jsonb_build_object('id', pg_temp.uid(15), 'kind', 'partner', 'user_id', (SELECT user_id FROM partner_m), 'membership_id', (SELECT id FROM partner_m))));
SELECT pg_temp.ins('identity.sessions', pg_temp.sess(jsonb_build_object('id', pg_temp.uid(16), 'kind', 'partner', 'user_id', (SELECT user_id FROM partner_m), 'membership_id', (SELECT id FROM partner_m))));
SELECT pg_temp.ins('identity.sessions', pg_temp.sess(jsonb_build_object('id', pg_temp.uid(17), 'kind', 'platform', 'tenant_id', NULL, 'membership_id', NULL, 'user_id', pg_temp.uid(101), 'platform_staff_id', pg_temp.uid(1))));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(22), 'tenant_id', pg_temp.ta(), 'event_type', 'login_succeeded', 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.mfa_factors', jsonb_build_object('id', pg_temp.uid(32), 'tenant_id', pg_temp.ta(), 'user_id', '01a1a98a-ac40-7000-8000-00000000a300', 'gotrue_factor_id', pg_temp.uid(132), 'status', 'verified', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.mfa_factors', jsonb_build_object('id', pg_temp.uid(33), 'tenant_id', pg_temp.ta(), 'user_id', (SELECT user_id FROM partner_m), 'gotrue_factor_id', pg_temp.uid(133), 'status', 'verified', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.mfa_factors', jsonb_build_object('id', pg_temp.uid(34), 'tenant_id', pg_temp.ta(), 'user_id', '01a1a98a-ac40-7000-8000-00000000a301', 'gotrue_factor_id', pg_temp.uid(134), 'status', 'verified', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.mfa_factors', jsonb_build_object('id', pg_temp.uid(35), 'tenant_id', NULL, 'user_id', pg_temp.uid(101), 'gotrue_factor_id', pg_temp.uid(135), 'status', 'verified', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.invitations', jsonb_build_object('id', pg_temp.uid(41), 'tenant_id', NULL, 'user_id', pg_temp.uid(102), 'platform_staff_id', pg_temp.uid(1), 'email', 'new.platform@synthetic.example',
  'status', 'sent', 'expires_at', now() + interval '3 days', 'invited_by', pg_temp.sys(), 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.invitations', jsonb_build_object('id', pg_temp.uid(42), 'tenant_id', pg_temp.ta(), 'user_id', '01a1a98a-ac40-7000-8000-00000000a301', 'membership_id', '01a1a98a-ac40-7000-8000-00000000a501',
  'email', 'staff@synthetic.example', 'status', 'sent', 'expires_at', now() + interval '3 days', 'invited_by', pg_temp.sys(), 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(23), 'tenant_id', NULL, 'event_type', 'login_failed', 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.platform_events', jsonb_build_object('id', pg_temp.uid(51), 'event_type', 'platform_staff_invited', 'target_type', 'invitation', 'created_by', pg_temp.sys()));

-- ===================================================================================================================================== §11 test 1: tenant isolation on the identity-specific shapes
-- §11 test 1 (the per-table generated probes cover all 16; these add the explicit sessions/settings/events cases)
\set CA '''{"actor_type":"user","tenant_id":"01a1a98a-ac40-7000-8000-00000000a001","sub":"01a1a98a-ac40-7000-8000-00000000a300","membership_id":"01a1a98a-ac40-7000-8000-00000000a500"}'''
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'), 'SELECT 1 FROM identity.' || t || ' WHERE tenant_id = ''' || pg_temp.tb() || ''''),
  'n=0', 'tenant A claims see zero tenant B rows of identity.' || t)
  FROM unnest(ARRAY['sessions', 'mfa_factors', 'auth_events', 'invitations', 'tenant_settings', 'feature_flags', 'branding_assets', 'support_sessions', 'ird_annex_records',
    'ird_annex_events', 'ird_annex_documents', 'audit_exports', 'access_reviews', 'admin_notices']) t;
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'), 'SELECT 1 FROM identity.sessions WHERE tenant_id = ''' || pg_temp.ta() || ''''),
  'n=5', 'tenant A staff sees its own 5 non-platform sessions (3 staff + 2 partner)');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'),
  format($$INSERT INTO identity.sessions (id, tenant_id, kind, user_id, membership_id, gotrue_session_id, token_sha256, state, refresh_token_enc, access_token_enc, enc_key_id, access_expires_at,
    idle_timeout_minutes, idle_expires_at, absolute_expires_at, expires_at, created_by, updated_by)
    VALUES (%L, %L, 'tenant_staff', %L, %L, %L, %L::bytea, 'active', '\x01', '\x01', 'k', now(), 30, now(), now(), now(), %L, %L)$$,
    pg_temp.uid(61), pg_temp.tb(), '01a1a98a-ac40-7000-8000-00000000b300', '01a1a98a-ac40-7000-8000-00000000b500', pg_temp.uid(62), pg_temp.h32('x61'), pg_temp.sys(), pg_temp.sys()), 'w'),
  'E42501', 'INSERT of a tenant B session by tenant A claims fails the policy');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'),
  format($$UPDATE identity.sessions SET version = version + 1 WHERE tenant_id = %L$$, pg_temp.tb()), 'w'), 'n=0', 'UPDATE of tenant B sessions affects 0 rows');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'),
  format($$DELETE FROM identity.sessions WHERE tenant_id = %L$$, pg_temp.tb()), 'w'), 'E42501', 'DELETE is not granted (permission denied)');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'),
  format($$UPDATE identity.tenant_settings SET display_name = 'hijack' WHERE tenant_id = %L$$, pg_temp.tb()), 'w'), 'n=0', 'tenant A cannot update tenant B settings');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'),
  format($$UPDATE identity.tenant_settings SET tenant_id = %L WHERE tenant_id = %L$$, pg_temp.tb(), pg_temp.ta()), 'w'), 'E42501', 'moving a settings row to tenant B violates WITH CHECK');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'),
  format($$UPDATE identity.auth_events SET reason_code = 'x' WHERE tenant_id = %L$$, pg_temp.ta()), 'w'), 'E42501', 'auth_events is append-only: UPDATE denied');
-- no claims at all: nothing is visible and nothing can be written
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM identity.' || t), 'n=0', 'no claims: identity.' || t || ' returns 0 rows')
  FROM unnest(ARRAY['sessions', 'mfa_factors', 'auth_events', 'invitations', 'tenant_settings', 'feature_flags', 'branding_assets', 'support_sessions', 'ird_annex_records',
    'ird_annex_events', 'ird_annex_documents', 'audit_exports', 'access_reviews', 'platform_staff', 'platform_events', 'admin_notices']) t;

-- ===================================================================================================================================== §11 test 2: platform rows invisible (D-216 exception)
-- §11 test 2
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'), 'SELECT 1 FROM identity.ird_annex_records WHERE tenant_id IS NULL'),
  'n=1', 'tenant A sees exactly one platform ird_annex_records row');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'),
  format($$SELECT 1 FROM identity.ird_annex_records WHERE id = %L$$, pg_temp.uid(4001))), 'n=1', 'the visible platform row is the one tenant_settings.ird_annex_1_record_id references');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'),
  format($$SELECT 1 FROM identity.ird_annex_records WHERE id = %L$$, pg_temp.uid(4002))), 'n=0', 'a second, unreferenced Annex 1 row stays invisible');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'), 'SELECT 1 FROM identity.' || q),
  'n=0', 'tenant A staff sees no platform row of ' || q)
  FROM unnest(ARRAY['invitations WHERE tenant_id IS NULL', 'mfa_factors WHERE tenant_id IS NULL', 'auth_events WHERE tenant_id IS NULL', 'sessions WHERE kind = ''platform''',
    'platform_staff', 'platform_events', 'tenant_settings WHERE tenant_id IS NULL']) q;
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner'), 'SELECT 1 FROM identity.ird_annex_records'), 'n=0', 'partner claims of A see no ird_annex_records (not even the referenced Annex 1)');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM patient_m), (SELECT id FROM patient_m), 'patient'), 'SELECT 1 FROM identity.ird_annex_records'), 'n=0', 'patient claims of A see no ird_annex_records');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), pg_temp.uid(900), NULL, 'portal'), 'SELECT 1 FROM identity.ird_annex_records'), 'n=0', 'portal claims of A see no ird_annex_records');

-- ===================================================================================================================================== §11 test 3: __platform predicate
-- §11 test 3: false for aal1, inactive staff, scope <> platform
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.tenant_settings'), 'n=2', 'platform aal2 active: tenant_settings of both tenants readable (__platform)');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.platform_staff'), 'n=1', 'platform aal2: platform_staff readable');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.sessions WHERE kind = ''platform'''), 'n=1', 'platform aal2: platform sessions readable');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.sessions WHERE kind <> ''platform'''), 'n=0', 'platform sessions policy covers kind = platform only (tenant sessions invisible)');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.auth_events'), 'n=3', 'platform aal2: auth_events of all tenants + tenant-less readable (PL-8)');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM core.tenants'), 'n=' || (SELECT count(*) FROM core.tenants), 'platform aal2: all core.tenants readable (tenants__select__platform)');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal1', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.' || t), 'n=0', 'platform aal1: identity.' || t || ' returns 0 rows')
  FROM unnest(ARRAY['tenant_settings', 'platform_staff', 'sessions', 'auth_events', 'mfa_factors', 'invitations', 'platform_events', 'ird_annex_records', 'support_sessions']) t;
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'tenant', pg_temp.uid(1)), 'SELECT 1 FROM identity.' || t), 'n=0', 'scope <> platform: identity.' || t || ' returns 0 rows')
  FROM unnest(ARRAY['tenant_settings', 'platform_staff', 'sessions', 'auth_events', 'mfa_factors', 'invitations', 'platform_events', 'ird_annex_records', 'support_sessions']) t;
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(77)), 'SELECT 1 FROM identity.' || t), 'n=0', 'unknown platform_staff_id: identity.' || t || ' returns 0 rows')
  FROM unnest(ARRAY['tenant_settings', 'platform_staff', 'sessions', 'platform_events']) t;
UPDATE identity.platform_staff SET is_active = false WHERE id = pg_temp.uid(1);
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.' || t), 'n=0', 'inactive platform staff: identity.' || t || ' returns 0 rows')
  FROM unnest(ARRAY['tenant_settings', 'platform_staff', 'sessions', 'platform_events']) t;
UPDATE identity.platform_staff SET is_active = true WHERE id = pg_temp.uid(1);
-- §11 test 34 (tail): after login, platform claims read tenant-less mfa_factors / invitations through __platform and tenant rows not at all
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.mfa_factors WHERE tenant_id IS NULL'), 'n=1', '-- §11 test 34 platform claims read the tenant-less mfa factor');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.mfa_factors WHERE tenant_id IS NOT NULL'), 'n=0', 'platform claims read no tenant mfa factor');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.invitations WHERE tenant_id IS NULL'), 'n=1', 'platform claims read the platform invitation');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), 'SELECT 1 FROM identity.invitations WHERE tenant_id IS NOT NULL'), 'n=0', 'platform claims read no tenant invitation');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), format($$UPDATE identity.invitations SET status = 'revoked' WHERE id = %L$$, pg_temp.uid(42)), 'w'), 'n=0', 'platform claims cannot update a tenant invitation');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), format($$UPDATE identity.invitations SET status = 'revoked' WHERE id = %L$$, pg_temp.uid(41)), 'w'), 'n=1', 'platform claims update the platform invitation');

-- ===================================================================================================================================== §11 test 4: __own session policy
-- §11 test 4: with lims_session_id claim only the caller's own session is readable through __own; a partner has __own_user for its own sessions only
-- (the guarded __tenant policy is not available to non-staff actors, so partner claims isolate the __own / __own_user paths)
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner') || jsonb_build_object('lims_session_id', pg_temp.uid(15)),
  'SELECT id FROM identity.sessions'), 'n=2', '-- §11 test 4 partner sees exactly its own two sessions (__own + __own_user), not the 3 staff sessions');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner') || jsonb_build_object('lims_session_id', pg_temp.uid(15)),
  format($$SELECT id FROM identity.sessions WHERE id = %L$$, pg_temp.uid(14))), 'n=0', 'partner cannot read another user''s session of the same tenant');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner') || jsonb_build_object('lims_session_id', pg_temp.uid(15)),
  format($$UPDATE identity.sessions SET version = version + 1 WHERE id = %L$$, pg_temp.uid(15)), 'w'), 'n=1', 'partner can update its own current session');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner') || jsonb_build_object('lims_session_id', pg_temp.uid(15)),
  format($$UPDATE identity.sessions SET version = version + 1 WHERE id = %L$$, pg_temp.uid(14)), 'w'), 'n=0', 'partner cannot update another member''s session (0 rows)');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner') || jsonb_build_object('lims_session_id', pg_temp.uid(15)),
  format($$UPDATE identity.sessions SET version = version + 1 WHERE id = %L$$, pg_temp.uid(16)), 'w'), 'n=1', 'partner can update its other own session through __own_user');
-- a staff user's current session does not expose another session of the same user via __own (staff reach them through the guarded __tenant policy by design)
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM patient_m), (SELECT id FROM patient_m), 'patient') || jsonb_build_object('lims_session_id', pg_temp.uid(14)), 'SELECT id FROM identity.sessions'),
  'n=0', 'patient claims naming someone else''s lims_session_id see nothing (user_id must match too)');

-- ===================================================================================================================================== §11 test 26: staff-actor guard
-- §11 test 26: partner / patient / portal claims of tenant A: every identity table returns 0 rows except the partner's own sessions and mfa_factors
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner'), 'SELECT 1 FROM identity.' || t),
  'n=0', '-- §11 test 26 partner claims: identity.' || t || ' returns 0 rows')
  FROM unnest(ARRAY['auth_events', 'invitations', 'tenant_settings', 'feature_flags', 'branding_assets', 'support_sessions', 'ird_annex_records', 'ird_annex_events', 'ird_annex_documents',
    'audit_exports', 'access_reviews', 'platform_staff', 'platform_events', 'admin_notices']) t;
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner') || jsonb_build_object('lims_session_id', pg_temp.uid(15)), 'SELECT 1 FROM identity.mfa_factors'),
  'n=1', 'partner sees its own mfa_factors row (mfa_factors__select__own) and no other');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner'), format($$UPDATE identity.mfa_factors SET friendly_name = 'mine' WHERE id = %L$$, pg_temp.uid(33)), 'w'),
  'n=1', 'partner updates its own factor');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner'), format($$UPDATE identity.mfa_factors SET friendly_name = 'theirs' WHERE id = %L$$, pg_temp.uid(34)), 'w'),
  'n=0', 'partner cannot update another member''s factor');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM patient_m), (SELECT id FROM patient_m), 'patient'), 'SELECT 1 FROM identity.' || t),
  'n=0', 'patient claims: identity.' || t || ' returns 0 rows')
  FROM unnest(ARRAY['sessions', 'mfa_factors', 'auth_events', 'invitations', 'tenant_settings', 'feature_flags', 'branding_assets', 'support_sessions', 'ird_annex_records', 'audit_exports', 'access_reviews', 'admin_notices']) t;
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), pg_temp.uid(900), NULL, 'portal'), 'SELECT 1 FROM identity.' || t),
  'n=0', 'portal claims: identity.' || t || ' returns 0 rows')
  FROM unnest(ARRAY['sessions', 'mfa_factors', 'auth_events', 'invitations', 'tenant_settings', 'feature_flags', 'branding_assets', 'support_sessions', 'ird_annex_records', 'audit_exports', 'access_reviews', 'admin_notices']) t;
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), (SELECT user_id FROM partner_m), (SELECT id FROM partner_m), 'partner'),
  format($$INSERT INTO identity.access_reviews (id, tenant_id, reviewed_by_membership_id, memberships_reviewed, created_by) VALUES (%L, %L, %L, 1, %L)$$, pg_temp.uid(71), pg_temp.ta(), (SELECT id FROM partner_m), pg_temp.sys()), 'w'),
  'E42501', 'partner cannot insert an access review (guard in WITH CHECK)');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'),
  format($$INSERT INTO identity.access_reviews (id, tenant_id, reviewed_by_membership_id, memberships_reviewed, created_by) VALUES (%L, %L, %L, 1, %L)$$, pg_temp.uid(72), pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a500', pg_temp.sys()), 'w'),
  'n=1', 'staff of tenant A inserts an access review (control for the previous test)');
-- tables.yaml marks only sessions and mfa_factors shared_with partner (static twin in the node test)

-- §11 test 23 (policy half): core.dead_letters __platform policies exclude NULL-tenant rows (08 A10.4; behaviour proven in T0B-05/T0B-08 suites)
SELECT matches(qual, 'tenant_id IS NOT NULL', 'core.dead_letters ' || policyname || ' USING excludes NULL-tenant rows') FROM pg_policies WHERE schemaname = 'core' AND tablename = 'dead_letters' AND policyname ~ '__platform$';
SELECT is(count(*)::int, 2, 'core.dead_letters has exactly the select + update __platform policies') FROM pg_policies WHERE schemaname = 'core' AND tablename = 'dead_letters' AND policyname ~ '__platform$';

-- ===================================================================================================================================== §11 test 27: NULL-tenant rows of mixed tables are not audited (D-215)
-- §11 test 27
CREATE TEMP TABLE audit_before AS SELECT count(*)::int AS n FROM audit.audit_log;
SELECT pg_temp.sysc(pg_temp.ta());
SELECT pg_temp.ins('identity.invitations', jsonb_build_object('id', pg_temp.uid(43), 'tenant_id', NULL, 'user_id', pg_temp.uid(103), 'platform_staff_id', pg_temp.uid(1), 'email', 'second.platform@synthetic.example',
  'status', 'sent', 'expires_at', now() + interval '3 days', 'invited_by', pg_temp.sys(), 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
UPDATE identity.invitations SET status = 'revoked' WHERE id = pg_temp.uid(43);
SELECT pg_temp.ins('identity.mfa_factors', jsonb_build_object('id', pg_temp.uid(36), 'tenant_id', NULL, 'user_id', pg_temp.uid(103), 'gotrue_factor_id', pg_temp.uid(136), 'status', 'unverified', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
UPDATE identity.mfa_factors SET status = 'verified', verified_at = now() WHERE id = pg_temp.uid(36);
SELECT pg_temp.ins('identity.ird_annex_records', jsonb_build_object('id', pg_temp.uid(4005), 'tenant_id', NULL, 'annex_code', 'annex_1', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
UPDATE identity.ird_annex_records SET status = 'in_preparation' WHERE id = pg_temp.uid(4005);
SELECT is((SELECT count(*)::int FROM audit.audit_log) - (SELECT n FROM audit_before), 0, '§11 test 27: NULL-tenant invitation / mfa_factor / annex_1 inserts + updates write 0 audit_log rows and do not raise');
SELECT pg_temp.ins('identity.invitations', jsonb_build_object('id', pg_temp.uid(44), 'tenant_id', pg_temp.ta(), 'user_id', '01a1a98a-ac40-7000-8000-00000000a302', 'membership_id', '01a1a98a-ac40-7000-8000-00000000a502',
  'email', 'tenant.staff@synthetic.example', 'status', 'sent', 'expires_at', now() + interval '3 days', 'invited_by', pg_temp.sys(), 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT is((SELECT count(*)::int FROM audit.audit_log) - (SELECT n FROM audit_before), 1, 'a tenant invitation row still writes its audit_log row');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'identity.platform_events'::regclass AND conname = 'platform_events__type__ck'
   AND pg_get_constraintdef(oid) ~ 'platform_mfa_enrolled' AND pg_get_constraintdef(oid) ~ 'ird_document_downloaded'), 1, 'platform_events__type__ck lists platform_mfa_enrolled and ird_document_downloaded');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat('aal2', 'platform', pg_temp.uid(1)), format($$INSERT INTO identity.platform_events (id, event_type, target_type, created_by) VALUES (%L, 'platform_mfa_enrolled', 'mfa_factor', %L)$$, pg_temp.uid(52), pg_temp.sys()), 'w'),
  'n=1', 'platform claims insert a platform_events row (platform_events__insert__platform)');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500'),
  format($$INSERT INTO identity.platform_events (id, event_type, target_type, created_by) VALUES (%L, 'platform_mfa_enrolled', 'mfa_factor', %L)$$, pg_temp.uid(53), pg_temp.sys()), 'w'),
  'E42501', 'tenant claims cannot insert platform_events');

-- ===================================================================================================================================== §11 test 32: pre-auth writes (D-212)
-- §11 test 32: identity-system-actor claims without tenant_id: sessions / mfa_factors / invitations writes are refused; with tenant_id = A they admit tenant-A rows only
SELECT is(pg_temp.x('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'),
  format($$INSERT INTO identity.sessions (id, tenant_id, kind, user_id, membership_id, gotrue_session_id, token_sha256, state, refresh_token_enc, access_token_enc, enc_key_id, access_expires_at,
    idle_timeout_minutes, idle_expires_at, absolute_expires_at, expires_at, created_by, updated_by)
    VALUES (%L, %L, 'tenant_staff', %L, %L, %L, %L::bytea, 'active', '\x01', '\x01', 'k', now(), 30, now(), now(), now(), %L, %L)$$,
    pg_temp.uid(81), pg_temp.ta(), '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a500', pg_temp.uid(82), pg_temp.h32('x81'), pg_temp.sys(), pg_temp.sys()), 'w'),
  'E42501', '-- §11 test 32 identity system actor without tenant_id cannot INSERT a session');
SELECT is(pg_temp.x('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$UPDATE identity.sessions SET version = version + 1 WHERE id = %L$$, pg_temp.uid(12)), 'w'),
  'n=0', 'identity system actor without tenant_id updates 0 session rows');
SELECT is(pg_temp.x('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$UPDATE identity.invitations SET status = 'revoked' WHERE id = %L$$, pg_temp.uid(42)), 'w'),
  'n=0', 'identity system actor without tenant_id updates 0 invitation rows');
SELECT is(pg_temp.x('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), 'SELECT 1 FROM identity.mfa_factors'), 'n=0', 'identity system actor without tenant_id sees no mfa factor');
SELECT is(pg_temp.x('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system', 'tenant_id', pg_temp.ta()), format($$UPDATE identity.invitations SET status = 'revoked' WHERE id = %L$$, pg_temp.uid(42)), 'w'),
  'n=1', 'after bindTenant (tenant_id = A) invitations__update__tenant admits the tenant-A row');
SELECT is(pg_temp.x('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system', 'tenant_id', pg_temp.ta()), format($$UPDATE identity.sessions SET version = version + 1 WHERE tenant_id = %L$$, pg_temp.tb()), 'w'),
  'n=0', 'after bindTenant (A) tenant-B sessions are still out of reach');
SELECT is(pg_temp.x('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system', 'tenant_id', pg_temp.ta()), format($$INSERT INTO identity.auth_events (id, tenant_id, event_type, created_by) VALUES (%L, %L, 'login_succeeded', %L)$$, pg_temp.uid(24), pg_temp.ta(), pg_temp.sys()), 'w'),
  'n=1', 'after bindTenant (A) auth_events__insert__tenant admits a tenant-A event');
SELECT is(pg_temp.x('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system', 'tenant_id', pg_temp.ta()), format($$INSERT INTO identity.auth_events (id, tenant_id, event_type, created_by) VALUES (%L, %L, 'login_succeeded', %L)$$, pg_temp.uid(25), pg_temp.tb(), pg_temp.sys()), 'w'),
  'E42501', 'after bindTenant (A) a tenant-B auth event is refused');
SELECT is(pg_temp.x('lims_api', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), format($$INSERT INTO identity.auth_events (id, tenant_id, event_type, created_by) VALUES (%L, NULL, 'login_failed', %L)$$, pg_temp.uid(26), pg_temp.sys()), 'w'),
  'E42501', 'tenant-less auth events are inserted only through app.identity_record_auth_event, not directly');

SELECT * FROM finish();
ROLLBACK;
