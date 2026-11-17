-- PLATFORM-DDL-1 (LD-223; C2 05-SCHEMA s5.3 platform policies, s5.2 tenant policies; CR C2.T16, C2.T22, C2.T22-detail; 08 A33-3, A17 P-16, AC-0B-2.3).
-- pgTAP, NOT runnable in the lane (needs docker + the pinned supabase/postgres image): `bash db/tests/run-suites.sh db/tests/identity/PLATFORM-DDL-1_policies.test.sql`.
-- Written BEFORE migrations 20261115191000_identity__add_platform_policies.sql and 20261115192000_identity__add_provisioning_schema.sql exist: every assertion below
-- about them fails today for the right reason (policy / column / table missing, or the row is refused with 42501 / returns n=0).
-- Sections: A catalog (19 platform policies, names + predicates + roles, existing policies untouched) | B behaviour per table and command (platform claims allowed,
-- tenant claims refused) | C training_mode (provisioning only) | D tenant_contract_acceptances (FORCE RLS, append-only, tenant + platform reads) | E provisioning inserts.
-- Synthetic data only; one rolled-back transaction; RLS never disabled (fixtures are inserted by the superuser with system-actor claims).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190d100-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.sysc(p_tenant uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', p_tenant, 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true) $$;
CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE cols text := (SELECT string_agg(quote_ident(k), ',') FROM jsonb_object_keys(p_row) k);
BEGIN EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, p_row::text); END $f$;
-- run p_sql as p_role with p_claims; mode n = count of a query, w = ROW_COUNT of a statement; errors come back as 'E' || SQLSTATE (E<SQLSTATE>:<message> in mode m)
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
CREATE FUNCTION pg_temp.cstaff(p_tenant uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', 'user', 'tenant_id', p_tenant, 'sub', '01a1a98a-ac40-7000-8000-00000000a300', 'membership_id', '01a1a98a-ac40-7000-8000-00000000a500') $$;
CREATE FUNCTION pg_temp.csys(p_tenant uuid) RETURNS jsonb LANGUAGE sql AS $$   -- withTenantScope(tenant): the identity module's system actor bound to the tenant
  SELECT jsonb_build_object('actor_type', 'system', 'tenant_id', p_tenant, 'sub', pg_temp.sys()) $$;
CREATE FUNCTION pg_temp.cplat() RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', 'user', 'scope', 'platform', 'aal', 'aal2', 'platform_staff_id', pg_temp.uid(1), 'sub', pg_temp.uid(101)) $$;

-- ===================================================================================================================================== A. catalog
-- C2 05-SCHEMA s5.3 rows the catalog lacked (migration 20261115191000): <table>__<command>__platform, TO lims_app, predicate (SELECT app.is_platform_actor()).
CREATE TEMP TABLE want(tbl text, cmd text, needs_check boolean);
INSERT INTO want VALUES
  ('platform_staff', 'SELECT', false), ('platform_staff', 'INSERT', true), ('platform_staff', 'UPDATE', true),
  ('platform_events', 'SELECT', false), ('platform_events', 'INSERT', true),
  ('auth_events', 'SELECT', false),
  ('feature_flags', 'SELECT', false), ('feature_flags', 'UPDATE', true),
  ('support_sessions', 'SELECT', false), ('support_sessions', 'INSERT', true), ('support_sessions', 'UPDATE', true),
  ('ird_annex_records', 'SELECT', false), ('ird_annex_records', 'INSERT', true), ('ird_annex_records', 'UPDATE', true),
  ('ird_annex_events', 'SELECT', false), ('ird_annex_events', 'INSERT', true),
  ('ird_annex_documents', 'SELECT', false), ('ird_annex_documents', 'INSERT', true), ('ird_annex_documents', 'UPDATE', true);
SELECT is((SELECT count(*)::int FROM want), 19, 'fixture: 19 s5.3 policies are required');
SELECT is((SELECT count(*)::int FROM pg_policies p JOIN want w ON p.schemaname = 'identity' AND p.tablename = w.tbl AND p.policyname = w.tbl || '__' || lower(w.cmd) || '__platform'), 19,
  'the catalog holds all 19 identity <table>__<command>__platform policies of s5.3');
SELECT is(p.cmd, w.cmd, 'identity.' || w.tbl || '__' || lower(w.cmd) || '__platform is FOR ' || w.cmd)
  FROM want w LEFT JOIN pg_policies p ON p.schemaname = 'identity' AND p.tablename = w.tbl AND p.policyname = w.tbl || '__' || lower(w.cmd) || '__platform';
SELECT is(p.roles::text, '{lims_app}', 'identity.' || w.tbl || '__' || lower(w.cmd) || '__platform is TO lims_app only')
  FROM want w LEFT JOIN pg_policies p ON p.schemaname = 'identity' AND p.tablename = w.tbl AND p.policyname = w.tbl || '__' || lower(w.cmd) || '__platform';
SELECT ok(coalesce(p.qual, p.with_check) ~ 'is_platform_actor', 'identity.' || w.tbl || '__' || lower(w.cmd) || '__platform predicate is app.is_platform_actor() (verbatim s5.3)')
  FROM want w LEFT JOIN pg_policies p ON p.schemaname = 'identity' AND p.tablename = w.tbl AND p.policyname = w.tbl || '__' || lower(w.cmd) || '__platform';
-- INSERT has WITH CHECK only, SELECT USING only, UPDATE both (predicate on both sides: no row can be moved out of the platform's reach)
SELECT ok(p.with_check ~ 'is_platform_actor', 'identity.' || w.tbl || '__' || lower(w.cmd) || '__platform has WITH CHECK (is_platform_actor)')
  FROM want w LEFT JOIN pg_policies p ON p.schemaname = 'identity' AND p.tablename = w.tbl AND p.policyname = w.tbl || '__' || lower(w.cmd) || '__platform' WHERE w.needs_check;
SELECT ok(p.qual ~ 'is_platform_actor', 'identity.' || w.tbl || '__update__platform has USING (is_platform_actor)')
  FROM want w LEFT JOIN pg_policies p ON p.schemaname = 'identity' AND p.tablename = w.tbl AND p.policyname = w.tbl || '__update__platform' WHERE w.cmd = 'UPDATE';
-- s5.3 gives auth_events no INSERT, ird_annex_events no UPDATE; nothing is added beyond the table (no DELETE anywhere)
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'auth_events' AND policyname = 'auth_events__insert__platform'), 0, 's5.3: no platform INSERT policy on auth_events');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'ird_annex_events' AND policyname = 'ird_annex_events__update__platform'), 0, 's5.3: ird_annex_events is INSERT-only');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'identity' AND policyname ~ '__delete__platform$'), 0, 'no identity __delete__platform policy exists');
-- already-present platform policies and the tenant / owner-only ones are not changed or duplicated (08 A17 P-16: one policy per table and command)
SELECT is((SELECT count(*)::int FROM (SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'identity' GROUP BY 1, 2 HAVING count(*) > 1) d), 0, 'no duplicate policy names in schema identity');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'identity' AND policyname IN (
  'tenant_settings__select__platform', 'tenant_settings__update__platform', 'sessions__select__platform', 'sessions__update__platform', 'mfa_factors__select__platform', 'mfa_factors__insert__platform',
  'mfa_factors__update__platform', 'invitations__select__platform', 'invitations__insert__platform', 'invitations__update__platform')), 10, 'the 10 pre-existing identity __platform policies are all still there');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'identity' AND policyname IN (
  'platform_staff__select__owner_only', 'platform_staff__insert__owner_only', 'platform_staff__update__owner_only', 'platform_events__insert__owner_only', 'auth_events__select__tenant',
  'support_sessions__select__tenant', 'support_sessions__update__tenant', 'ird_annex_records__select__tenant', 'ird_annex_records__select__tenant_platform_ref', 'feature_flags__update__tenant')), 10,
  'sample of pre-existing tenant / owner_only policies is untouched');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'identity' AND policyname ~ '^ird_annex_records__insert__' AND roles::text <> '{lims_app}'), 0, 'no tenant-role INSERT policy on ird_annex_records other than the platform one (s5.2: tenants never insert)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'ird_annex_records' AND cmd = 'INSERT' AND roles::text = '{lims_app}'), 1,
  'exactly one lims_app INSERT policy on ird_annex_records: the platform one (LD-223 option (3) preferred; the fallback tenant policy is not taken)');
