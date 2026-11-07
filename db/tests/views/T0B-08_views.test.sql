-- T0B-08 view suite (REQ-SEC-031: every view in a module schema has security_invoker = true; 02-TRD §4.5 fixed suite "view security_invoker";
-- 05-SCHEMA §9 rule on v_pub_* views). Catalog-only plus one stand-in view to prove the detector can fail.
-- Run: pg_prove -d <db> db/tests/views/T0B-08_views.test.sql   (pgTAP in schema `extensions`; superuser)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE TEMP TABLE module_schemas(s) AS VALUES ('app'),('core'),('audit'),('identity'),('catalog'),('frontdesk'),('billing'),('lab'),('instruments'),('reporting'),
  ('analytics'),('quality'),('micro'),('anatomic'),('inventory'),('partners'),('smartreport'),('payments'),('engagement'),('homecollection'),('migration_staging'),('api');

-- the predicate under test: relkind 'v' (and 'm' for materialized views, which have no security_invoker and are therefore forbidden in module schemas)
CREATE FUNCTION pg_temp.bad_views() RETURNS SETOF text LANGUAGE sql AS $$
  SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'v' AND n.nspname IN (SELECT s FROM module_schemas)
     AND NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on'], false)
$$;

SELECT is_empty($$SELECT * FROM pg_temp.bad_views()$$, 'REQ-SEC-031 every view in a module schema has security_invoker = true');
SELECT is_empty($$SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'm' AND n.nspname IN (SELECT s FROM module_schemas)$$,
  'no materialized view in a module schema (they run as owner and bypass the caller''s RLS; REQ-SEC-031)');

-- detector self-test: a stand-in view without security_invoker is reported, one with it is not (the stand-in table carries ENABLE + FORCE RLS)
SET LOCAL ROLE lims_owner;
CREATE TABLE core.t0b08_vbase (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
ALTER TABLE core.t0b08_vbase ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.t0b08_vbase FORCE ROW LEVEL SECURITY;
CREATE VIEW core.t0b08_v_plain AS SELECT id, tenant_id FROM core.t0b08_vbase;
CREATE VIEW core.t0b08_v_invoker WITH (security_invoker = true) AS SELECT id, tenant_id FROM core.t0b08_vbase;
RESET ROLE;
SELECT results_eq($$SELECT * FROM pg_temp.bad_views() WHERE bad_views LIKE 'core.t0b08%'$$, $$VALUES ('core.t0b08_v_plain')$$,
  'detector reports the view without security_invoker and only that one');

-- behaviour: a security_invoker view over a FORCE-RLS table shows the caller only its own tenant (the property the option exists for)
SET LOCAL session_replication_role = replica;
INSERT INTO core.t0b08_vbase VALUES ('01900000-0000-7000-8000-000000000011', '01900000-0000-7000-8000-000000000001'),
                                    ('01900000-0000-7000-8000-000000000012', '01900000-0000-7000-8000-000000000002');
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE lims_owner;
CREATE POLICY t0b08_vbase__select__tenant ON core.t0b08_vbase FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT ON core.t0b08_v_invoker TO lims_app;
GRANT SELECT ON core.t0b08_vbase TO lims_app;
RESET ROLE;
CREATE FUNCTION pg_temp.count_as_a() RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('actor_type','user','tenant_id','01900000-0000-7000-8000-000000000001','sub','01900000-0000-7000-8000-000000000099')::text, true);
  SET LOCAL ROLE lims_api;
  SELECT count(*) INTO n FROM core.t0b08_v_invoker;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN n;
END $f$;
SELECT is(pg_temp.count_as_a(), 1::bigint, 'a security_invoker view returns only the caller''s tenant rows under FORCE RLS');

SELECT * FROM finish();
ROLLBACK;
