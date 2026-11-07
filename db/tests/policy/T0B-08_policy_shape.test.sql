-- T0B-08 policy-shape suite (AC-0B-2.1, AC-0B-2.2; 05-SCHEMA §6, §10 schema tests 15 (last sentence), 17 (catalog), 24 (pg_policies half), 26; 08 A16.1, A17 P-16;
-- 02-TRD §4.5 fixed suite "policy shape (AC-0B-2.2)"). Reads pg_class / pg_policies only, except schema test 26 which runs one CREATE POLICY on a
-- stand-in that has ENABLE + FORCE RLS. AC-0B-2.3 (db/policies diff) is db/tools/policy-dump.ts in CI, not here.
-- Run from the repo root (\i and \copy resolve against the cwd): pg_prove -d <db> db/tests/policy/T0B-08_policy_shape.test.sql   (superuser)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\i db/tests/isolation/_registry.sql

CREATE TEMP TABLE module_schemas(s) AS VALUES ('core'),('audit'),('identity'),('catalog'),('frontdesk'),('billing'),('lab'),('instruments'),('reporting'),
  ('analytics'),('quality'),('micro'),('anatomic'),('inventory'),('partners'),('smartreport'),('payments'),('engagement'),('homecollection');
CREATE TEMP VIEW mod_policies AS
  SELECT p.* FROM pg_policies p WHERE p.schemaname IN (SELECT s FROM module_schemas);

-- ---------- AC-0B-2.1: tables lacking RLS or FORCE RLS == db/tests/rls_exempt.txt exactly; every entry has a reason ----------
CREATE TEMP TABLE rls_exempt_raw(line text);
\copy rls_exempt_raw FROM 'db/tests/rls_exempt.txt' WITH (FORMAT csv, DELIMITER '|', QUOTE '~')
-- strip a trailing CR (Windows checkout): btrim() does not remove \r
CREATE TEMP TABLE rls_exempt_file AS
  SELECT (regexp_match(l, '^(\S+)\s+(.+)$'))[1] AS tbl, (regexp_match(l, '^(\S+)\s+(.+)$'))[2] AS reason
    FROM (SELECT btrim(regexp_replace(line, '\r$', '')) AS l FROM rls_exempt_raw) s WHERE l <> '' AND l !~ '^#';
SELECT set_eq($$
  SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r','p') AND n.nspname IN (SELECT s FROM module_schemas) AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
$$, $$SELECT tbl FROM rls_exempt_file$$, 'AC-0B-2.1 tables without ENABLE+FORCE RLS equal db/tests/rls_exempt.txt');
SELECT is_empty($$SELECT tbl FROM rls_exempt_file WHERE reason IS NULL OR length(btrim(reason)) < 5$$, 'AC-0B-2.1 every rls_exempt.txt entry has a reason');
SELECT is_empty($$SELECT tbl FROM rls_exempt_file WHERE tbl !~ '^[a-z_]+\.[a-z_0-9]+$'$$, 'AC-0B-2.1 every rls_exempt.txt entry is schema.table');
-- the registry marks exactly these tables rls_exempt (no silent exemption on either side)
SELECT set_eq($$SELECT tbl FROM registry WHERE rls_exempt$$, $$SELECT tbl FROM rls_exempt_file WHERE to_regclass(tbl) IS NOT NULL$$,
  'rls_exempt in tables.yaml equals rls_exempt.txt (for tables that exist)');
-- relforcerowsecurity on every registered, non-exempt table (FORCE applies to the owner; 08 A10.5)
SELECT is(c.relrowsecurity AND c.relforcerowsecurity, true, g.tbl || ' has ENABLE + FORCE ROW LEVEL SECURITY')
  FROM registry g JOIN pg_class c ON c.oid = to_regclass(g.tbl) WHERE NOT g.rls_exempt;

-- ---------- AC-0B-2.2: policy shape ----------
SELECT is_empty($$SELECT schemaname || '.' || tablename || ' ' || policyname FROM mod_policies WHERE roles && ARRAY['public','anon','authenticated']::name[]$$,
  'AC-0B-2.2 no module policy applies to public, anon or authenticated');
