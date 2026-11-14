-- T0B-08 immutability suite (AC-0B-4.1; 05-SCHEMA §4.4 + §10 schema test 25; CV §5.7; 02-TRD §4.5 fixed suite "immutability per C/B table").
-- (1) Registry-wide: every class C/B table on which an application role holds UPDATE carries a BEFORE UPDATE row trigger
--     app.enforce_mutable_columns(); (2) behaviour on stand-in class-C tables (owner lims_owner, ENABLE + FORCE RLS, real-shape tenant policies).
-- Run from the repo root: pg_prove -d <db> db/tests/immutability/T0B-08_immutability.test.sql   (pgTAP in schema `extensions`; superuser)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\i db/tests/isolation/_registry.sql

CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-0000000000' || lpad(k, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.as_x(p_role text, p_claims text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := 'n=' || n;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.claims_a() RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type','user','tenant_id',pg_temp.id('01'),'sub',pg_temp.id('99'))::text $$;

-- (1) registry-wide ----------------------------------------------------------------------------------------------------------------------------
SELECT is_empty($$
  SELECT g.tbl FROM registry g
   WHERE g.class IN ('C','B') AND to_regclass(g.tbl) IS NOT NULL
     AND has_table_privilege('lims_app', g.tbl, 'UPDATE')
     AND NOT EXISTS (SELECT 1 FROM pg_trigger t
                      WHERE t.tgrelid = to_regclass(g.tbl) AND NOT t.tgisinternal
                        AND t.tgfoid = 'app.enforce_mutable_columns()'::regprocedure
                        AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16 AND (t.tgtype & 1) = 1)   -- BEFORE, UPDATE, FOR EACH ROW
$$, 'AC-0B-4.1 every class C/B table that lims_app can UPDATE has a BEFORE UPDATE FOR EACH ROW enforce_mutable_columns trigger');