-- a platform policy may not leak through lims_owner / PUBLIC and no new SECURITY DEFINER function came with the migrations
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'identity' AND policyname ~ '__platform$' AND roles::text <> '{lims_app}'), 0, 'every identity __platform policy is TO lims_app only');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.prosecdef AND p.proname ~ 'platform_ddl|contract_accept|provision'), 0, 'PLATFORM-DDL-1 adds no SECURITY DEFINER function');

-- ===================================================================================================================================== fixtures
SELECT pg_temp.sysc(pg_temp.ta());
SELECT pg_temp.ins('identity.platform_staff', jsonb_build_object('id', pg_temp.uid(1), 'user_id', pg_temp.uid(101), 'email_normalized', 'platform.admin@synthetic.example', 'display_name', 'Synthetic Platform Admin',
  'role_code', 'platform_superadmin', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.tenant_settings', jsonb_build_object('tenant_id', pg_temp.ta(), 'legal_name_snapshot', 'Synthetic Lab Alpha', 'display_name', 'Synthetic Lab Alpha', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.ird_annex_records', jsonb_build_object('id', pg_temp.uid(4003), 'tenant_id', pg_temp.ta(), 'annex_code', 'annex_2', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.ird_annex_events', jsonb_build_object('id', pg_temp.uid(4101), 'tenant_id', pg_temp.ta(), 'record_id', pg_temp.uid(4003), 'to_status', 'in_preparation', 'actor_id', pg_temp.sys(), 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.ird_annex_documents', jsonb_build_object('id', pg_temp.uid(4201), 'tenant_id', pg_temp.ta(), 'record_id', pg_temp.uid(4003), 'object_path', pg_temp.ta()::text || '/annex_2/a.pdf',
  'original_filename', 'a.pdf', 'content_type', 'application/pdf', 'size_bytes', 100, 'sha256', decode(repeat('ab', 32), 'hex'), 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(21), 'tenant_id', pg_temp.ta(), 'event_type', 'login_succeeded', 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.feature_flags', jsonb_build_object('tenant_id', pg_temp.ta(), 'flag_code', (SELECT code FROM identity.g_feature_flags WHERE NOT requires_founder_approval ORDER BY code LIMIT 1),
  'is_enabled', false, 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.support_sessions', jsonb_build_object('id', pg_temp.uid(61), 'tenant_id', pg_temp.ta(), 'platform_staff_id', pg_temp.uid(1), 'scope', 'read_only',
  'reason_text', 'synthetic fixture reason', 'ticket_ref', 'T-1', 'duration_minutes', 15, 'status', 'requested', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.platform_events', jsonb_build_object('id', pg_temp.uid(51), 'event_type', 'platform_staff_invited', 'target_type', 'invitation', 'created_by', pg_temp.sys()));
SELECT pg_temp.sysc(pg_temp.tb());
SELECT pg_temp.ins('identity.tenant_settings', jsonb_build_object('tenant_id', pg_temp.tb(), 'legal_name_snapshot', 'Synthetic Lab Beta', 'display_name', 'Synthetic Lab Beta', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(22), 'tenant_id', pg_temp.tb(), 'event_type', 'login_succeeded', 'created_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.feature_flags', jsonb_build_object('tenant_id', pg_temp.tb(), 'flag_code', (SELECT code FROM identity.g_feature_flags WHERE NOT requires_founder_approval ORDER BY code LIMIT 1),
  'is_enabled', false, 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.support_sessions', jsonb_build_object('id', pg_temp.uid(62), 'tenant_id', pg_temp.tb(), 'platform_staff_id', pg_temp.uid(1), 'scope', 'read_only',
  'reason_text', 'synthetic fixture reason', 'ticket_ref', 'T-2', 'duration_minutes', 15, 'status', 'requested', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.ird_annex_records', jsonb_build_object('id', pg_temp.uid(4004), 'tenant_id', pg_temp.tb(), 'annex_code', 'annex_2', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.auth_events', jsonb_build_object('id', pg_temp.uid(23), 'tenant_id', NULL, 'event_type', 'login_failed', 'created_by', pg_temp.sys()));

-- ===================================================================================================================================== B. behaviour: platform claims allowed, tenant claims refused (s5.3)
-- SELECT: platform claims read ALL tenants' rows (cross-tenant), tenant A claims read only A's
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), 'SELECT 1 FROM identity.platform_staff'), 'n=1', 'platform: platform_staff SELECT');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), 'SELECT 1 FROM identity.platform_staff'), 'n=0', 'tenant: platform_staff SELECT refused (0 rows)');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), 'SELECT 1 FROM identity.platform_events'), 'n=1', 'platform: platform_events SELECT');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), 'SELECT 1 FROM identity.platform_events'), 'n=0', 'tenant: platform_events SELECT refused');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format('SELECT 1 FROM identity.auth_events WHERE id IN (%L, %L, %L)', pg_temp.uid(21), pg_temp.uid(22), pg_temp.uid(23))), 'n=3', 'platform: auth_events SELECT all rows (tenant A, tenant B, tenant-less; PL-8)');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), format('SELECT 1 FROM identity.auth_events WHERE id IN (%L, %L, %L)', pg_temp.uid(21), pg_temp.uid(22), pg_temp.uid(23))), 'n=1', 'tenant A: auth_events sees only its own row');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), 'SELECT 1 FROM identity.feature_flags'), 'n=2', 'platform: feature_flags SELECT both tenants');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), 'SELECT 1 FROM identity.feature_flags'), 'n=1', 'tenant A: feature_flags sees only its own');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), 'SELECT 1 FROM identity.support_sessions'), 'n=2', 'platform: support_sessions SELECT both tenants');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.tb()), 'SELECT 1 FROM identity.support_sessions'), 'n=1', 'tenant B: support_sessions sees only its own');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format('SELECT 1 FROM identity.ird_annex_records WHERE id IN (%L, %L)', pg_temp.uid(4003), pg_temp.uid(4004))), 'n=2', 'platform: ird_annex_records SELECT both tenants');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), format('SELECT 1 FROM identity.ird_annex_records WHERE id IN (%L, %L)', pg_temp.uid(4003), pg_temp.uid(4004))), 'n=1', 'tenant A: ird_annex_records sees only its own');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), 'SELECT 1 FROM identity.ird_annex_events'), 'n=1', 'platform: ird_annex_events SELECT');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), 'SELECT 1 FROM identity.ird_annex_documents'), 'n=1', 'platform: ird_annex_documents SELECT');
-- INSERT: platform claims allowed, tenant claims refused (42501) where s5.2 gives tenants no INSERT
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, created_by, updated_by)
  VALUES (%L, %L, 'second.admin@synthetic.example', 'Second Admin', 'platform_support', %L, %L)$$, pg_temp.uid(2), pg_temp.uid(102), pg_temp.uid(101), pg_temp.uid(101)), 'w'), 'n=1', 'platform: platform_staff INSERT');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), format($$INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, created_by, updated_by)
  VALUES (%L, %L, 'third.admin@synthetic.example', 'Third Admin', 'platform_support', %L, %L)$$, pg_temp.uid(3), pg_temp.uid(103), pg_temp.sys(), pg_temp.sys()), 'w'), 'E42501', 'tenant: platform_staff INSERT refused');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$INSERT INTO identity.platform_events (id, event_type, target_type, created_by) VALUES (%L, 'platform_staff_invited', 'invitation', %L)$$, pg_temp.uid(52), pg_temp.uid(101)), 'w'),
  'n=1', 'platform: platform_events INSERT');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), format($$INSERT INTO identity.platform_events (id, event_type, target_type, created_by) VALUES (%L, 'platform_staff_invited', 'invitation', %L)$$, pg_temp.uid(53), pg_temp.sys()), 'w'),
  'E42501', 'tenant: platform_events INSERT refused');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$INSERT INTO identity.auth_events (id, tenant_id, event_type, created_by) VALUES (%L, NULL, 'login_failed', %L)$$, pg_temp.uid(24), pg_temp.uid(101)), 'w'),
  'E42501', 's5.3: platform claims have NO INSERT on auth_events (tenant-less inserts go through app.identity_record_auth_event)');