SELECT is_empty($$SELECT schemaname || '.' || tablename || ' ' || policyname FROM mod_policies
   WHERE (btrim(coalesce(qual,''), '() ') = 'true' OR btrim(coalesce(with_check,''), '() ') = 'true')
     AND NOT (schemaname = 'identity' AND policyname = 'platform_staff__select__owner_only' AND roles = ARRAY['lims_owner']::name[])$$,
  'AC-0B-2.2 no policy has qual or with_check = true (single exception identity.platform_staff__select__owner_only, 08 A10.5)');
SELECT is_empty($$SELECT schemaname || '.' || tablename || ' ' || policyname FROM mod_policies
   WHERE policyname !~ ('^' || tablename || '__(select|insert|update|delete|all)__[a-z][a-z_]*$')
      OR split_part(substr(policyname, length(tablename) + 3), '__', 1) <> lower(cmd)$$,
  'AC-0B-2.2 every policy name is <table>__<command>__<scope> and its command matches the policy command');
SELECT is_empty($$SELECT schemaname || '.' || tablename || ' ' || policyname FROM mod_policies
   WHERE policyname LIKE '%\_\_owner\_only' AND roles <> ARRAY['lims_owner']::name[]$$, 'every *__owner_only policy is TO lims_owner only');
SELECT is_empty($$SELECT schemaname || '.' || tablename || ' ' || policyname FROM mod_policies
   WHERE policyname NOT LIKE '%\_\_owner\_only' AND NOT (roles <@ ARRAY['lims_app','lims_api','lims_worker']::name[])$$,
  'every other policy is TO lims_app / lims_api / lims_worker only (never lims_owner, never PUBLIC)');
SELECT is_empty($$SELECT schemaname || '.' || tablename || ' ' || policyname FROM mod_policies WHERE permissive <> 'PERMISSIVE'$$,
  'no RESTRICTIVE policies (the staff guard is part of each policy text, 08 A17 P-16)');

-- ---------- schema test 17: GUC-bound owner policies are TO lims_owner only ----------
SELECT is(roles, ARRAY['lims_owner']::name[], 'schema test 17: ' || tablename || '.' || policyname || ' is TO lims_owner')
  FROM pg_policies WHERE schemaname = 'core' AND policyname IN ('memberships__select__owner_only','users__select__owner_only','tenants__select__owner_only',
                                                                 'roles__select__owner_only','membership_roles__select__owner_only');
SELECT is(count(*)::int, 5, 'schema test 17: the five core GUC-bound owner policies exist')
  FROM pg_policies WHERE schemaname = 'core' AND policyname IN ('memberships__select__owner_only','users__select__owner_only','tenants__select__owner_only',
                                                                 'roles__select__owner_only','membership_roles__select__owner_only');
SELECT is_empty($$SELECT schemaname || '.' || tablename || ' ' || policyname FROM pg_policies
   WHERE (qual ~ 'app\.pre_|app\.maintenance' OR with_check ~ 'app\.pre_|app\.maintenance') AND roles <> ARRAY['lims_owner']::name[]$$,
  'schema test 17: every policy whose qual or with_check mentions app.pre_ or app.maintenance is TO lims_owner only (08 A12.7)');

-- ---------- schema test 15 (last sentence): owner policies on the purge tables AND the expiry predicate with app.maintenance ----------
SELECT is_empty($$SELECT schemaname || '.' || tablename || ' ' || policyname FROM pg_policies
   WHERE schemaname = 'core' AND tablename IN ('event_log','idempotency_keys','dead_letters') AND roles = ARRAY['lims_owner']::name[]
     AND cmd IN ('SELECT','DELETE') AND policyname LIKE '%\_\_owner\_only'
     AND coalesce(qual,'') !~ 'current_setting\(''app\.maintenance''::text, true\)'$$,
  'schema test 15: purge-table owner policies carry current_setting(''app.maintenance'', true) in their predicate');
