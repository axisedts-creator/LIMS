-- T0B-10.C2 schema suite: identity DDL behaviour (C2 05-SCHEMA §4, §10.1, §11 tests 5-10, 12-18, 21, 25, 26, 29, 30; AC-0B-2.1, 2.2, 4.1-4.3).
-- Synthetic data only (seeds 010: tenant A 01a1a98a-...-a001, tenant B ...-b001). One rolled-back transaction. RLS is never disabled; fixtures are inserted by the
-- superuser test session (which bypasses RLS) with the core system actor's claims set so app.tg_row_audit has an audit context.
-- Run from the repo root: pg_prove -d <db> db/tests/identity/T0B-10.C2_schema.test.sql   (pgTAP in schema `extensions`; seeds loaded; superuser)
-- Coverage map (C2 05-SCHEMA §11):
-- §11 test 5: no DELETE privilege on identity tables
-- §11 test 6: append-only tables have no UPDATE privilege
-- §11 test 7: branding_assets mutable-column trigger (immutable_row)
-- §11 test 8: feature_flags__check_approval
-- §11 test 9: CHECK ranges of 04 (tenant_settings)
-- §11 test 10: DEFINER catalog properties (prosecdef, search_path, no PUBLIC EXECUTE)
-- §11 test 12: composite FK sessions(tenant, membership)
-- §11 test 13: five session kinds, shape and lifetimes
-- §11 test 14: scope_user_only / all_centres on non-user memberships
-- §11 test 15: bucket and path checks
-- §11 test 16: tenant_settings format checks
-- §11 test 17: previous_token_sha256 constraints
-- §11 test 18: generated is_active, duplicate invite
-- §11 test 21: is_platform_actor under FORCE RLS
-- §11 test 24: GUC-bound policies are TO lims_owner (catalog half)
-- §11 test 25: no audit trigger on platform-only tables (catalog half)
-- §11 test 26: staff-actor guard in every __tenant policy (catalog half)
-- §11 test 29: scan_state
-- §11 test 30: v1 constants
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c200-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.h32(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '\x' || encode(sha256(convert_to(s, 'UTF8')), 'hex') $$;
CREATE TEMP SEQUENCE sq;
-- claims of the core system actor for tenant A (what withTenantScope sets); audit triggers need a context
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);
-- SQLSTATE of a statement run in a sub-transaction ('ok' when it succeeds); message of the failure
CREATE FUNCTION pg_temp.st(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$ BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $f$;
CREATE FUNCTION pg_temp.msg(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$ BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $f$;
-- insert only the keys of p_row (omitted columns take their DEFAULT)
CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE cols text := (SELECT string_agg(quote_ident(k), ',') FROM jsonb_object_keys(p_row) k);
BEGIN EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, p_row::text); END $f$;
CREATE FUNCTION pg_temp.insq(p_tbl text, p_row jsonb) RETURNS text LANGUAGE sql AS $$ SELECT format('SELECT pg_temp.ins(%L::regclass, %L::jsonb)', p_tbl, p_row::text) $$;
-- a valid tenant_staff session of tenant A; p_over overrides keys
CREATE FUNCTION pg_temp.sess(p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE n int := nextval('sq');
BEGIN
  RETURN jsonb_build_object('id', pg_temp.uid(1000 + n), 'tenant_id', pg_temp.ta(), 'kind', 'tenant_staff', 'user_id', '01a1a98a-ac40-7000-8000-00000000a300',
    'membership_id', '01a1a98a-ac40-7000-8000-00000000a500', 'gotrue_session_id', pg_temp.uid(2000 + n), 'token_sha256', pg_temp.h32('tok' || n),
    'state', 'active', 'aal', 'aal1', 'refresh_token_enc', '\x01', 'access_token_enc', '\x01', 'enc_key_id', 'k1',
    'access_expires_at', now() + interval '1 hour', 'idle_timeout_minutes', 30, 'idle_expires_at', now() + interval '30 minutes',
    'absolute_expires_at', now() + interval '11 hours', 'expires_at', now() + interval '12 hours', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()) || p_over;
END $f$;
CREATE FUNCTION pg_temp.ok_sess(p_over jsonb) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.st(pg_temp.insq('identity.sessions', pg_temp.sess(p_over))) $$;

-- ===================================================================================================================================== structure
SELECT has_schema('identity', 'schema identity exists');
SELECT is(count(*)::int, 18, '18 identity tables (16 FORCE-RLS + 2 g_*) plus event_inbox is 19 relations') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'identity' AND c.relkind = 'r' AND c.relname <> 'event_inbox';
SELECT is(pg_get_userbyid(c.relowner), 'lims_owner', 'identity.' || c.relname || ' owned by lims_owner') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'identity' AND c.relkind = 'r';
SELECT is(c.relrowsecurity AND c.relforcerowsecurity, true, 'AC-0B-2.1 identity.' || c.relname || ' ENABLE + FORCE RLS') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'identity' AND c.relkind = 'r' AND c.relname !~ '^g_';
SELECT is(c.relrowsecurity, false, 'identity.' || c.relname || ' (class G) is RLS-exempt') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'identity' AND c.relname ~ '^g_' AND c.relkind = 'r';
SELECT is(count(*)::int, 5, 'g_feature_flags seeded with the five §8 flags') FROM identity.g_feature_flags;
SELECT results_eq($$SELECT code FROM identity.g_feature_flags ORDER BY code$$,
  $$VALUES ('breached_password_online_check'),('referral_incentive_report'),('smart_report'),('smart_report_llm'),('whatsapp_pdf_attachment')$$, 'g_feature_flags codes');
SELECT is((SELECT count(*)::int FROM identity.g_breached_passwords), 0, 'no breached list in the repo (§8)');

-- ===================================================================================================================================== §11 test 5
-- §11 test 5: no DELETE for lims_app on any identity table (purge only through §6 maintenance DEFINERs)
SELECT is(has_table_privilege(r.rolname, c.oid, 'DELETE'), false, r.rolname || ' has no DELETE on identity.' || c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN pg_roles r
 WHERE n.nspname = 'identity' AND c.relkind = 'r' AND r.rolname IN ('lims_app', 'lims_api', 'lims_worker');
SELECT is(has_table_privilege('lims_app', c.oid, 'TRUNCATE') OR has_table_privilege('lims_app', c.oid, 'REFERENCES') OR has_table_privilege('lims_app', c.oid, 'TRIGGER'), false,
  'lims_app has no TRUNCATE/REFERENCES/TRIGGER on identity.' || c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'identity' AND c.relkind = 'r';
SELECT is(has_table_privilege(r, c.oid, p), false, r || ' has no ' || p || ' on identity.' || c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN unnest(ARRAY['anon', 'authenticated']) r CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
 WHERE n.nspname = 'identity' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);

-- ===================================================================================================================================== §11 test 6
-- §11 test 6: append-only tables have no UPDATE privilege (table or column) except ird_annex_documents.scan_state (P-19)
SELECT is(has_any_column_privilege('lims_app', 'identity.' || t, 'UPDATE'), false, 'lims_app has no UPDATE on append-only identity.' || t)
  FROM unnest(ARRAY['auth_events', 'ird_annex_events', 'access_reviews', 'platform_events']) t;
SELECT is(has_table_privilege('lims_app', 'identity.ird_annex_documents', 'UPDATE'), false, 'ird_annex_documents: no table-level UPDATE');
SELECT is(has_column_privilege('lims_app', 'identity.ird_annex_documents', 'scan_state', 'UPDATE'), true, 'ird_annex_documents: UPDATE (scan_state) only (P-19)');
SELECT is(count(*)::int, 0, 'ird_annex_documents: UPDATE on no other column') FROM pg_attribute a
 WHERE a.attrelid = 'identity.ird_annex_documents'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attname <> 'scan_state' AND has_column_privilege('lims_app', a.attrelid, a.attname, 'UPDATE');
SELECT is(has_table_privilege('lims_app', 'identity.' || t, 'SELECT') AND NOT has_table_privilege('lims_app', 'identity.' || t, 'INSERT') AND NOT has_table_privilege('lims_app', 'identity.' || t, 'UPDATE'),
  true, 'class G identity.' || t || ' is SELECT-only for lims_app') FROM unnest(ARRAY['g_feature_flags', 'g_breached_passwords']) t;

-- ===================================================================================================================================== §11 test 10
-- §11 test 10: DEFINER functions: prosecdef, search_path pinned, EXECUTE not granted to PUBLIC / anon / authenticated
SELECT is(p.prosecdef, true, p.proname || ' is SECURITY DEFINER') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname ~ '^identity_' AND p.proname <> 'identity_is_breached';
SELECT ok(array_to_string(p.proconfig, ',') ~ 'search_path=("")?$' OR array_to_string(p.proconfig, ',') ~ 'search_path=""', p.proname || ' pins search_path')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname ~ '^identity_';
SELECT is(p.prosecdef, false, 'app.identity_is_breached is INVOKER (lims_app holds SELECT on the G table)') FROM pg_proc p WHERE p.oid = 'app.identity_is_breached(bytea)'::regprocedure;
SELECT is(p.proacl IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0), true, p.proname || ' has no PUBLIC EXECUTE')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname ~ '^identity_';
SELECT is(has_function_privilege(r, p.oid, 'EXECUTE'), false, r || ' cannot execute app.' || p.proname)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN unnest(ARRAY['anon', 'authenticated']) r
 WHERE n.nspname = 'app' AND p.proname ~ '^identity_' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
SELECT is(pg_get_userbyid(p.proowner), 'lims_owner', p.proname || ' owned by lims_owner') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'app' AND p.proname ~ '^identity_' AND p.prosecdef;
-- EXECUTE grantees: maintenance + import + notify = lims_worker only; platform auth writes / lookups = lims_api (spec grants)
SELECT is(has_function_privilege('lims_api', p.oid, 'EXECUTE'), false, 'lims_api cannot execute maintenance app.' || p.proname)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'app' AND p.proname IN ('identity_purge_sessions', 'identity_expire_support_sessions', 'identity_expire_invitations', 'identity_expire_audit_exports',
   'identity_purge_auth_events', 'identity_tenants_for_email_hmacs', 'identity_notify_ip_throttle_hmacs');
SELECT is(has_function_privilege('lims_worker', p.oid, 'EXECUTE'), true, 'lims_worker can execute app.' || p.proname)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'app' AND p.proname IN ('identity_purge_sessions', 'identity_expire_support_sessions', 'identity_expire_invitations', 'identity_expire_audit_exports',
   'identity_purge_auth_events', 'identity_tenants_for_email_hmacs', 'identity_notify_ip_throttle_hmacs');

-- ===================================================================================================================================== §11 test 25 (catalog half)
-- §11 test 25: no app.tg_row_audit trigger on platform-only tables / sessions; audit trigger on every audited table
SELECT is((SELECT count(*)::int FROM pg_trigger g WHERE g.tgrelid = ('identity.' || t)::regclass AND NOT g.tgisinternal AND g.tgfoid = 'app.tg_row_audit()'::regprocedure), 0,
  'no tg_row_audit trigger on identity.' || t) FROM unnest(ARRAY['platform_staff', 'platform_events', 'sessions']) t;
SELECT is(count(*)::int, 1, 'AFTER I/U/D tg_row_audit trigger on identity.' || t) FROM unnest(ARRAY['tenant_settings', 'feature_flags', 'invitations', 'support_sessions', 'ird_annex_records',
  'branding_assets', 'access_reviews', 'mfa_factors']) t JOIN pg_trigger g ON g.tgrelid = ('identity.' || t)::regclass AND NOT g.tgisinternal AND g.tgfoid = 'app.tg_row_audit()'::regprocedure
  AND (g.tgtype & 1) = 1 AND (g.tgtype & 2) = 0 AND (g.tgtype & 4) = 4 AND (g.tgtype & 8) = 8 AND (g.tgtype & 16) = 16 GROUP BY t;

-- ===================================================================================================================================== §11 test 26 (catalog half) / 24 last sentence / AC-0B-2.2
-- §11 test 26: every __tenant policy has is_staff_or_system in qual and (INSERT/UPDATE) in with_check
SELECT ok(coalesce(qual, '') ~ 'is_staff_or_system' OR cmd = 'INSERT', policyname || ' USING carries is_staff_or_system') FROM pg_policies WHERE schemaname = 'identity' AND policyname ~ '__tenant$';
SELECT ok(coalesce(with_check, '') ~ 'is_staff_or_system' OR cmd = 'SELECT', policyname || ' WITH CHECK carries is_staff_or_system') FROM pg_policies WHERE schemaname = 'identity' AND policyname ~ '__tenant$';
SELECT is(count(*)::int, 33, '33 __tenant policies on identity tables') FROM pg_policies WHERE schemaname = 'identity' AND policyname ~ '__tenant$';
-- §11 test 24 (tail): every policy whose qual or with_check mentions app.pre_ / app.maintenance is TO lims_owner only
SELECT is(roles::text, '{lims_owner}', policyname || ' (GUC-bound) is TO lims_owner only') FROM pg_policies
 WHERE schemaname IN ('identity', 'core') AND (coalesce(qual, '') ~ 'app\.(pre_|maintenance)' OR coalesce(with_check, '') ~ 'app\.(pre_|maintenance)') AND tablename IN (SELECT relname FROM pg_class WHERE relnamespace IN ('identity'::regnamespace, 'core'::regnamespace));
SELECT is(count(*)::int, 0, 'no identity policy applies to public/anon/authenticated') FROM pg_policies WHERE schemaname = 'identity' AND roles && ARRAY['public', 'anon', 'authenticated']::name[];
SELECT is(count(*)::int, 0, 'only sessions and mfa_factors have __own policies (partner access, 08 A19 D-101)') FROM pg_policies WHERE schemaname = 'identity' AND policyname ~ '__own' AND tablename NOT IN ('sessions', 'mfa_factors');

-- ===================================================================================================================================== fixtures
-- platform staff (superadmin) for platform sessions; tenant settings A and B; membership shapes
SELECT pg_temp.ins('identity.platform_staff', jsonb_build_object('id', pg_temp.uid(1), 'user_id', pg_temp.uid(101), 'email_normalized', 'platform.admin@synthetic.example', 'display_name', 'Synthetic Platform Admin',
  'role_code', 'platform_superadmin', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.tenant_settings', jsonb_build_object('tenant_id', pg_temp.ta(), 'legal_name_snapshot', 'Synthetic Lab Alpha', 'display_name', 'Synthetic Lab Alpha', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));

-- ===================================================================================================================================== §11 test 13 / 12 / 17 (sessions)
-- §11 test 13: the five kinds accept their R10 shape and lifetimes, reject the others
SELECT is(pg_temp.ok_sess('{}'), 'ok', 'tenant_staff: idle 30 accepted');
SELECT is(pg_temp.ok_sess('{"idle_timeout_minutes":15}'), 'ok', 'tenant_staff: idle 15 accepted');
SELECT is(pg_temp.ok_sess('{"idle_timeout_minutes":14}'), '23514', 'tenant_staff: idle 14 rejected (sessions__idle__ck)');
SELECT is(pg_temp.ok_sess('{"idle_timeout_minutes":31}'), '23514', 'tenant_staff: idle 31 rejected');
SELECT is(pg_temp.ok_sess('{"idle_timeout_minutes":20160}'), '23514', 'tenant_staff with 14-day idle rejected');
SELECT is(pg_temp.ok_sess(jsonb_build_object('absolute_expires_at', now() + interval '13 hours', 'expires_at', now() + interval '14 hours')), '23514', 'tenant_staff: absolute > 12 h rejected (sessions__absolute__ck)');
SELECT is(pg_temp.ok_sess(jsonb_build_object('kind', 'patient', 'app_instance_id', pg_temp.uid(300), 'app_platform', 'android', 'idle_timeout_minutes', 1440,
  'absolute_expires_at', now() + interval '60 days', 'expires_at', now() + interval '61 days')), 'ok', 'patient: 1-day idle, 60-day absolute, aal1 accepted');
SELECT is(pg_temp.ok_sess(jsonb_build_object('kind', 'patient', 'aal', 'aal2', 'app_instance_id', pg_temp.uid(301), 'app_platform', 'ios', 'idle_timeout_minutes', 1440,
  'absolute_expires_at', now() + interval '60 days', 'expires_at', now() + interval '61 days')), '23514', 'patient with aal2 rejected (sessions__patient_aal__ck)');
SELECT is(pg_temp.ok_sess(jsonb_build_object('kind', 'patient', 'app_instance_id', pg_temp.uid(302), 'app_platform', 'ios', 'idle_timeout_minutes', 1440,
  'absolute_expires_at', now() + interval '91 days', 'expires_at', now() + interval '92 days')), '23514', 'patient: absolute > 90 days rejected');
SELECT is(pg_temp.ok_sess('{"kind":"staff_mobile","idle_timeout_minutes":60}'), '23514', 'staff_mobile without app_instance_id rejected (sessions__app__ck)');
SELECT is(pg_temp.ok_sess(jsonb_build_object('kind', 'staff_mobile', 'app_instance_id', pg_temp.uid(303), 'app_platform', 'android', 'idle_timeout_minutes', 60)), 'ok', 'staff_mobile idle 60 accepted');
SELECT is(pg_temp.ok_sess(jsonb_build_object('kind', 'staff_mobile', 'app_instance_id', pg_temp.uid(304), 'app_platform', 'android', 'idle_timeout_minutes', 720)), 'ok', 'staff_mobile idle 720 accepted');
SELECT is(pg_temp.ok_sess(jsonb_build_object('kind', 'staff_mobile', 'app_instance_id', pg_temp.uid(305), 'app_platform', 'android', 'idle_timeout_minutes', 59)), '23514', 'staff_mobile idle 59 rejected');
SELECT is(pg_temp.ok_sess(jsonb_build_object('kind', 'staff_mobile', 'app_instance_id', pg_temp.uid(306), 'app_platform', 'android', 'idle_timeout_minutes', 721)), '23514', 'staff_mobile idle 721 rejected');
SELECT is(pg_temp.ok_sess(jsonb_build_object('kind', 'partner', 'idle_timeout_minutes', 20)), 'ok', 'partner: idle 20 accepted');
SELECT is(pg_temp.ok_sess(jsonb_build_object('kind', 'platform', 'tenant_id', NULL, 'membership_id', NULL, 'platform_staff_id', pg_temp.uid(1))), 'ok', 'platform: no tenant, staff id, accepted');
SELECT is(pg_temp.ok_sess(jsonb_build_object('kind', 'platform')), '23514', 'platform with tenant+membership rejected (sessions__kind_shape__ck)');
SELECT is(pg_temp.ok_sess(jsonb_build_object('tenant_id', NULL)), '23514', 'tenant_staff without tenant rejected');
SELECT is(pg_temp.ok_sess(jsonb_build_object('kind', 'robot')), '23514', 'unknown kind rejected');
SELECT is(pg_temp.ok_sess('{"state":"revoked"}'), '23514', 'revoked without revoked_at/reason rejected (sessions__revoke__ck)');
SELECT is(pg_temp.ok_sess('{"mfa_failed_attempts":6}'), '23514', 'mfa_failed_attempts > 5 rejected');
-- §11 test 12: composite FK (tenant_id, membership_id): tenant A session pointing at a tenant B membership
SELECT is(pg_temp.ok_sess('{"membership_id":"01a1a98a-ac40-7000-8000-00000000b500"}'), '23503', 'composite FK: sessions(tenant=A, membership=<B membership>) rejected');
-- §11 test 17: previous_token_sha256 (CR-C2-018)
SELECT is(pg_temp.ok_sess(jsonb_build_object('previous_token_sha256', '\x' || repeat('ab', 31))), '23514', '31-byte previous_token_sha256 rejected (sessions__previous_token_len__ck)');
SELECT is(pg_temp.ok_sess(jsonb_build_object('previous_token_sha256', '\x' || repeat('ab', 33))), '23514', '33-byte previous_token_sha256 rejected');
SELECT is(pg_temp.ok_sess(jsonb_build_object('previous_token_sha256', '\x' || repeat('cd', 32))), 'ok', '32-byte previous_token_sha256 accepted');
SELECT is(pg_temp.ok_sess(jsonb_build_object('previous_token_sha256', '\x' || repeat('cd', 32))), '23505', 'same non-NULL previous_token_sha256 twice -> sessions__previous_token_sha256__p_uq');
SELECT is(pg_temp.ok_sess('{}'), 'ok', 'NULL previous_token_sha256 accepted (1)');
SELECT is(pg_temp.ok_sess('{}'), 'ok', 'NULL previous_token_sha256 accepted (2: many NULLs)');
SELECT is((SELECT indexdef ~ 'UNIQUE' FROM pg_indexes WHERE schemaname = 'identity' AND indexname = 'sessions__previous_token_sha256__p_uq'), true, 'previous-token index is UNIQUE');

-- ===================================================================================================================================== §11 test 9 / 16 / 30 (tenant_settings)
-- §11 test 9: ranges of 04 (idle 15-30, absolute <= 12, link TTL 30-90, retention floors)
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET idle_timeout_minutes = 14 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'idle 14 rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET idle_timeout_minutes = 31 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'idle 31 rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET idle_timeout_minutes = 15 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), 'ok', 'idle 15 accepted');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET absolute_session_hours = 13 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'absolute 13 h rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET absolute_session_hours = 12 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), 'ok', 'absolute 12 h accepted');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET report_link_ttl_days = 29 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'link TTL 29 rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET report_link_ttl_days = 91 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'link TTL 91 rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET report_link_ttl_days = 90 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), 'ok', 'link TTL 90 accepted');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET retention_audit_years = 4 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'audit retention floor 5 enforced');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET retention_clinical_years = 4 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'clinical retention floor 5 enforced');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET retention_raw_instrument_years = 0 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'raw-instrument retention floor 1 enforced');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET password_min_length = 11 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'password length 11 rejected');
-- §11 test 16
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET accent_color = '#12345G' WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'accent_color #12345G rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET accent_color = '123456' WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'accent_color without # rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET accent_color = '#1A2b3C' WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), 'ok', 'accent_color #1A2b3C accepted');
SELECT isnt(pg_temp.st($$UPDATE identity.tenant_settings SET address_lines = ARRAY['a','b','c','d','e'] WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), 'ok', 'address_lines with 5 lines rejected (check_arrays trigger)');
SELECT isnt(pg_temp.st(format($$UPDATE identity.tenant_settings SET address_lines = ARRAY[%L] WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$, repeat('x', 121))), 'ok', 'address line of 121 chars rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET address_lines = ARRAY['a','b','c',repeat('y',120)] WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), 'ok', '4 lines, one of 120 chars accepted');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET barcode_prefix = 'ABCDE' WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'barcode_prefix of 5 chars rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET barcode_prefix = 'ab12' WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'lower-case barcode_prefix rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET barcode_prefix = 'AB12' WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), 'ok', 'barcode_prefix AB12 accepted');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET accession_prefix_histology = 'TOOLONG' WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'accession_prefix_histology > 4 chars rejected');
-- §11 test 30: v1 constants
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET timezone = 'Asia/Kolkata' WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'timezone Asia/Kolkata rejected (tenant_settings__timezone__ck)');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET timezone = 'Asia/Kathmandu' WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), 'ok', 'timezone Asia/Kathmandu accepted');
SELECT is(pg_get_expr(d.adbin, d.adrelid), '''{prefix}{yy}{seq:8}''::text', 'barcode_pattern default is {prefix}{yy}{seq:8} (08 A13 D-8)')
  FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = 'identity.tenant_settings'::regclass AND a.attname = 'barcode_pattern';
SELECT is((SELECT timezone FROM identity.tenant_settings WHERE tenant_id = pg_temp.ta()), 'Asia/Kathmandu', 'timezone default Asia/Kathmandu');

-- ===================================================================================================================================== §11 test 7 / 15 (branding_assets)
CREATE FUNCTION pg_temp.brand(p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE n int := nextval('sq');
BEGIN
  RETURN jsonb_build_object('id', pg_temp.uid(3000 + n), 'tenant_id', pg_temp.ta(), 'kind', 'logo', 'object_path', pg_temp.ta()::text || '/logo-' || n || '.png', 'content_type', 'image/png',
    'size_bytes', 1000, 'width_px', 100, 'height_px', 50, 'sha256', pg_temp.h32('logo' || n), 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()) || p_over;
END $f$;
SELECT is(pg_temp.st(pg_temp.insq('identity.branding_assets', pg_temp.brand('{"id":"0190c200-0000-7000-8000-000000009001"}'))), 'ok', 'branding_assets: valid logo accepted (scan_state defaults pending)');
SELECT is((SELECT scan_state FROM identity.branding_assets WHERE id = '0190c200-0000-7000-8000-000000009001'), 'pending', 'branding_assets.scan_state default pending (P-19)');
-- §11 test 15
SELECT is(pg_temp.st(pg_temp.insq('identity.branding_assets', pg_temp.brand('{"bucket":"reports"}'))), '23514', 'branding_assets__bucket__ck rejects any bucket other than identity-assets');
SELECT is(pg_temp.st(pg_temp.insq('identity.branding_assets', pg_temp.brand(jsonb_build_object('object_path', pg_temp.tb()::text || '/logo.png')))), '23514', 'object_path must start with the tenant id (branding_assets__path__ck)');
SELECT is(pg_temp.st(pg_temp.insq('identity.branding_assets', pg_temp.brand('{"content_type":"image/gif"}'))), '23514', 'only png/jpeg');
SELECT is(pg_temp.st(pg_temp.insq('identity.branding_assets', pg_temp.brand('{"size_bytes":2097153}'))), '23514', 'size > 2 MiB rejected');
SELECT is(pg_temp.st(pg_temp.insq('identity.branding_assets', pg_temp.brand('{"scan_state":"unknown"}'))), '23514', 'scan_state outside pending/clean/quarantined rejected');
-- §11 test 7 / AC-0B-4.1: content change rejected with immutable_row; is_active / scan_state / audit columns may change
SELECT is(pg_temp.msg($$UPDATE identity.branding_assets SET object_path = '01a1a98a-ac40-7000-8000-00000000a001/other.png' WHERE id = '0190c200-0000-7000-8000-000000009001'$$), 'immutable_row', 'AC-0B-4.1 branding_assets: object_path change raises immutable_row');
SELECT is(pg_temp.msg($$UPDATE identity.branding_assets SET sha256 = '\x00' WHERE id = '0190c200-0000-7000-8000-000000009001'$$), 'immutable_row', 'branding_assets: sha256 change raises immutable_row');
SELECT is(pg_temp.msg($$UPDATE identity.branding_assets SET kind = 'letterhead_header' WHERE id = '0190c200-0000-7000-8000-000000009001'$$), 'immutable_row', 'branding_assets: kind change raises immutable_row');
SELECT is(pg_temp.st($$UPDATE identity.branding_assets SET is_active = false, version = version + 1 WHERE id = '0190c200-0000-7000-8000-000000009001'$$), 'ok', 'branding_assets: is_active toggle allowed');
SELECT is(pg_temp.st($$UPDATE identity.branding_assets SET scan_state = 'clean' WHERE id = '0190c200-0000-7000-8000-000000009001'$$), 'ok', 'branding_assets: scan_state update allowed (P-19)');

-- ===================================================================================================================================== §11 test 8 (feature_flags)
SELECT is(pg_temp.msg(pg_temp.insq('identity.feature_flags', jsonb_build_object('tenant_id', pg_temp.ta(), 'flag_code', 'smart_report_llm', 'is_enabled', true, 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()))),
  'feature_flag_requires_approval', 'feature_flags__check_approval: enabling a founder-approval flag without approval_ref is rejected');
SELECT is(pg_temp.st(pg_temp.insq('identity.feature_flags', jsonb_build_object('tenant_id', pg_temp.ta(), 'flag_code', 'smart_report_llm', 'is_enabled', true, 'approval_ref', 'FOUNDER-2026-001', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()))),
  'ok', 'same flag with approval_ref accepted');
SELECT is(pg_temp.st(pg_temp.insq('identity.feature_flags', jsonb_build_object('tenant_id', pg_temp.ta(), 'flag_code', 'referral_incentive_report', 'is_enabled', true, 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()))),
  'ok', 'flag without founder approval enabled without approval_ref');
SELECT is(pg_temp.msg($$UPDATE identity.feature_flags SET approval_ref = NULL WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001' AND flag_code = 'smart_report_llm'$$),
  'feature_flag_requires_approval', 'removing approval_ref from an enabled founder-approval flag is rejected');
SELECT is(pg_temp.st(pg_temp.insq('identity.feature_flags', jsonb_build_object('tenant_id', pg_temp.ta(), 'flag_code', 'whatsapp_pdf_attachment', 'is_enabled', false, 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()))),
  'ok', 'disabled founder-approval flag needs no approval_ref');

-- ===================================================================================================================================== §11 test 29 (ird_annex_documents scan_state) / 15 (audit_exports path)
SELECT pg_temp.ins('identity.ird_annex_records', jsonb_build_object('id', pg_temp.uid(4001), 'tenant_id', pg_temp.ta(), 'annex_code', 'annex_2', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
CREATE FUNCTION pg_temp.doc(p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE n int := nextval('sq');
BEGIN
  RETURN jsonb_build_object('id', pg_temp.uid(5000 + n), 'tenant_id', pg_temp.ta(), 'record_id', pg_temp.uid(4001), 'object_path', pg_temp.ta()::text || '/annex-' || n || '.pdf',
    'original_filename', 'annex.pdf', 'content_type', 'application/pdf', 'size_bytes', 2000, 'sha256', pg_temp.h32('doc' || n), 'created_by', pg_temp.sys()) || p_over;
END $f$;
SELECT is(pg_temp.st(pg_temp.insq('identity.ird_annex_documents', pg_temp.doc('{"id":"0190c200-0000-7000-8000-000000009002"}'))), 'ok', 'ird_annex_documents: valid document accepted');
SELECT is((SELECT scan_state FROM identity.ird_annex_documents WHERE id = '0190c200-0000-7000-8000-000000009002'), 'pending', 'ird_annex_documents.scan_state default pending');
SELECT is(pg_temp.st(pg_temp.insq('identity.ird_annex_documents', pg_temp.doc('{"scan_state":"maybe"}'))), '23514', 'scan_state accepts only pending/clean/quarantined');
SELECT is(pg_temp.st(pg_temp.insq('identity.ird_annex_documents', pg_temp.doc('{"content_type":"text/html"}'))), '23514', 'ird document content type allow-list');
SELECT is(pg_temp.st(pg_temp.insq('identity.ird_annex_documents', pg_temp.doc('{"size_bytes":15728641}'))), '23514', 'ird document > 15 MiB rejected');
SELECT is(pg_temp.st($$UPDATE identity.ird_annex_documents SET scan_state = 'clean' WHERE id = '0190c200-0000-7000-8000-000000009002'$$), 'ok', 'scan_state UPDATE passes the mutable-column trigger');
SELECT is(pg_temp.msg($$UPDATE identity.ird_annex_documents SET original_filename = 'x.pdf' WHERE id = '0190c200-0000-7000-8000-000000009002'$$), 'immutable_row', 'any other ird_annex_documents column change raises immutable_row');
SELECT is(pg_temp.msg($$UPDATE identity.ird_annex_documents SET sha256 = '\x00' WHERE id = '0190c200-0000-7000-8000-000000009002'$$), 'immutable_row', 'ird_annex_documents.sha256 is immutable');
SELECT is(pg_temp.st(pg_temp.insq('identity.audit_exports', jsonb_build_object('id', pg_temp.uid(6001), 'tenant_id', pg_temp.ta(), 'requested_by_membership_id', '01a1a98a-ac40-7000-8000-00000000a500',
  'source', 'audit_log', 'filters', '{}', 'range_from', now() - interval '2 days', 'range_to', now() - interval '1 day', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()))), 'ok', 'audit_exports: valid queued export accepted');
SELECT is(pg_temp.st(pg_temp.insq('identity.audit_exports', jsonb_build_object('id', pg_temp.uid(6002), 'tenant_id', pg_temp.ta(), 'requested_by_membership_id', '01a1a98a-ac40-7000-8000-00000000a500',
  'source', 'audit_log', 'filters', '{}', 'range_from', now() - interval '2 days', 'range_to', now() - interval '1 day', 'object_path', pg_temp.tb()::text || '/x.csv', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()))),
  '23514', 'audit_exports__path__ck rejects a path outside {tenant_id}/ (08 R26)');
SELECT is(pg_temp.st(pg_temp.insq('identity.audit_exports', jsonb_build_object('id', pg_temp.uid(6003), 'tenant_id', pg_temp.ta(), 'requested_by_membership_id', '01a1a98a-ac40-7000-8000-00000000a500',
  'source', 'audit_log', 'filters', '{}', 'range_from', now() - interval '40 days', 'range_to', now() - interval '1 day', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()))),
  '23514', 'audit_exports__range__ck: range > 31 days rejected');

-- ===================================================================================================================================== §11 test 14 / 18 (core shape rules relied on by identity)
CREATE TEMP TABLE partner_m AS SELECT id FROM core.memberships WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001' AND actor_type = 'partner' ORDER BY id LIMIT 1;
SELECT is((SELECT count(*)::int FROM partner_m), 1, 'fixture: seeded partner membership in tenant A');
-- §11 test 14: scope tables are for `user` memberships only (08 R3)
SELECT is(pg_temp.msg(format($$INSERT INTO core.membership_centres (tenant_id, membership_id, centre_id, created_by) VALUES ('01a1a98a-ac40-7000-8000-00000000a001', %L, '01a1a98a-ac40-7000-8000-00000000a201', %L)$$,
  (SELECT id FROM partner_m), pg_temp.sys())), 'scope_user_only', 'core.membership_centres insert for a partner membership -> scope_user_only');
SELECT is(pg_temp.msg(format($$INSERT INTO core.membership_branches (tenant_id, membership_id, branch_id, created_by) VALUES ('01a1a98a-ac40-7000-8000-00000000a001', %L, '01a1a98a-ac40-7000-8000-00000000a101', %L)$$,
  (SELECT id FROM partner_m), pg_temp.sys())), 'scope_user_only', 'core.membership_branches insert for a partner membership -> scope_user_only');
SELECT is(pg_temp.st(format($$UPDATE core.memberships SET all_centres = true WHERE id = %L$$, (SELECT id FROM partner_m))), '23514', 'all_centres = true on a non-user membership -> CHECK violation');
-- §11 test 18: is_active is GENERATED; a second invite of a user with an invited membership -> unique violation
SELECT is(pg_temp.st($$UPDATE core.memberships SET is_active = false WHERE id = '01a1a98a-ac40-7000-8000-00000000a500'$$), '428C9', 'core.memberships.is_active is generated: write fails');
CREATE TEMP TABLE invited_m AS SELECT id, user_id, actor_type FROM core.memberships WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001' AND status = 'invited' ORDER BY id LIMIT 1;
SELECT is((SELECT count(*)::int FROM invited_m), 1, 'fixture: seeded invited membership in tenant A');
SELECT is(pg_temp.st(format($$INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, all_centres, status, created_by, updated_by) VALUES (%L, '01a1a98a-ac40-7000-8000-00000000a001', %L, %L, false, 'invited', %L, %L)$$,
  pg_temp.uid(7001), (SELECT user_id FROM invited_m), (SELECT actor_type FROM invited_m), pg_temp.sys(), pg_temp.sys())), '23505', 'second invite of the same user while an invited membership exists -> unique violation');

-- ===================================================================================================================================== §11 test 21 (is_platform_actor under FORCE RLS, catalog + behaviour)
-- §11 test 21
SELECT is(c.relforcerowsecurity, true, 'identity.platform_staff has FORCE RLS (asserted from pg_class)') FROM pg_class c WHERE c.oid = 'identity.platform_staff'::regclass;
SELECT is(count(*)::int, 1, 'platform_staff__select__owner_only present') FROM pg_policies WHERE schemaname = 'identity' AND tablename = 'platform_staff' AND policyname = 'platform_staff__select__owner_only';
CREATE FUNCTION pg_temp.pa(p_claims jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
  PERFORM set_config('request.jwt.claims', p_claims::text, true);
  SET LOCAL ROLE lims_app;
  BEGIN SELECT (SELECT app.is_platform_actor())::text INTO r; EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);
  RETURN r;
END $f$;
SELECT is(pg_temp.pa(jsonb_build_object('scope', 'platform', 'aal', 'aal2', 'platform_staff_id', pg_temp.uid(1), 'sub', pg_temp.uid(101), 'actor_type', 'user')), 'true', 'is_platform_actor: active staff, aal2, scope platform -> true');
SELECT is(pg_temp.pa(jsonb_build_object('scope', 'platform', 'aal', 'aal1', 'platform_staff_id', pg_temp.uid(1), 'sub', pg_temp.uid(101), 'actor_type', 'user')), 'false', 'is_platform_actor: aal1 -> false');
SELECT is(pg_temp.pa(jsonb_build_object('scope', 'tenant', 'aal', 'aal2', 'platform_staff_id', pg_temp.uid(1), 'sub', pg_temp.uid(101), 'actor_type', 'user')), 'false', 'is_platform_actor: scope tenant -> false');
SELECT is(pg_temp.pa(jsonb_build_object('scope', 'platform', 'aal', 'aal2', 'platform_staff_id', pg_temp.uid(99), 'sub', pg_temp.uid(101), 'actor_type', 'user')), 'false', 'is_platform_actor: unknown staff id -> false');
UPDATE identity.platform_staff SET is_active = false WHERE id = pg_temp.uid(1);
SELECT is(pg_temp.pa(jsonb_build_object('scope', 'platform', 'aal', 'aal2', 'platform_staff_id', pg_temp.uid(1), 'sub', pg_temp.uid(101), 'actor_type', 'user')), 'false', 'is_platform_actor: inactive staff -> false');
UPDATE identity.platform_staff SET is_active = true WHERE id = pg_temp.uid(1);

SELECT * FROM finish();
ROLLBACK;