-- REAL T0B-GREEN-3 (stays red on purpose; CR .orchestra/cr/T0B-GREEN-3.identity-platform-audit.nonblocking.md, CR-C0-T0B-PROVFIX-1-002): not ok 105, 113, 115, 117, 135, 198, 202, 203 all fail with E42501 from audit.audit_log
-- (audit_log__insert__owner_only refuses the audit row of a platform-claims write to an audited tenant table). No expectation below was changed to hide it.
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$INSERT INTO identity.support_sessions (id, tenant_id, platform_staff_id, scope, reason_text, ticket_ref, duration_minutes, status, created_by, updated_by)
  VALUES (%L, %L, %L, 'read_only', 'synthetic platform request', 'T-3', 15, 'requested', %L, %L)$$, pg_temp.uid(63), pg_temp.ta(), pg_temp.uid(1), pg_temp.uid(101), pg_temp.uid(101)), 'w'), 'n=1', 'platform: support_sessions INSERT (open a support session)');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), format($$INSERT INTO identity.support_sessions (id, tenant_id, platform_staff_id, scope, reason_text, ticket_ref, duration_minutes, status, created_by, updated_by)
  VALUES (%L, %L, %L, 'read_only', 'synthetic tenant forgery', 'T-4', 15, 'requested', %L, %L)$$, pg_temp.uid(64), pg_temp.ta(), pg_temp.uid(1), pg_temp.sys(), pg_temp.sys()), 'w'), 'E42501', 'tenant: support_sessions INSERT refused');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$INSERT INTO identity.ird_annex_events (id, tenant_id, record_id, to_status, actor_id, created_by) VALUES (%L, %L, %L, 'submitted', %L, %L)$$,
  pg_temp.uid(4102), pg_temp.ta(), pg_temp.uid(4003), pg_temp.uid(101), pg_temp.uid(101)), 'w'), 'n=1', 'platform: ird_annex_events INSERT');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), format($$INSERT INTO identity.ird_annex_events (id, tenant_id, record_id, to_status, actor_id, created_by) VALUES (%L, %L, %L, 'submitted', %L, %L)$$,
  pg_temp.uid(4103), pg_temp.ta(), pg_temp.uid(4003), pg_temp.sys(), pg_temp.sys()), 'w'), 'E42501', 'tenant: ird_annex_events INSERT refused');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$INSERT INTO identity.ird_annex_documents (id, tenant_id, record_id, object_path, original_filename, content_type, size_bytes, sha256, created_by)
  VALUES (%L, %L, %L, %L, 'b.pdf', 'application/pdf', 10, decode(repeat('cd', 32), 'hex'), %L)$$, pg_temp.uid(4202), pg_temp.ta(), pg_temp.uid(4003), pg_temp.ta()::text || '/annex_2/b.pdf', pg_temp.uid(101)), 'w'),
  'n=1', 'platform: ird_annex_documents INSERT');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), format($$INSERT INTO identity.ird_annex_documents (id, tenant_id, record_id, object_path, original_filename, content_type, size_bytes, sha256, created_by)
  VALUES (%L, %L, %L, %L, 'c.pdf', 'application/pdf', 10, decode(repeat('ef', 32), 'hex'), %L)$$, pg_temp.uid(4203), pg_temp.ta(), pg_temp.uid(4003), pg_temp.ta()::text || '/annex_2/c.pdf', pg_temp.sys()), 'w'),
  'E42501', 'tenant: ird_annex_documents INSERT refused');