SELECT is_empty($$SELECT n.nspname || '.event_inbox ' || p.policyname FROM pg_policies p JOIN pg_namespace n ON n.nspname = p.schemaname
   WHERE p.tablename = 'event_inbox' AND p.roles = ARRAY['lims_owner']::name[] AND p.cmd IN ('SELECT','DELETE')
     AND coalesce(p.qual,'') !~ 'current_setting\(''app\.maintenance''::text, true\)'$$,
  'schema test 15: event_inbox owner policies carry current_setting(''app.maintenance'', true)');

-- ---------- schema test 24 (pg_policies half; 08 A17 P-16, A23.3) ----------
SELECT is_empty($$SELECT schemaname || '.' || tablename || ' ' || policyname FROM mod_policies
   WHERE policyname ~ '__(tenant|tenant_centre)$'
     AND ((cmd IN ('SELECT','DELETE','UPDATE','ALL') AND coalesce(qual,'') !~ 'is_staff_or_system')
       OR (cmd IN ('INSERT','UPDATE','ALL') AND coalesce(with_check,'') !~ 'is_staff_or_system'))$$,
  'schema test 24: every __tenant / __tenant_centre policy has is_staff_or_system in USING and WITH CHECK');
SELECT is_empty($$SELECT p.schemaname || '.' || p.tablename || ' ' || p.policyname FROM mod_policies p
   WHERE p.policyname ~ '__(partner|portal|patient)$'
     AND NOT EXISTS (SELECT 1 FROM registry g WHERE g.tbl = p.schemaname || '.' || p.tablename
                        AND substring(p.policyname from '__(partner|portal|patient)$') = ANY (g.shared_with))$$,
  'schema test 24: __partner / __portal / __patient policies exist only on tables whose shared_with lists that actor');
SELECT is_empty($$SELECT g.tbl || ' ' || a FROM registry g, unnest(g.shared_with) a
   WHERE to_regclass(g.tbl) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname || '.' || p.tablename = g.tbl AND p.policyname LIKE '%\_\_' || a)$$,
  'a shared_with table has an actor policy for every listed actor');
SELECT is_empty($$SELECT p.schemaname || '.' || p.tablename || ' ' || p.policyname FROM mod_policies p
   WHERE p.policyname ~ '__(partner|portal|patient)$' AND p.cmd NOT IN ('INSERT','SELECT','UPDATE','DELETE')$$, 'actor policies use a concrete command');

-- ---------- schema test 26 (08 A16.1): centre predicate is cast ----------
SELECT is_empty($$SELECT schemaname || '.' || tablename || ' ' || policyname FROM pg_policies
   WHERE (qual ~ 'current_centre_ids\(\)' AND qual !~ '::uuid\[\]') OR (with_check ~ 'current_centre_ids\(\)' AND with_check !~ '::uuid\[\]')$$,
  'schema test 26: every policy that mentions current_centre_ids() casts it ::uuid[]');
SET LOCAL ROLE lims_owner;
CREATE TABLE core.t0b08_centre (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, centre_id uuid NOT NULL);
ALTER TABLE core.t0b08_centre ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.t0b08_centre FORCE ROW LEVEL SECURITY;
RESET ROLE;   -- pgTAP functions live in `extensions`, which lims_owner cannot use; CREATE POLICY parses the same way for any role
SELECT throws_ok($$CREATE POLICY t0b08_centre__select__tenant_centre ON core.t0b08_centre FOR SELECT TO lims_app
    USING (centre_id = ANY ((SELECT app.current_centre_ids())))$$, '42883', NULL, 'schema test 26: the uncast form is rejected (uuid = uuid[])');
SELECT lives_ok($$CREATE POLICY t0b08_centre__select__tenant_centre ON core.t0b08_centre FOR SELECT TO lims_app
    USING (centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))$$, 'schema test 26: the cast form is accepted');

SELECT * FROM finish();
ROLLBACK;