-- the generic function is INVOKER with an empty search_path (CV §5.7) and raises exactly immutable_row / P0001
SELECT is(p.prosecdef, false, 'app.enforce_mutable_columns is SECURITY INVOKER') FROM pg_proc p WHERE p.oid = 'app.enforce_mutable_columns()'::regprocedure;
SELECT is(array_to_string(p.proconfig, ','), 'search_path=""', 'app.enforce_mutable_columns pins search_path = ''''') FROM pg_proc p WHERE p.oid = 'app.enforce_mutable_columns()'::regprocedure;

-- (2) behaviour on stand-ins --------------------------------------------------------------------------------------------------------------------
SET LOCAL ROLE lims_owner;
CREATE TABLE core.t0b08_c_noargs (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, status text, note text);
CREATE TABLE core.t0b08_c_status (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, status text, note text);
CREATE TABLE core.t0b08_c_two    (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, status text, note text, tags text[]);
ALTER TABLE core.t0b08_c_noargs ENABLE ROW LEVEL SECURITY; ALTER TABLE core.t0b08_c_noargs FORCE ROW LEVEL SECURITY;
ALTER TABLE core.t0b08_c_status ENABLE ROW LEVEL SECURITY; ALTER TABLE core.t0b08_c_status FORCE ROW LEVEL SECURITY;
ALTER TABLE core.t0b08_c_two    ENABLE ROW LEVEL SECURITY; ALTER TABLE core.t0b08_c_two    FORCE ROW LEVEL SECURITY;
DO $do$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['t0b08_c_noargs','t0b08_c_status','t0b08_c_two'] LOOP
    EXECUTE format($p$CREATE POLICY %1$s__select__tenant ON core.%1$s FOR SELECT TO lims_app USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$s__insert__tenant ON core.%1$s FOR INSERT TO lims_app WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$s__update__tenant ON core.%1$s FOR UPDATE TO lims_app USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())) WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON core.%I TO lims_app', t);
  END LOOP;
END $do$;
CREATE TRIGGER t0b08_c_noargs__guard BEFORE UPDATE ON core.t0b08_c_noargs FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns();
CREATE TRIGGER t0b08_c_status__guard BEFORE UPDATE ON core.t0b08_c_status FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('status');
CREATE TRIGGER t0b08_c_two__guard    BEFORE UPDATE ON core.t0b08_c_two    FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('status', 'note');
RESET ROLE;

SET LOCAL session_replication_role = replica;   -- seeding only; the triggers under test are exercised below with replica mode off
INSERT INTO core.t0b08_c_noargs VALUES (pg_temp.id('11'), pg_temp.id('01'), 's0', 'n0');
INSERT INTO core.t0b08_c_status VALUES (pg_temp.id('12'), pg_temp.id('01'), 's0', 'n0');
INSERT INTO core.t0b08_c_two    VALUES (pg_temp.id('13'), pg_temp.id('01'), 's0', 'n0', ARRAY['a']);
INSERT INTO core.t0b08_c_noargs VALUES (pg_temp.id('21'), pg_temp.id('02'), 's0', 'n0');   -- tenant B row
SET LOCAL session_replication_role = origin;

-- relforcerowsecurity on every stand-in (AC-0B-2.4: stand-ins carry FORCE RLS)
SELECT is(relforcerowsecurity, true, relname || ' has relforcerowsecurity = true')
  FROM pg_class WHERE oid IN ('core.t0b08_c_noargs'::regclass, 'core.t0b08_c_status'::regclass, 'core.t0b08_c_two'::regclass);

-- AC-0B-4.1: a change to a column outside the argument list fails P0001 immutable_row
SELECT is(pg_temp.as_x('lims_api', pg_temp.claims_a(), format($$UPDATE core.t0b08_c_status SET note = 'x' WHERE id = %L$$, pg_temp.id('12'))),
  'EP0001:immutable_row', 'AC-0B-4.1 UPDATE of a non-listed column raises P0001 immutable_row');
SELECT is(pg_temp.as_x('lims_api', pg_temp.claims_a(), format($$UPDATE core.t0b08_c_status SET status = 's1' WHERE id = %L$$, pg_temp.id('12'))),
  'n=1', 'AC-0B-4.1 UPDATE of the listed column succeeds');
SELECT is(pg_temp.as_x('lims_api', pg_temp.claims_a(), format($$UPDATE core.t0b08_c_status SET status = 's2', note = 'x' WHERE id = %L$$, pg_temp.id('12'))),
  'EP0001:immutable_row', 'AC-0B-4.1 changing the listed and a non-listed column together fails');
SELECT is(pg_temp.as_x('lims_api', pg_temp.claims_a(), format($$UPDATE core.t0b08_c_status SET tenant_id = %L WHERE id = %L$$, pg_temp.id('02'), pg_temp.id('12'))),
  'EP0001:immutable_row', 'moving a row to another tenant is refused by the trigger before RLS WITH CHECK is reached');
SELECT is(pg_temp.as_x('lims_api', pg_temp.claims_a(), format($$UPDATE core.t0b08_c_status SET id = %L WHERE id = %L$$, pg_temp.id('77'), pg_temp.id('12'))),
  'EP0001:immutable_row', 'changing the primary key is refused');

-- schema test 25: no trigger arguments -> any change raises; a no-op UPDATE passes; two listed columns may both change, a third may not
SELECT is(pg_temp.as_x('lims_api', pg_temp.claims_a(), format($$UPDATE core.t0b08_c_noargs SET note = 'x' WHERE id = %L$$, pg_temp.id('11'))),
  'EP0001:immutable_row', 'schema test 25: argument-less trigger refuses any column change (note)');
SELECT is(pg_temp.as_x('lims_api', pg_temp.claims_a(), format($$UPDATE core.t0b08_c_noargs SET status = 'x' WHERE id = %L$$, pg_temp.id('11'))),
  'EP0001:immutable_row', 'schema test 25: argument-less trigger refuses any column change (status)');
SELECT is(pg_temp.as_x('lims_api', pg_temp.claims_a(), format($$UPDATE core.t0b08_c_noargs SET note = note WHERE id = %L$$, pg_temp.id('11'))),
  'n=1', 'schema test 25: an UPDATE that changes nothing passes');
SELECT is(pg_temp.as_x('lims_api', pg_temp.claims_a(), format($$UPDATE core.t0b08_c_two SET status = 's1', note = 'n1' WHERE id = %L$$, pg_temp.id('13'))),
  'n=1', 'two listed columns may change together');
SELECT is(pg_temp.as_x('lims_api', pg_temp.claims_a(), format($$UPDATE core.t0b08_c_two SET tags = ARRAY['b'] WHERE id = %L$$, pg_temp.id('13'))),
  'EP0001:immutable_row', 'an array column outside the list is protected');

-- the guard is not an RLS substitute: another tenant's row is still invisible (0 rows, no trigger firing)
SELECT is(pg_temp.as_x('lims_api', pg_temp.claims_a(), format($$UPDATE core.t0b08_c_noargs SET note = 'x' WHERE id = %L$$, pg_temp.id('21'))),
  'n=0', 'tenant B row: UPDATE affects 0 rows under tenant A claims');

-- the row values after the failed attempts are unchanged
SELECT is((SELECT note FROM core.t0b08_c_status WHERE id = pg_temp.id('12')), 'n0', 'failed UPDATEs left the row unchanged');

SELECT * FROM finish();
ROLLBACK;
