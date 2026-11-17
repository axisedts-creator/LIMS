-- T0B-08 roles suite, catalog part (AC-0B-1.1, AC-0B-1.2 ownership half, 05-SCHEMA §2, §10 schema test 30; 02-TRD §4.5 fixed suite "roles").
-- Complements 00_bootstrap_roles.test.sql (role flags, memberships). Read-only catalog checks; no data written.
-- Run on a bootstrapped + migrated test DB as superuser:  pg_prove -d <db> db/tests/roles/T0B-08_roles.test.sql   (pgTAP in schema `extensions`)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

-- AC-0B-1.1 (verbatim query of the AC)
SELECT is_empty($$SELECT rolname FROM pg_roles WHERE rolname LIKE 'lims\_%' AND (rolbypassrls OR rolsuper)$$,
  'AC-0B-1.1 no lims_% role has rolsuper or rolbypassrls');

-- AC-0B-1.2: every relation in every module schema is owned by lims_owner; lims_owner cannot log in
SELECT is(rolcanlogin, false, 'AC-0B-1.2 lims_owner rolcanlogin = false') FROM pg_roles WHERE rolname = 'lims_owner';
SELECT is_empty($$
  SELECT n.nspname || '.' || c.relname || ' (' || pg_get_userbyid(c.relowner) || ')'
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('app','core','audit','identity','catalog','frontdesk','billing','lab','instruments','reporting','analytics','quality',
                       'micro','anatomic','inventory','partners','smartreport','payments','engagement','homecollection','migration_staging','api')
     AND c.relkind IN ('r','p','v','m','S','f')
     AND pg_get_userbyid(c.relowner) <> 'lims_owner'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('i','a') AND d.classid = 'pg_class'::regclass)   -- sequences owned by columns follow the table
$$, 'AC-0B-1.2 every table/view/sequence in a module schema is owned by lims_owner');

-- module schemas themselves belong to lims_owner (05-SCHEMA §2); graphile_worker to lims_queue; migrations_meta to lims_migrator
SELECT is_empty($$
  SELECT nspname FROM pg_namespace
   WHERE nspname IN ('app','core','audit','identity','catalog','frontdesk','billing','lab','instruments','reporting','analytics','quality',
                     'micro','anatomic','inventory','partners','smartreport','payments','engagement','homecollection','migration_staging','api')
     AND pg_get_userbyid(nspowner) <> 'lims_owner'
$$, '05-SCHEMA §2 every module schema is owned by lims_owner');
SELECT is(pg_get_userbyid(nspowner)::text, 'lims_queue', 'graphile_worker is owned by lims_queue (when installed)')
  FROM pg_namespace WHERE nspname = 'graphile_worker';

-- every function in app is owned by lims_owner, except the documented lims_queue / lims_reporting_lookup ones (D-201 window)
SELECT is_empty($$
  SELECT p.oid::regprocedure::text || ' (' || pg_get_userbyid(p.proowner) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app' AND pg_get_userbyid(p.proowner) NOT IN ('lims_owner','lims_queue','lims_reporting_lookup')
$$, 'functions in schema app are owned by lims_owner / lims_queue / lims_reporting_lookup only');

-- schema test 30 (08 A25 D-201): no standing CREATE
SELECT is(has_database_privilege(r, current_database(), 'CREATE'), false, 'schema test 30: ' || r || ' has no CREATE on the database')
  FROM unnest(ARRAY['lims_worker','lims_api','lims_queue','lims_reporting_lookup']) r;
SELECT is(has_schema_privilege(r, 'app', 'CREATE'), false, 'schema test 30: ' || r || ' has no CREATE on schema app')
  FROM unnest(ARRAY['lims_worker','lims_api','lims_queue','lims_reporting_lookup']) r;

-- the API/worker logins must not have any module-schema CREATE either
SELECT is(has_schema_privilege(r, s, 'CREATE'), false, 'schema test 30: ' || r || ' cannot CREATE in ' || s)
  FROM unnest(ARRAY['lims_api','lims_worker','lims_app']) r, unnest(ARRAY['core','audit','identity','lab','billing','api']) s
 WHERE to_regnamespace(s) IS NOT NULL;

-- Supabase-served roles get nothing on module schemas (IC X9; 02-TRD §4.4)
SELECT is(has_schema_privilege(r, s, 'USAGE'), false, r || ' has no USAGE on ' || s)
  FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['app','core','audit','identity','lab']) s
 WHERE to_regnamespace(s) IS NOT NULL;   -- anon / authenticated exist in the pinned supabase/postgres image (SP-3)

-- executing as lims_api / lims_worker: cannot become the owner (privilege escalation probes)
CREATE FUNCTION pg_temp.set_role_fails(p_from text, p_to text) RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN
  -- SET ROLE is checked against the SESSION user, so SET ROLE alone would test as the superuser; switch the session user first
  EXECUTE format('SET LOCAL SESSION AUTHORIZATION %I', p_from);
  BEGIN EXECUTE format('SET LOCAL ROLE %I', p_to); RESET SESSION AUTHORIZATION; RETURN false;
  EXCEPTION WHEN insufficient_privilege THEN RESET SESSION AUTHORIZATION; RETURN true; END;
END $f$;
SELECT is(pg_temp.set_role_fails('lims_api', r), true, 'lims_api cannot SET ROLE ' || r)
  FROM unnest(ARRAY['lims_owner','lims_queue','lims_reporting_lookup','lims_migrator']) r;
SELECT is(pg_temp.set_role_fails('lims_worker', r), true, 'lims_worker cannot SET ROLE ' || r)
  FROM unnest(ARRAY['lims_owner','lims_reporting_lookup','lims_migrator']) r;

SELECT * FROM finish();
ROLLBACK;
