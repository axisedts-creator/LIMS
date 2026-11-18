BEGIN;
SET search_path = extensions, public, pg_catalog;
CREATE FUNCTION pg_temp.x(p_role text, p_claims jsonb, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := 'n=' || n;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ' ' || SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
SELECT set_config('request.jwt.claims', '{"tenant_id":"01a1a98a-ac40-7000-8000-00000000a001","sub":"01a1b34e-1000-7eee-9d29-d7ca59a102b5","actor_type":"system"}', true);
INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, created_by, updated_by) VALUES
  ('0190d100-0000-7000-8000-000000000001', '0190d100-0000-7000-8000-000000000065', 'p@synthetic.example', 'P', 'platform_superadmin', '01a1b34e-1000-7eee-9d29-d7ca59a102b5', '01a1b34e-1000-7eee-9d29-d7ca59a102b5');
SELECT '# R1 ' || replace(pg_temp.x('lims_app', '{"actor_type":"user","scope":"platform","aal":"aal2","platform_staff_id":"0190d100-0000-7000-8000-000000000001","sub":"0190d100-0000-7000-8000-000000000065"}'::jsonb,
  $$INSERT INTO identity.ird_annex_records (id, tenant_id, annex_code, created_by, updated_by) VALUES ('0190d100-0000-7000-8000-000000004401', '01a1a98a-ac40-7000-8000-00000000b001', 'annex_2', '0190d100-0000-7000-8000-000000000065', '0190d100-0000-7000-8000-000000000065')$$), E'\n', ' | ');
SELECT '# R2 ' || count(*) FROM identity.ird_annex_records;
ALTER TABLE identity.ird_annex_records DISABLE TRIGGER ird_annex_records__audit;
SELECT '# R3 audit trigger disabled: ' || replace(pg_temp.x('lims_app', '{"actor_type":"user","scope":"platform","aal":"aal2","platform_staff_id":"0190d100-0000-7000-8000-000000000001","sub":"0190d100-0000-7000-8000-000000000065"}'::jsonb,
  $$INSERT INTO identity.ird_annex_records (id, tenant_id, annex_code, created_by, updated_by) VALUES ('0190d100-0000-7000-8000-000000004402', '01a1a98a-ac40-7000-8000-00000000b001', 'annex_2', '0190d100-0000-7000-8000-000000000065', '0190d100-0000-7000-8000-000000000065')$$), E'\n', ' | ');
SELECT '# R4 audit policies ' || policyname || ' ' || roles::text FROM pg_policies WHERE schemaname='audit' AND tablename='audit_log';
SELECT '# R5 platform_events ird annex events: ' || count(*) FROM identity.platform_events;
ROLLBACK;
