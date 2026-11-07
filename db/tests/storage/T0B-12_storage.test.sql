-- T0B-12 live Storage probes (REQ-SEC-034; 08 §4.8, R12b, R26; 05-SCHEMA §8; SP-4 api-proxied => buckets exist, NO end-user policy on storage.*).
-- LD-54 (CR-C0-T0B-12 option b): buckets are NOT created by SQL. This is the first-deploy smoke probe: run it only AFTER
--   db/provisioning/create-storage-buckets.mjs has ensured the 11 buckets through the Storage API (see db/provisioning/README.md).
--   It is not part of the DB harness suite order and is not executed by the T0B-12 task.
-- Run from the repo root on a bootstrapped + migrated + provisioned DB as superuser (pgTAP in schema `extensions`):
--   bash db/tests/run-suites.sh db/tests/storage/T0B-12_storage.test.sql
-- Synthetic tenants/objects only; everything is rolled back. Never disables RLS.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE TEMP TABLE want(b) AS VALUES ('reports'),('reporting-inputs'),('reporting-prints'),('identity-assets'),('identity-exports'),('frontdesk-trf'),
  ('billing-exports'),('instruments-attachments'),('micro-imports'),('anatomic-images'),('partners-slips');

-- run one statement as a role with given claims; returns 'n=<rows>' or 'E<sqlstate>'
CREATE FUNCTION pg_temp.x(p_role text, p_claims text, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := 'n=' || n;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;

-- REQ-SEC-034 buckets: all 11 of 08 §4.8 exist, all private, nothing else (reporting-legacy is reserved, not created)
SELECT is_empty($$SELECT b FROM want WHERE NOT EXISTS (SELECT 1 FROM storage.buckets s WHERE s.id = want.b)$$, 'REQ-SEC-034 every 08 §4.8 bucket exists');
SELECT is_empty($$SELECT id FROM storage.buckets WHERE public IS DISTINCT FROM false$$, 'REQ-SEC-034 no bucket is public');
SELECT is_empty($$SELECT id FROM storage.buckets WHERE id NOT IN (SELECT b FROM want)$$, 'REQ-SEC-034 no bucket outside the 08 §4.8 list');
SELECT is((SELECT count(*) FROM storage.buckets WHERE id = 'reporting-legacy'), 0::bigint, 'reporting-legacy is reserved (B4), not created');
SELECT is((SELECT count(*) FROM storage.buckets WHERE name <> id), 0::bigint, 'bucket id = name');

-- SP-4 api-proxied: RLS stays on and no policy admits anon / authenticated / PUBLIC on storage.objects or storage.buckets
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass), 'REQ-SEC-034 RLS enabled on storage.objects');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.buckets'::regclass), 'REQ-SEC-034 RLS enabled on storage.buckets');
SELECT is_empty($$SELECT tablename || '.' || policyname FROM pg_policies
                   WHERE schemaname = 'storage' AND roles && ARRAY['anon','authenticated','public']::name[]$$,
                'REQ-SEC-034 no end-user policy on storage.* (SP-4 api-proxied)');

-- the application login roles reach files only through the Storage API, never through SQL on storage.objects
SELECT is(has_table_privilege(r, 'storage.objects', p), false, 'REQ-SEC-034 ' || r || ' has no ' || p || ' on storage.objects')
  FROM unnest(ARRAY['lims_app','lims_api','lims_worker']) r, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p;

-- fixture (superuser; RLS does not apply): one object per tenant per bucket. Controls prove the zeros below are not vacuous.
CREATE TEMP TABLE tn(k text, t uuid) AS VALUES ('a','01900000-0000-7000-8000-0000000000a1'::uuid), ('b','01900000-0000-7000-8000-0000000000b2'::uuid);
INSERT INTO storage.objects (bucket_id, name) SELECT w.b, tn.t::text || '/t0b12-probe.pdf' FROM want w, tn;
SELECT is((SELECT count(*) FROM storage.objects WHERE name LIKE '%/t0b12-probe.pdf'), 22::bigint, 'control: 11 buckets x 2 tenants seeded');

-- probes: tenant A's end-user token (authenticated) and the bare anon key, against every bucket
CREATE TEMP TABLE actor(role text, claims text) AS VALUES
  ('authenticated', '{"role":"authenticated","tenant_id":"01900000-0000-7000-8000-0000000000a1","actor_type":"user"}'),
  ('anon',          '{"role":"anon"}');
SELECT is(pg_temp.x(a.role, a.claims, format('SELECT 1 FROM storage.objects WHERE bucket_id = %L', w.b)), 'n=0',
          'REQ-SEC-034 ' || a.role || ' (tenant A claims) reads 0 objects in ' || w.b || ' (own and foreign tenant)')
  FROM actor a, want w;
SELECT is(pg_temp.x(a.role, a.claims, format('SELECT 1 FROM storage.objects WHERE bucket_id = %L AND name LIKE %L', w.b, tn.t::text || '/%')), 'n=0',
          'REQ-SEC-034 ' || a.role || ' cannot read tenant ' || tn.k || ' prefix in ' || w.b)
  FROM actor a, want w, tn WHERE w.b IN ('reports','frontdesk-trf','billing-exports');
SELECT is(pg_temp.x(a.role, a.claims, format('INSERT INTO storage.objects (bucket_id, name) VALUES (%L, %L)', w.b, tn.t::text || '/t0b12-x.pdf')), 'E42501',
          'REQ-SEC-034 ' || a.role || ' INSERT into ' || w.b || '/tenant ' || tn.k || ' denied by RLS')
  FROM actor a, want w, tn WHERE w.b IN ('reports','reporting-inputs','frontdesk-trf');
SELECT is(pg_temp.x(a.role, a.claims, format('UPDATE storage.objects SET name = name || %L WHERE bucket_id = %L', 'x', w.b)), 'n=0',
          'REQ-SEC-034 ' || a.role || ' UPDATE in ' || w.b || ' touches 0 rows')
  FROM actor a, want w WHERE w.b IN ('reports','billing-exports');
SELECT is(pg_temp.x(a.role, a.claims, format('DELETE FROM storage.objects WHERE bucket_id = %L', w.b)), 'n=0',
          'REQ-SEC-034 ' || a.role || ' DELETE in ' || w.b || ' touches 0 rows')
  FROM actor a, want w WHERE w.b IN ('reports','billing-exports');
SELECT is(pg_temp.x(a.role, a.claims, 'SELECT 1 FROM storage.buckets'), 'n=0', 'REQ-SEC-034 ' || a.role || ' lists 0 buckets') FROM actor a;
SELECT is(pg_temp.x('authenticated', (SELECT claims FROM actor WHERE role = 'authenticated'), 'UPDATE storage.buckets SET public = true'), 'n=0',
          'REQ-SEC-034 authenticated cannot flip a bucket public');

-- controls: nothing was written, moved or deleted by the attempts
SELECT is((SELECT count(*) FROM storage.objects WHERE name LIKE '%/t0b12-probe.pdf'), 22::bigint, 'control: all 22 seeded objects intact');
SELECT is((SELECT count(*) FROM storage.objects WHERE name LIKE '%/t0b12-x.pdf'), 0::bigint, 'control: no probe INSERT landed');
SELECT is_empty($$SELECT id FROM storage.buckets WHERE public IS DISTINCT FROM false$$, 'control: still no public bucket after the attempts');

SELECT * FROM finish();
ROLLBACK;