-- UPDATE: platform claims allowed (also across tenants), tenant claims see no row to update
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$UPDATE identity.platform_staff SET display_name = 'Renamed Admin', updated_by = %L WHERE id = %L$$, pg_temp.uid(101), pg_temp.uid(1)), 'w'), 'n=1', 'platform: platform_staff UPDATE');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), format($$UPDATE identity.platform_staff SET display_name = 'Hijacked' WHERE id = %L$$, pg_temp.uid(1)), 'w'), 'n=0', 'tenant: platform_staff UPDATE touches no row');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$UPDATE identity.feature_flags SET is_enabled = true, version = version + 1, updated_by = %L WHERE tenant_id = %L$$, pg_temp.uid(101), pg_temp.tb()), 'w'), 'n=1', 'platform: feature_flags UPDATE of another tenant');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), format($$UPDATE identity.feature_flags SET is_enabled = true WHERE tenant_id = %L$$, pg_temp.tb()), 'w'), 'n=0', 'tenant A: cannot UPDATE tenant B feature_flags');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$UPDATE identity.support_sessions SET decision_note = 'platform note', updated_by = %L WHERE id = %L$$, pg_temp.uid(101), pg_temp.uid(62)), 'w'), 'n=1', 'platform: support_sessions UPDATE of another tenant');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), format($$UPDATE identity.support_sessions SET status = 'approved' WHERE id = %L$$, pg_temp.uid(62)), 'w'), 'n=0', 'tenant A: cannot UPDATE tenant B support_sessions');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$UPDATE identity.ird_annex_records SET status = 'in_preparation', version = version + 1, updated_by = %L WHERE id = %L$$, pg_temp.uid(101), pg_temp.uid(4004)), 'w'), 'n=1', 'platform: ird_annex_records UPDATE of another tenant');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), format($$UPDATE identity.ird_annex_records SET status = 'in_preparation' WHERE id = %L$$, pg_temp.uid(4004)), 'w'), 'n=0', 'tenant A: cannot UPDATE tenant B ird_annex_records');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$UPDATE identity.ird_annex_documents SET scan_state = 'clean' WHERE id = %L$$, pg_temp.uid(4201)), 'w'), 'n=1', 'platform: ird_annex_documents UPDATE of scan_state (trigger P-19 allows only this column)');
SELECT ok(pg_temp.x('lims_app', pg_temp.cplat(), format($$UPDATE identity.ird_annex_documents SET original_filename = 'renamed.pdf' WHERE id = %L$$, pg_temp.uid(4201)), 'w') LIKE 'E%',
  'platform: ird_annex_documents UPDATE of any other column is refused by the P-19 trigger / column grant');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), format($$UPDATE identity.ird_annex_documents SET scan_state = 'clean' WHERE id = %L$$, pg_temp.uid(4201)), 'w'), 'n=0', 'tenant: ird_annex_documents UPDATE touches no row');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$UPDATE identity.ird_annex_events SET note = 'x' WHERE id = %L$$, pg_temp.uid(4101)), 'w'), 'E42501', 'ird_annex_events is append-only: platform UPDATE refused (no grant, no policy)');
