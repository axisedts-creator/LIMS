-- T0B-08 grants-per-class suite (AC-0B-4.2, AC-0B-4.3, AC-0B-5.3 grant half; 05-SCHEMA §5; 02-TRD §4.4/§4.5 fixed suite "grants per class").
-- Driven by db/meta/tables.yaml through the generated psql include db/tests/isolation/_registry.sql (temp table `registry`), so a table cannot dodge it.
-- Run from the repo root on a bootstrapped + migrated test DB as superuser (psql resolves \i against the cwd):
--   db/tests/run-suites.sh   or   pg_prove -d <db> db/tests/grants/T0B-08_grants.test.sql
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\i db/tests/isolation/_registry.sql

-- registry and catalog agree on which registered tables exist (a registered-but-missing table would silently skip every check below)
SELECT is_empty($$SELECT tbl FROM registry WHERE to_regclass(tbl) IS NULL$$, 'every table in db/meta/tables.yaml exists in the migrated DB');

-- the three application roles: logins and the group role (inheritance means a grant to lims_app reaches lims_api / lims_worker)
CREATE TEMP TABLE app_roles(r) AS VALUES ('lims_app'),('lims_api'),('lims_worker');

-- AC-0B-4.2: no DELETE on class C, B, A for any application role
SELECT is(has_table_privilege(a.r, g.tbl, 'DELETE'), false, 'AC-0B-4.2 ' || a.r || ' has no DELETE on ' || g.tbl || ' (class ' || g.class || ')')
  FROM registry g, app_roles a WHERE g.class IN ('C','B','A') AND to_regclass(g.tbl) IS NOT NULL;

-- AC-0B-4.3: class A, core.event_log and every <m>.event_inbox: no UPDATE for any application role
CREATE TEMP TABLE append_only(tbl) AS
  SELECT tbl FROM registry WHERE class = 'A' AND to_regclass(tbl) IS NOT NULL
  UNION SELECT 'core.event_log' WHERE to_regclass('core.event_log') IS NOT NULL
  UNION SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relname = 'event_inbox' AND c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema');
SELECT is(has_table_privilege(a.r, o.tbl, 'UPDATE'), false, 'AC-0B-4.3 ' || a.r || ' has no UPDATE on ' || o.tbl)
  FROM append_only o, app_roles a;
SELECT is(has_table_privilege(a.r, o.tbl, 'DELETE'), false, 'AC-0B-4.3 ' || a.r || ' has no DELETE on ' || o.tbl)
  FROM append_only o, app_roles a;
SELECT ok(count(*) >= 2, 'AC-0B-4.3 the append-only set contains at least audit.audit_log and audit.access_log') FROM append_only;

-- event_inbox: SELECT + INSERT only (05-SCHEMA §5); audit_log: SELECT only (AC-0B-5.3)
SELECT is(has_table_privilege('lims_app', n.nspname || '.event_inbox', 'INSERT'), true, 'lims_app can INSERT into ' || n.nspname || '.event_inbox')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'event_inbox' AND c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema');
SELECT is(has_table_privilege(a.r, 'audit.audit_log', p), false, 'AC-0B-5.3 ' || a.r || ' has no ' || p || ' on audit.audit_log')
  FROM app_roles a, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p;
SELECT is(has_table_privilege('lims_app', 'audit.audit_log', 'SELECT'), true, 'lims_app can SELECT audit.audit_log');

-- class G: read-only for the application (coded sets / registries are seeded by migrations, never written at runtime)
SELECT is(has_table_privilege(a.r, g.tbl, p), false, a.r || ' has no ' || p || ' on class G table ' || g.tbl)
  FROM registry g, app_roles a, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p WHERE g.class = 'G' AND to_regclass(g.tbl) IS NOT NULL;

-- nothing on any module table is granted to PUBLIC, anon, authenticated; no TRUNCATE / REFERENCES / TRIGGER and no GRANT OPTION for the application
CREATE TEMP TABLE mod_tables(tbl) AS
  SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r','p','v','m') AND n.nspname IN ('app','core','audit','identity','catalog','frontdesk','billing','lab','instruments','reporting',
         'analytics','quality','micro','anatomic','inventory','partners','smartreport','payments','engagement','homecollection','migration_staging','api');
SELECT is_empty($$SELECT m.tbl || ' -> ' || g FROM mod_tables m, unnest(ARRAY['public','anon','authenticated']) g
   WHERE (has_table_privilege(g, m.tbl, 'SELECT') OR has_table_privilege(g, m.tbl, 'INSERT') OR has_table_privilege(g, m.tbl, 'UPDATE')
          OR has_table_privilege(g, m.tbl, 'DELETE') OR has_table_privilege(g, m.tbl, 'TRUNCATE'))$$,
  'PUBLIC, anon and authenticated hold no privilege on any module table (IC X9)');
SELECT is_empty($$SELECT m.tbl || ' -> ' || a.r || ' ' || p FROM mod_tables m, app_roles a, unnest(ARRAY['TRUNCATE','REFERENCES','TRIGGER']) p
   WHERE has_table_privilege(a.r, m.tbl, p)$$, 'application roles hold no TRUNCATE / REFERENCES / TRIGGER on module tables');
SELECT is_empty($$SELECT m.tbl || ' -> ' || a.r FROM mod_tables m, app_roles a
   WHERE has_table_privilege(a.r, m.tbl, 'SELECT WITH GRANT OPTION') OR has_table_privilege(a.r, m.tbl, 'INSERT WITH GRANT OPTION')
      OR has_table_privilege(a.r, m.tbl, 'UPDATE WITH GRANT OPTION') OR has_table_privilege(a.r, m.tbl, 'DELETE WITH GRANT OPTION')$$,
  'application roles hold no GRANT OPTION on module tables');

-- rate_limit_counters: no grants to any app role (reached only through app.ratelimit_hit)
SELECT is(has_table_privilege(a.r, 'core.rate_limit_counters', p), false, a.r || ' has no ' || p || ' on core.rate_limit_counters')
  FROM app_roles a, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p WHERE to_regclass('core.rate_limit_counters') IS NOT NULL;

-- functions in app: PUBLIC holds no EXECUTE (default privileges revoke it; 02-TRD §4.4 "PUBLIC")
SELECT is_empty($$SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app' AND has_function_privilege('public', p.oid, 'EXECUTE')$$, 'PUBLIC has no EXECUTE on any function in schema app');
SELECT is_empty($$SELECT p.oid::regprocedure::text || ' -> ' || g FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, unnest(ARRAY['anon','authenticated']) g
   WHERE n.nspname = 'app' AND has_function_privilege(g, p.oid, 'EXECUTE')$$, 'anon / authenticated have no EXECUTE on any function in schema app');

-- schema USAGE: lims_queue reaches only app and core; lims_analytics no app/core/audit (v_pub_* views only, 05-SCHEMA §2)
SELECT is(has_schema_privilege('lims_queue', s, 'USAGE'), false, 'lims_queue has no USAGE on ' || s)
  FROM unnest(ARRAY['audit','identity','lab','billing']) s WHERE to_regnamespace(s) IS NOT NULL;
SELECT is(has_schema_privilege('lims_analytics', s, 'USAGE'), false, 'lims_analytics has no USAGE on ' || s)
  FROM unnest(ARRAY['app','core','audit']) s;

SELECT * FROM finish();
ROLLBACK;
