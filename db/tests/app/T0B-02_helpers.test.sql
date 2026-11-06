-- T0B-02 live-DB assertions (pgTAP; 05-SCHEMA §2, §4.5, §10 schema test 21; 08 A15.6, A20.2, A30.1; AC-0B-6.1).
-- Run on a bootstrapped + migrated test DB as superuser:  pg_prove -d <db> db/tests/app/T0B-02_helpers.test.sql
-- pgTAP lives in schema `extensions` (test DBs only). No RLS is disabled here; identity.platform_staff is not yet created
-- by T0B-02, so is_platform_actor() behaviour under FORCE RLS is C2 test 21 (T0B-06) and is NOT asserted here.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

-- ---------- schemas: existence, owner, USAGE matrix
SELECT is((SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = s), 'lims_owner', s || ' owned by lims_owner')
  FROM unnest(ARRAY['app','core','audit','identity','catalog','frontdesk','billing','lab','instruments','reporting','analytics',
    'quality','micro','anatomic','inventory','partners','smartreport','payments','engagement','homecollection','migration_staging','api']) s;
SELECT is((SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'graphile_worker'), 'lims_queue', 'graphile_worker owned by lims_queue')
  WHERE EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'graphile_worker');   -- installed by SP-2 runner step, may be absent here
SELECT is(has_schema_privilege('lims_app', s, 'USAGE'), true, 'lims_app USAGE ' || s)
  FROM unnest(ARRAY['app','core','audit','identity','catalog','frontdesk','billing','lab','instruments','reporting','analytics',
    'quality','micro','anatomic','inventory','partners','smartreport','payments','engagement','homecollection']) s;
SELECT is(has_schema_privilege('lims_app', s, 'USAGE'), false, 'lims_app NO usage ' || s)
  FROM unnest(ARRAY['migration_staging','api']) s;
SELECT is(has_schema_privilege('lims_queue', 'app', 'USAGE') AND has_schema_privilege('lims_queue', 'core', 'USAGE'), true, 'lims_queue USAGE app, core');
SELECT is(has_schema_privilege('lims_queue', 'audit', 'USAGE'), false, 'lims_queue no USAGE audit');
SELECT is(has_schema_privilege('lims_reporting_lookup', 'app', 'USAGE'), true, 'lims_reporting_lookup USAGE app');
SELECT is(has_schema_privilege('lims_reporting_lookup', 'core', 'USAGE'), false, 'lims_reporting_lookup no USAGE core');
SELECT is(has_schema_privilege('lims_analytics', 'app', 'USAGE'), false, 'lims_analytics no USAGE app');
SELECT is(has_schema_privilege('lims_analytics', 'catalog', 'USAGE'), true, 'lims_analytics USAGE catalog');
SELECT is(has_schema_privilege('lims_api', 'app', 'USAGE'), true, 'lims_api reaches app through lims_app membership');

-- PUBLIC + standing CREATE (schema test 30 / D-201)
SELECT is_empty($$SELECT n.nspname FROM pg_namespace n, aclexplode(n.nspacl) a
  WHERE a.grantee = 0 AND n.nspname IN ('app','core','audit','identity','catalog','frontdesk','billing','lab','instruments','reporting',
    'analytics','quality','micro','anatomic','inventory','partners','smartreport','payments','engagement','homecollection','migration_staging','api')$$,
  'PUBLIC has no privilege on any module schema');
SELECT is_empty($$SELECT n.nspname || ' -> ' || r.rolname FROM pg_namespace n, pg_roles r
  WHERE r.rolname IN ('lims_app','lims_api','lims_worker','lims_queue','lims_reporting_lookup','lims_analytics','lims_migrator')
    AND n.nspname IN ('app','core','audit','identity','reporting','migration_staging','api') AND has_schema_privilege(r.rolname, n.nspname, 'CREATE')$$,
  'no non-owner role holds standing CREATE on app/core/audit/module schemas');
SELECT is(has_schema_privilege('supabase_auth_admin', 'app', 'USAGE'), false, 'supabase_auth_admin has no privilege on app')
  WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin');