-- the guard is the predicate: aal1, inactive staff or scope <> platform get nothing, even for platform INSERT
SELECT is(pg_temp.x('lims_app', pg_temp.cplat() || '{"aal":"aal1"}', 'SELECT 1 FROM identity.support_sessions'), 'n=0', 'platform aal1: support_sessions returns 0 rows');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat() || '{"scope":"tenant"}', 'SELECT 1 FROM identity.ird_annex_records'), 'n=0', 'scope <> platform: ird_annex_records returns 0 rows');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat() || '{"aal":"aal1"}', format($$INSERT INTO identity.ird_annex_records (id, tenant_id, annex_code, created_by, updated_by) VALUES (%L, %L, 'annex_3', %L, %L)$$,
  pg_temp.uid(4301), pg_temp.ta(), pg_temp.uid(101), pg_temp.uid(101)), 'w'), 'E42501', 'platform aal1: ird_annex_records INSERT refused');

-- ===================================================================================================================================== C. tenant_settings.training_mode (CR C2.T16; 08 A33-3: set at provisioning only)
SELECT has_column('identity', 'tenant_settings', 'training_mode', 'identity.tenant_settings.training_mode exists');
SELECT col_type_is('identity', 'tenant_settings', 'training_mode', 'boolean', 'training_mode is boolean');
SELECT col_not_null('identity', 'tenant_settings', 'training_mode', 'training_mode is NOT NULL');
SELECT col_default_is('identity', 'tenant_settings', 'training_mode', 'false', 'training_mode defaults to false');
SELECT is((SELECT training_mode FROM identity.tenant_settings WHERE tenant_id = pg_temp.ta()), false, 'existing / default rows are live (training_mode = false)');
SELECT is(pg_temp.x('lims_app', pg_temp.csys(pg_temp.tb()), format($$UPDATE identity.tenant_settings SET training_mode = true WHERE tenant_id = %L$$, pg_temp.tb()), 'w') LIKE 'E%', true,
  'training_mode cannot be changed by the tenant-scoped system actor after provisioning (trigger)');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), format($$UPDATE identity.tenant_settings SET training_mode = true WHERE tenant_id = %L$$, pg_temp.ta()), 'w') LIKE 'E%', true, 'training_mode cannot be changed by a tenant staff user');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$UPDATE identity.tenant_settings SET training_mode = true WHERE tenant_id = %L$$, pg_temp.ta()), 'w') LIKE 'E%', true,
  'training_mode cannot be changed by platform claims either (no tenant / platform PATCH path, LD-26)');
SELECT is((SELECT training_mode FROM identity.tenant_settings WHERE tenant_id = pg_temp.ta()), false, 'training_mode is still false after the refused updates');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$UPDATE identity.tenant_settings SET receipt_footer_note = 'thanks', version = version + 1, updated_by = %L WHERE tenant_id = %L$$, pg_temp.uid(101), pg_temp.ta()), 'w'), 'n=1',
  'a platform UPDATE that leaves training_mode alone still works (the trigger is column-specific)');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$UPDATE identity.tenant_settings SET training_mode = false, version = version + 1 WHERE tenant_id = %L$$, pg_temp.ta()), 'w'), 'n=1',
  'an UPDATE that sets training_mode to the value it already has is not a change');
