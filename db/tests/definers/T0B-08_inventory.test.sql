-- T0B-08 DEFINER inventory suite (REQ-SEC-019, REQ-SEC-020; AC-0B-2.4 first half; 05-SCHEMA §4.3 owner-policy rule; 02-TRD §4.5):
--   * the set of SECURITY DEFINER functions in module schemas equals db/meta/definer-inventory.yaml (a new DEFINER cannot sneak in);
--   * every one has owner lims_owner (or the inventory's owner) and proconfig search_path = '';
--   * EXECUTE grants equal the inventory's `execute` list (effective, through role inheritance), PUBLIC/anon/authenticated none;
--   * every FORCE-RLS table an inventory row touches has relforcerowsecurity = true and an owner policy TO lims_owner admitting the touched command.
-- Behaviour (non-empty results with FORCE RLS on, GUC reset, direct-GUC probes) is in the T0B-08_contracts_*.test.sql files of this directory.
-- Run from the repo root: pg_prove -d <db> db/tests/definers/T0B-08_inventory.test.sql   (superuser; pgTAP in schema `extensions`)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\i db/tests/isolation/_registry.sql

CREATE TEMP TABLE module_schemas(s) AS VALUES ('app'),('core'),('audit'),('identity'),('catalog'),('frontdesk'),('billing'),('lab'),('instruments'),('reporting'),
  ('analytics'),('quality'),('micro'),('anatomic'),('inventory'),('partners'),('smartreport'),('payments'),('engagement'),('homecollection'),('migration_staging'),('api');

-- ---------- REQ-SEC-020: inventory equality ----------
SELECT set_eq($$SELECT n.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE p.prosecdef AND n.nspname IN (SELECT s FROM module_schemas)$$,
              $$SELECT fn FROM definer_inventory$$,
  'REQ-SEC-020 SECURITY DEFINER functions in module schemas == db/meta/definer-inventory.yaml');

-- ---------- REQ-SEC-019: search_path = '' on every DEFINER ----------
SELECT is_empty($$SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE p.prosecdef AND n.nspname IN (SELECT s FROM module_schemas) AND NOT coalesce(p.proconfig @> ARRAY['search_path=""'], false)$$,
  'REQ-SEC-019 every DEFINER has proconfig search_path = ''''');
-- ... and no DEFINER's search_path config contains anything else that could reroute name lookup
SELECT is_empty($$SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE p.prosecdef AND n.nspname IN (SELECT s FROM module_schemas)
                     AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%' AND c <> 'search_path=""')$$, 'no DEFINER carries a non-empty search_path');

-- ---------- owner ----------
SELECT is_empty($$SELECT p.oid::regprocedure::text || ' owner ' || pg_get_userbyid(p.proowner) || ' <> ' || i.owner
                    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN definer_inventory i ON i.fn = n.nspname || '.' || p.proname
                   WHERE p.prosecdef AND pg_get_userbyid(p.proowner) <> i.owner$$, 'every DEFINER is owned by the role its inventory row names');
SELECT is_empty($$SELECT p.oid::regprocedure::text || ' owner ' || pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE p.prosecdef AND n.nspname IN (SELECT s FROM module_schemas)
                     AND pg_get_userbyid(p.proowner) NOT IN ('lims_owner','lims_queue','lims_reporting_lookup')$$,
  'no DEFINER is owned by a login, a superuser or an image role');
SELECT is_empty($$SELECT fn FROM definer_inventory WHERE owner NOT IN ('lims_owner','lims_queue','lims_reporting_lookup')$$, 'inventory owners are lims_owner / lims_queue / lims_reporting_lookup');

-- ---------- EXECUTE grants == inventory `execute` (effective, through inheritance) ----------
CREATE TEMP TABLE probe_roles(r) AS VALUES ('lims_app'),('lims_api'),('lims_worker'),('lims_queue'),('lims_reporting_lookup'),('lims_analytics'),('anon'),('authenticated');
CREATE TEMP TABLE expected_exec AS
  SELECT p.oid AS fn_oid, p.oid::regprocedure::text AS sig, r.r,
         (r.r = ANY (i.execute_roles) OR EXISTS (SELECT 1 FROM unnest(i.execute_roles) g WHERE g <> r.r AND pg_has_role(r.r, g, 'USAGE'))) AS expected
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN definer_inventory i ON i.fn = n.nspname || '.' || p.proname, probe_roles r
   WHERE p.prosecdef;
SELECT is(has_function_privilege(e.r, e.fn_oid, 'EXECUTE'), e.expected, e.sig || ': EXECUTE for ' || e.r || ' is ' || e.expected || ' per the inventory')
  FROM expected_exec e;
SELECT is_empty($$SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE p.prosecdef AND n.nspname IN (SELECT s FROM module_schemas) AND has_function_privilege('public', p.oid, 'EXECUTE')$$,
  'PUBLIC has no EXECUTE on any DEFINER');

-- ---------- AC-0B-2.4 first half: every touched FORCE-RLS table has FORCE on and an owner policy for the touched command ----------
CREATE TEMP TABLE touched AS
  SELECT DISTINCT i.fn, m[1] AS tbl, upper(m[2]) AS cmd
    FROM definer_inventory i, unnest(i.touches) t, LATERAL regexp_match(t, '^([a-z_0-9]+\.[a-z_0-9]+)\s+(SELECT|INSERT|UPDATE|DELETE)\b', 'i') m
   WHERE m IS NOT NULL;
SELECT is(c.relforcerowsecurity, true, 'AC-0B-2.4 ' || t.fn || ': ' || t.tbl || ' has relforcerowsecurity = true')
  FROM touched t JOIN pg_class c ON c.oid = to_regclass(t.tbl) WHERE NOT EXISTS (SELECT 1 FROM registry g WHERE g.tbl = t.tbl AND g.rls_exempt);
SELECT ok(EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname || '.' || p.tablename = t.tbl AND p.roles = ARRAY['lims_owner']::name[]
                    AND p.cmd IN (t.cmd, 'ALL') AND p.policyname LIKE '%\_\_owner\_only'),
          'AC-0B-2.4 ' || t.fn || ': ' || t.tbl || ' has a ' || t.cmd || ' owner_only policy TO lims_owner')
  FROM touched t WHERE to_regclass(t.tbl) IS NOT NULL;
-- a DEFINER that touches an RLS-exempt table needs no owner policy; one touching a table that does not exist yet is covered when that table lands
SELECT is_empty($$SELECT fn || ' touches ' || tbl FROM touched t WHERE to_regclass(tbl) IS NULL AND tbl ~ '^(core|audit)\.'$$,
  'DEFINERs touching core/audit tables only name tables that exist');

-- ---------- registry/inventory hygiene ----------
SELECT is_empty($$SELECT fn FROM definer_inventory GROUP BY fn HAVING count(*) > 1$$, 'no duplicate inventory rows');
SELECT is_empty($$SELECT fn FROM definer_inventory WHERE fn !~ '^[a-z_]+\.[a-z_0-9]+$'$$, 'inventory keys are schema.function');

SELECT * FROM finish();
ROLLBACK;