-- ---------- default privileges: set by lims_owner, lims_queue, lims_reporting_lookup themselves
SELECT ok(EXISTS (SELECT 1 FROM pg_default_acl d WHERE d.defaclrole = 'lims_owner'::regrole AND d.defaclobjtype = 'f'
  AND NOT EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = 0)),
  'lims_owner default ACL for functions has no PUBLIC EXECUTE');
SELECT ok(EXISTS (SELECT 1 FROM pg_default_acl d WHERE d.defaclrole = 'lims_owner'::regrole AND d.defaclobjtype = 'r'
  AND NOT EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = 0)),
  'lims_owner default ACL for tables has no PUBLIC rights');
SELECT ok(EXISTS (SELECT 1 FROM pg_default_acl d WHERE d.defaclrole = r::regrole AND d.defaclobjtype = 'f'
  AND NOT EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = 0)),
  r || ' default ACL for functions has no PUBLIC EXECUTE (set by the role itself)')
  FROM unnest(ARRAY['lims_queue','lims_reporting_lookup']) r;

-- ---------- app.is_platform_actor() (schema test 21)
SELECT has_function('app', 'is_platform_actor', ARRAY[]::name[], 'app.is_platform_actor() exists');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'app.is_platform_actor()'::regprocedure), true, 'is_platform_actor SECURITY DEFINER');
SELECT is((SELECT proowner::regrole::text FROM pg_proc WHERE oid = 'app.is_platform_actor()'::regprocedure), 'lims_owner', 'is_platform_actor owned by lims_owner');
SELECT ok((SELECT proconfig::text FROM pg_proc WHERE oid = 'app.is_platform_actor()'::regprocedure) LIKE '%search_path=%', 'is_platform_actor pins search_path');
SELECT is(has_function_privilege(r, 'app.is_platform_actor()', 'EXECUTE'), true, r || ' may EXECUTE is_platform_actor')
  FROM unnest(ARRAY['lims_app','lims_api','lims_worker']) r;
SELECT is(has_function_privilege(r, 'app.is_platform_actor()', 'EXECUTE'), false, r || ' may NOT EXECUTE is_platform_actor')
  FROM unnest(ARRAY['lims_analytics','lims_monitor','lims_replicator','lims_audit_ship']) r;
SELECT is_empty($$SELECT a.grantee FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = 'app.is_platform_actor()'::regprocedure AND a.grantee = 0$$,
  'PUBLIC has no EXECUTE on is_platform_actor');
SELECT is((SELECT proacl IS NOT NULL FROM pg_proc WHERE oid = 'app.is_platform_actor()'::regprocedure), true, 'is_platform_actor has an explicit ACL');

-- ---------- policy helpers: DEFINER/INVOKER, owner, PUBLIC revoked, lims_app granted
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = sig::regprocedure), definer, sig || ' prosecdef = ' || definer)
  FROM (VALUES ('app.current_partner_id()', true), ('app.engagement_preauth_stage()', false), ('app.engagement_account_id()', true),
              ('app.engagement_patient_ids()', true), ('app.engagement_patient_visible(uuid,timestamptz)', true)) v(sig, definer);
SELECT is(has_function_privilege('lims_app', sig, 'EXECUTE'), true, 'lims_app EXECUTE ' || sig)
  FROM unnest(ARRAY['app.current_partner_id()','app.engagement_preauth_stage()','app.engagement_account_id()',
    'app.engagement_patient_ids()','app.engagement_patient_visible(uuid,timestamptz)','app.current_lims_session_id()']) sig;
SELECT is(has_function_privilege('lims_api', 'app.current_lims_session_id()', 'EXECUTE'), true, 'lims_api EXECUTE current_lims_session_id');
SELECT is(has_function_privilege('lims_worker', 'app.current_lims_session_id()', 'EXECUTE'), true, 'lims_worker EXECUTE current_lims_session_id');
SELECT is_empty($$SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  WHERE n.nspname = 'app' AND p.proname IN ('current_partner_id','engagement_preauth_stage','engagement_account_id','engagement_patient_ids',
    'engagement_patient_visible','is_platform_actor') AND a.grantee = 0$$, 'PUBLIC has no EXECUTE on the DEFINER / policy helpers');