-- provisioning sets it: the INSERT of the tenant_settings row carries the value (insertSettings, tenant.service.ts); the trigger only refuses UPDATE
-- HARNESS fix T0B-GREEN-3 (psql abort audit_log RLS): audit_log__insert__owner_only (20261105000600) admits a core.tenants row only under tenant claims = the row's own tenant, so the system claims are bound to the new tenant for this one insert
SELECT pg_temp.sysc('01a1a98a-ac40-7000-8000-00000000c001'::uuid);
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by)
  VALUES ('01a1a98a-ac40-7000-8000-00000000c001', 'synthetic_training', 'Synthetic Training Lab', 'Synthetic Training Lab', 'provisioning', pg_temp.sys(), pg_temp.sys());
SELECT is(pg_temp.x('lims_app', pg_temp.csys('01a1a98a-ac40-7000-8000-00000000c001'::uuid), format($$INSERT INTO identity.tenant_settings (tenant_id, legal_name_snapshot, display_name, training_mode, created_by, updated_by)
  VALUES (%L, 'Synthetic Training Lab', 'Synthetic Training Lab', true, %L, %L)$$, '01a1a98a-ac40-7000-8000-00000000c001'::uuid, pg_temp.sys(), pg_temp.sys()), 'w'), 'n=1',
  'provisioning INSERT with training_mode = true is accepted');
SELECT is((SELECT training_mode FROM identity.tenant_settings WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000c001'), true, 'the training tenant keeps training_mode = true');

-- ===================================================================================================================================== D. identity.tenant_contract_acceptances (CR C2.T22 + C2.T22-detail; LD-29)
SELECT has_table('identity', 'tenant_contract_acceptances', 'identity.tenant_contract_acceptances exists');
SELECT has_column('identity', 'tenant_contract_acceptances', c, 'tenant_contract_acceptances.' || c)
  FROM unnest(ARRAY['id', 'tenant_id', 'document', 'version', 'accepted_by_name', 'accepted_by_title', 'accepted_at', 'recorded_by', 'created_at', 'created_by']) c;
SELECT col_not_null('identity', 'tenant_contract_acceptances', c, 'tenant_contract_acceptances.' || c || ' NOT NULL')
  FROM unnest(ARRAY['id', 'tenant_id', 'document', 'version', 'accepted_by_name', 'accepted_by_title', 'accepted_at', 'recorded_by', 'created_at', 'created_by']) c;
SELECT col_is_pk('identity', 'tenant_contract_acceptances', 'id', 'tenant_contract_acceptances PK (id)');
SELECT fk_ok('identity', 'tenant_contract_acceptances', 'tenant_id', 'core', 'tenants', 'id', 'tenant_id references core.tenants (id)');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'identity.tenant_contract_acceptances'::regclass), true, 'RLS enabled AND FORCED');
SELECT is((SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'identity.tenant_contract_acceptances'::regclass), 'lims_owner', 'owned by lims_owner');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'tenant_contract_acceptances' AND policyname IN
  ('tenant_contract_acceptances__select__tenant', 'tenant_contract_acceptances__insert__tenant', 'tenant_contract_acceptances__select__platform')), 3, 'the three CR policies exist (select + insert tenant, select platform)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'tenant_contract_acceptances'), 3, 'no other policy: no UPDATE / DELETE policy, no INSERT __platform (append-only)');
SELECT ok((SELECT qual FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'tenant_contract_acceptances' AND policyname = 'tenant_contract_acceptances__select__platform') ~ 'is_platform_actor', 'select__platform uses is_platform_actor()');
SELECT ok((SELECT with_check FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'tenant_contract_acceptances' AND policyname = 'tenant_contract_acceptances__insert__tenant') ~ 'is_staff_or_system', 'insert__tenant carries the staff-or-system guard (08 A17 P-16)');
SELECT ok((SELECT with_check FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'tenant_contract_acceptances' AND policyname = 'tenant_contract_acceptances__insert__tenant') ~ 'current_tenant_id', 'insert__tenant binds tenant_id to app.current_tenant_id()');
-- grants: INSERT and SELECT only; no UPDATE / DELETE / TRUNCATE for any application role
SELECT is(has_table_privilege('lims_app', 'identity.tenant_contract_acceptances', 'SELECT') AND has_table_privilege('lims_app', 'identity.tenant_contract_acceptances', 'INSERT'), true, 'lims_app has SELECT and INSERT');
SELECT is(has_table_privilege(r, 'identity.tenant_contract_acceptances', 'UPDATE') OR has_table_privilege(r, 'identity.tenant_contract_acceptances', 'DELETE') OR has_table_privilege(r, 'identity.tenant_contract_acceptances', 'TRUNCATE'), false,
  r || ' has no UPDATE / DELETE / TRUNCATE (append-only)') FROM unnest(ARRAY['lims_app', 'lims_api', 'lims_worker']) r;
SELECT is((SELECT count(*)::int FROM information_schema.role_table_grants WHERE table_schema = 'identity' AND table_name = 'tenant_contract_acceptances' AND grantee = 'PUBLIC'), 0, 'nothing granted to PUBLIC');
SELECT col_has_check('identity', 'tenant_contract_acceptances', 'document', 'document has a CHECK');
-- behaviour: withTenantScope(new tenant) = system actor bound to the tenant (how provisionTenant writes the rows)
SELECT is(pg_temp.x('lims_app', pg_temp.csys(pg_temp.ta()), format($$INSERT INTO identity.tenant_contract_acceptances (id, tenant_id, document, version, accepted_by_name, accepted_by_title, accepted_at, recorded_by, created_by)
  VALUES (%L, %L, 'tos', '2026-11', 'Synthetic Signer', 'Director', now(), %L, %L)$$, pg_temp.uid(71), pg_temp.ta(), pg_temp.uid(101), pg_temp.uid(101)), 'w'), 'n=1', 'tenant-scoped system actor INSERTs a ToS acceptance');
SELECT is(pg_temp.x('lims_app', pg_temp.csys(pg_temp.ta()), format($$INSERT INTO identity.tenant_contract_acceptances (id, tenant_id, document, version, accepted_by_name, accepted_by_title, accepted_at, recorded_by, created_by)
  VALUES (%L, %L, 'dpa', '2026-11', 'Synthetic Signer', 'Director', now(), %L, %L)$$, pg_temp.uid(72), pg_temp.ta(), pg_temp.uid(101), pg_temp.uid(101)), 'w'), 'n=1', 'tenant-scoped system actor INSERTs a DPA acceptance');
SELECT is(pg_temp.x('lims_app', pg_temp.csys(pg_temp.ta()), format($$INSERT INTO identity.tenant_contract_acceptances (id, tenant_id, document, version, accepted_by_name, accepted_by_title, accepted_at, recorded_by, created_by)
  VALUES (%L, %L, 'tos', '2027-01', 'Synthetic Signer', 'Director', now(), %L, %L)$$, pg_temp.uid(73), pg_temp.ta(), pg_temp.uid(101), pg_temp.uid(101)), 'w'), 'n=1', 're-acceptance of a new version adds a row (history kept)');
SELECT is(pg_temp.x('lims_app', pg_temp.csys(pg_temp.ta()), format($$INSERT INTO identity.tenant_contract_acceptances (id, tenant_id, document, version, accepted_by_name, accepted_by_title, accepted_at, recorded_by, created_by)
  VALUES (%L, %L, 'tos', '2026-11', 'Synthetic Signer', 'Director', now(), %L, %L)$$, pg_temp.uid(74), pg_temp.tb(), pg_temp.uid(101), pg_temp.uid(101)), 'w'), 'E42501', 'tenant A scope cannot write an acceptance for tenant B (WITH CHECK binds tenant_id)');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$INSERT INTO identity.tenant_contract_acceptances (id, tenant_id, document, version, accepted_by_name, accepted_by_title, accepted_at, recorded_by, created_by)
  VALUES (%L, %L, 'tos', '2026-11', 'Synthetic Signer', 'Director', now(), %L, %L)$$, pg_temp.uid(75), pg_temp.ta(), pg_temp.uid(101), pg_temp.uid(101)), 'w'), 'E42501',
  'platform claims have no INSERT policy on acceptances (rows are written inside withTenantScope only; CR C2.T22 grants platform SELECT only)');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.ta()), 'SELECT 1 FROM identity.tenant_contract_acceptances'), 'n=3', 'tenant A staff (tenant admin read) sees its 3 rows');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.tb()), 'SELECT 1 FROM identity.tenant_contract_acceptances'), 'n=0', 'tenant B staff sees none of tenant A''s rows');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), 'SELECT 1 FROM identity.tenant_contract_acceptances'), 'n=3', 'platform operators read all tenants'' acceptances');
SELECT is(pg_temp.x('lims_app', '{"actor_type":"partner","tenant_id":"01a1a98a-ac40-7000-8000-00000000a001","sub":"01a1a98a-ac40-7000-8000-00000000a900"}'::jsonb, 'SELECT 1 FROM identity.tenant_contract_acceptances'), 'n=0',
  'a non-staff actor (partner claims) reads none (staff-or-system guard)');
SELECT is(pg_temp.x('lims_app', pg_temp.csys(pg_temp.ta()), 'SELECT 1 FROM identity.tenant_contract_acceptances', 'n') , 'n=3', 'system actor of tenant A reads its 3 rows');
SELECT is(pg_temp.x('lims_app', pg_temp.csys(pg_temp.ta()), format($$UPDATE identity.tenant_contract_acceptances SET accepted_by_name = 'Forged' WHERE id = %L$$, pg_temp.uid(71)), 'w'), 'E42501', 'append-only: UPDATE refused (no grant)');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$UPDATE identity.tenant_contract_acceptances SET accepted_by_name = 'Forged' WHERE id = %L$$, pg_temp.uid(71)), 'w'), 'E42501', 'append-only: UPDATE refused for platform claims too');
SELECT is(pg_temp.x('lims_app', pg_temp.csys(pg_temp.ta()), format($$DELETE FROM identity.tenant_contract_acceptances WHERE id = %L$$, pg_temp.uid(71)), 'w'), 'E42501', 'append-only: DELETE refused (no grant)');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), 'DELETE FROM identity.tenant_contract_acceptances', 'w'), 'E42501', 'append-only: DELETE refused for platform claims');
SELECT is(pg_temp.x('lims_app', pg_temp.csys(pg_temp.ta()), 'TRUNCATE identity.tenant_contract_acceptances', 'w'), 'E42501', 'append-only: TRUNCATE refused');
-- CHECK constraints (CR C2.T22): document tos|dpa, version 1..32, name 1..120, title 1..80
CREATE FUNCTION pg_temp.acc(p_doc text, p_ver text, p_name text, p_title text, p_n int) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.x('lims_app', pg_temp.csys(pg_temp.ta()), format($i$INSERT INTO identity.tenant_contract_acceptances (id, tenant_id, document, version, accepted_by_name, accepted_by_title, accepted_at, recorded_by, created_by)
    VALUES (%L, %L, %L, %L, %L, %L, now(), %L, %L)$i$, pg_temp.uid(80 + p_n), pg_temp.ta(), p_doc, p_ver, p_name, p_title, pg_temp.uid(101), pg_temp.uid(101)), 'w') $$;