SELECT is((SELECT proowner::regrole::text FROM pg_proc WHERE oid = sig::regprocedure), 'lims_owner', sig || ' owned by lims_owner')
  FROM unnest(ARRAY['app.current_partner_id()','app.engagement_account_id()','app.engagement_patient_ids()','app.uuidv7()']) sig;
SELECT ok((SELECT proconfig::text FROM pg_proc WHERE oid = sig::regprocedure) LIKE '%search_path=%', sig || ' pins search_path')
  FROM unnest(ARRAY['app.current_partner_id()','app.engagement_account_id()','app.engagement_patient_ids()',
    'app.engagement_patient_visible(uuid,timestamptz)']) sig;

-- helpers behave on empty / absent claims (fail-closed, never error)
SET LOCAL request.jwt.claims = '';
SELECT is(app.current_tenant_id(), NULL::uuid, 'no claims -> tenant_id NULL');
SELECT is(app.current_lims_session_id(), NULL::uuid, 'no claims -> lims_session_id NULL');
SELECT is(app.is_staff_or_system(), false, 'no claims -> is_staff_or_system false (not NULL)');
SELECT is(app.engagement_preauth_stage(), NULL::text, 'no claims -> preauth stage NULL');
SET LOCAL request.jwt.claims = '{"actor_type":"user","tenant_id":"01900000-0000-7000-8000-000000000001","lims_session_id":"01900000-0000-7000-8000-000000000002"}';
SELECT is(app.current_tenant_id(), '01900000-0000-7000-8000-000000000001'::uuid, 'tenant_id read from claims');
SELECT is(app.current_lims_session_id(), '01900000-0000-7000-8000-000000000002'::uuid, 'lims_session_id read from claims');
SELECT is(app.is_staff_or_system(), true, 'user -> staff');
SET LOCAL request.jwt.claims = '{"actor_type":"patient","tenant_id":"01900000-0000-7000-8000-000000000001","patient_stage":"otp"}';
SELECT is(app.is_staff_or_system(), false, 'patient -> not staff');
SELECT is(app.engagement_preauth_stage(), 'otp', 'patient_stage read from claims');
SET LOCAL request.jwt.claims = '{"actor_type":"partner"}';
SELECT is(app.is_staff_or_system(), false, 'partner -> not staff');
SET LOCAL request.jwt.claims = '';

-- ---------- app.uuidv7() golden (IC §2.1 Uuidv7 regex; timestamp window)
SELECT matches(app.uuidv7()::text, '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', 'uuidv7 matches IC §2.1 Uuidv7 regex');
SELECT is(count(*)::int, 0, 'uuidv7: 1000 values all match the Uuidv7 regex')
  FROM (SELECT app.uuidv7()::text u FROM generate_series(1, 1000)) t
  WHERE u !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
SELECT is(count(DISTINCT u)::int, 1000, 'uuidv7: 1000 values are distinct') FROM (SELECT app.uuidv7() u FROM generate_series(1, 1000)) t;
SELECT ok(abs(extract(epoch FROM clock_timestamp()) * 1000
              - ('x' || substr(replace(app.uuidv7()::text, '-', ''), 1, 12))::bit(48)::bigint) <= 5,
  'uuidv7 48-bit ms prefix within +-5 ms of clock_timestamp()');
SELECT ok((SELECT array_agg(u) = array_agg(u ORDER BY substr(u::text, 1, 13)) FROM (SELECT app.uuidv7() u FROM generate_series(1, 200)) t),
  'uuidv7 timestamp prefix is non-decreasing across successive calls');
SELECT is(substr(app.uuidv7()::text, 15, 1), '7', 'version nibble = 7');
SELECT ok(substr(app.uuidv7()::text, 20, 1) IN ('8','9','a','b'), 'variant bits = 10');
SELECT is((SELECT provolatile FROM pg_proc WHERE oid = 'app.uuidv7()'::regprocedure), 'v', 'uuidv7 is VOLATILE');
SELECT is((SELECT prosecdef FROM pg_proc WHERE oid = 'app.uuidv7()'::regprocedure), false, 'uuidv7 is SECURITY INVOKER');

SELECT * FROM finish();
ROLLBACK;