SELECT is(pg_temp.acc('nda', 'v1', 'Synthetic Signer', 'Director', 1), 'E23514', 'document must be tos or dpa');
SELECT is(pg_temp.acc('tos', '', 'Synthetic Signer', 'Director', 2), 'E23514', 'version is not empty');
SELECT is(pg_temp.acc('tos', repeat('v', 33), 'Synthetic Signer', 'Director', 3), 'E23514', 'version <= 32');
SELECT is(pg_temp.acc('tos', repeat('v', 32), 'Synthetic Signer', 'Director', 4), 'n=1', 'version of 32 characters is accepted');
SELECT is(pg_temp.acc('tos', 'v5', '', 'Director', 5), 'E23514', 'accepted_by_name is not empty');
SELECT is(pg_temp.acc('tos', 'v6', repeat('n', 121), 'Director', 6), 'E23514', 'accepted_by_name <= 120');
SELECT is(pg_temp.acc('tos', 'v7', 'Synthetic Signer', '', 7), 'E23514', 'accepted_by_title is not empty');
SELECT is(pg_temp.acc('tos', 'v8', 'Synthetic Signer', repeat('t', 81), 8), 'E23514', 'accepted_by_title <= 80');

-- ===================================================================================================================================== E. provisioning inserts (LD-223 point 3: ird_annex_records under PLATFORM claims)
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$INSERT INTO identity.ird_annex_records (id, tenant_id, annex_code, created_by, updated_by) VALUES (%L, %L, 'annex_2', %L, %L), (%L, %L, 'annex_3', %L, %L), (%L, %L, 'annex_7', %L, %L)$$,
  -- HARNESS T0B-GREEN-3 (198, 202, 203): tenant B already holds the fixture annex_2 row 4004 (unique tenant_id + annex_code, ird_annex_records__tenant_id_annex_code__p_uq), so the three provisioning inserts
  -- collided (E23505) before the policy was ever evaluated; "provisioning" now targets the new tenant c001 (created in section C), which has no annex rows. (annex_1 is platform-level, tenant_id NULL by __platform_level__ck.)
  pg_temp.uid(4401), '01a1a98a-ac40-7000-8000-00000000c001'::uuid, pg_temp.uid(101), pg_temp.uid(101), pg_temp.uid(4402), '01a1a98a-ac40-7000-8000-00000000c001'::uuid, pg_temp.uid(101), pg_temp.uid(101), pg_temp.uid(4403), '01a1a98a-ac40-7000-8000-00000000c001'::uuid, pg_temp.uid(101), pg_temp.uid(101)), 'w'), 'n=3',
  'provisioning: platform claims INSERT the tenant''s annex_2 / annex_3 / annex_7 records (ird_annex_records__insert__platform)');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.tb()), format($$INSERT INTO identity.ird_annex_records (id, tenant_id, annex_code, created_by, updated_by) VALUES (%L, %L, 'annex_3', %L, %L)$$,
  pg_temp.uid(4404), pg_temp.tb(), pg_temp.sys(), pg_temp.sys()), 'w'), 'E42501', 'a tenant staff user never inserts annex records (s5.2)');
SELECT is(pg_temp.x('lims_app', pg_temp.csys(pg_temp.tb()), format($$INSERT INTO identity.ird_annex_records (id, tenant_id, annex_code, created_by, updated_by) VALUES (%L, %L, 'annex_3', %L, %L)$$,
  pg_temp.uid(4405), pg_temp.tb(), pg_temp.sys(), pg_temp.sys()), 'w'), 'E42501', 'the tenant-scoped system actor does not insert annex records either: the insert runs under platform claims (no tenant INSERT policy, no CR needed)');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff(pg_temp.tb()), format($$INSERT INTO identity.ird_annex_records (id, tenant_id, annex_code, created_by, updated_by) VALUES (%L, %L, 'annex_3', %L, %L)$$,
  pg_temp.uid(4406), pg_temp.ta(), pg_temp.sys(), pg_temp.sys()), 'w'), 'E42501', 'tenant B staff cannot insert an annex record for tenant A');
SELECT is(pg_temp.x('lims_app', pg_temp.cplat(), format($$INSERT INTO identity.ird_annex_records (id, tenant_id, annex_code, created_by, updated_by) VALUES (%L, %L, 'annex_3', %L, %L)$$,
  pg_temp.uid(4407), '01a1a98a-ac40-7000-8000-00000000c001'::uuid, pg_temp.uid(101), pg_temp.uid(101)), 'w'), 'E23505', 'a second live row for the same tenant and annex is still a unique-key refusal, not a policy hole');
SELECT is(pg_temp.x('lims_app', pg_temp.cstaff('01a1a98a-ac40-7000-8000-00000000c001'::uuid), format('SELECT 1 FROM identity.ird_annex_records WHERE id IN (%L, %L, %L)', pg_temp.uid(4401), pg_temp.uid(4402), pg_temp.uid(4403))), 'n=3', 'after provisioning the tenant reads its three annex records (s5.2 tenant SELECT)');

SELECT * FROM finish();
ROLLBACK;
