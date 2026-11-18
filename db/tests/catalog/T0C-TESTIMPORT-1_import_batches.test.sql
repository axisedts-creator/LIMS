-- T0C-TESTIMPORT-1 pgTAP suite (LD-318; founder 2026-11-17 08:58 NPT: Excel import without dirty data) for migration
-- 20261117180000_catalog__add_import_batches.sql: catalog.import_batch (tenant RLS FORCE-d, history never deleted, append only except the status and commit columns,
-- a committed batch cannot be changed, a batch older than 24 hours cannot be committed), idempotent re-apply.
-- Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written by the superuser test session with system claims (audit context),
-- every isolation assertion runs as SET LOCAL ROLE lims_app. Seeds 010 supply tenant A/B (a001/b001).
-- Run: bash db/tests/run-suites.sh db/tests/catalog/T0C-TESTIMPORT-1_import_batches.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (the brief lists the columns and the rules; a different choice needs a ruling, not a silent test edit; names equal the contract test testimport1-openapi.test.ts):
--  - catalog.import_batch(id, tenant_id, created_by, file_name, file_sha256, template_version, mode, status, counts jsonb, errors jsonb, payload jsonb, created_at, validated_at, committed_at, committed_by, version).
--    `version` (integer) is added to the brief's list because commitCatalogImport needs If-Match.
--  - CHECKs: status validated | rejected | committed | expired; mode create_only | update; file_sha256 = 64 lower-case hex; file_name and template_version not empty; counts is an object with the keys
--    tests, analytes, ranges, panels, errors; errors is an array of at most 1000 entries; payload is an object of at most a few MB (the test refuses 20 MB and accepts 1 MB);
--    a committed row carries committed_at and committed_by.
--  - lims_app: SELECT, INSERT, UPDATE, no DELETE. Immutable after insert (refused for lims_app AND for the superuser, so a trigger, not only column grants): tenant_id, created_by, created_at, file_name,
--    file_sha256, template_version, mode, counts, errors, payload. Mutable: status, validated_at, committed_at, committed_by (and version, updated_*).
--  - Transitions: validated -> committed (needs committed_at and committed_by), validated -> expired. A rejected, expired or committed batch never becomes committed; a committed batch changes nothing at all.
--    A batch whose created_at is older than 24 hours cannot become committed (enforced in the database, not only in the service).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c600-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'user') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a300' ELSE '01a1a98a-ac40-7000-8000-00000000b300' END::uuid,
    'membership_id', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a500' ELSE '01a1a98a-ac40-7000-8000-00000000b500' END::uuid) $$;
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);

-- run p_sql as p_role with claims; mode n = count of a query, w = ROW_COUNT of a statement; errors -> 'E' || SQLSTATE
CREATE FUNCTION pg_temp.x(p_role text, p_claims jsonb, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; END IF;
    r := 'n=' || n;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.a(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.b(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
-- superuser statement under system claims of tenant A: 'ok' or SQLSTATE (the failed statement is rolled back, a good one stays)
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);
  BEGIN
    EXECUTE p_sql;
    PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
    RETURN SQLSTATE;
  END;
END $f$;
-- one scalar as text, or 'E' || SQLSTATE (a missing column fails one assertion, not the whole file)
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r, 'NULL'); EXCEPTION WHEN OTHERS THEN RETURN 'E' || SQLSTATE; END $f$;
-- insert a row from jsonb (keys of p_row only; created_by / updated_by / id added when the table has them); 'ok' or SQLSTATE
CREATE FUNCTION pg_temp.ins(p_tbl_name text, p_row jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE p_tbl regclass := to_regclass(p_tbl_name); r jsonb := p_row; a text; cols text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  IF p_tbl IS NULL THEN RETURN '42P01'; END IF;
  IF r ? 'tenant_id' THEN PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', r->>'tenant_id', 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true); END IF;
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.sys()); END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = 'id' AND NOT attisdropped) AND NOT (r ? 'id') THEN r := r || jsonb_build_object('id', gen_random_uuid()); END IF;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  BEGIN
    EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, r::text);
    PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
    RETURN SQLSTATE;
  END;
END $f$;
-- a valid batch row of tenant p_tenant with id uid(p_n); p_extra overrides keys
CREATE FUNCTION pg_temp.bj(p_n int, p_tenant uuid, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(p_n), 'tenant_id', p_tenant, 'file_name', 'tests-synthetic.xlsx', 'file_sha256', repeat('ab', 32), 'template_version', '1', 'mode', 'create_only', 'status', 'validated',
    'counts', '{"tests":1,"analytes":2,"ranges":3,"panels":0,"errors":0}'::jsonb, 'errors', '[]'::jsonb, 'payload', '{"tests":[{"code":"SYN1"}]}'::jsonb, 'validated_at', now()) || p_extra $$;
CREATE FUNCTION pg_temp.ib(p_n int, p_tenant uuid, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.ins('catalog.import_batch', pg_temp.bj(p_n, p_tenant, p_extra)) $$;
-- fixture insert that must work: raises when it does not
CREATE FUNCTION pg_temp.fx(p_n int, p_tenant uuid, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE s text := pg_temp.ib(p_n, p_tenant, p_extra);
BEGIN IF s <> 'ok' THEN RAISE EXCEPTION 'fixture batch % failed with %', p_n, s; END IF; END $f$;
-- the batch is refused, whatever the mechanism: a statement error, or zero rows
CREATE FUNCTION pg_temp.refused(p_res text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT p_res LIKE 'E%' OR p_res = 'n=0' $$;

-- ===================================================================================================================================== (1) shape, RLS, grants
SELECT has_table('catalog'::name, 'import_batch'::name, 'catalog.import_batch exists');
SELECT is((SELECT string_agg(c, ',') FROM unnest(ARRAY['id','tenant_id','created_by','file_name','file_sha256','template_version','mode','status','counts','errors','payload','created_at','validated_at','committed_at','committed_by','version']) c
           WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('catalog.import_batch') AND a.attname = c AND NOT a.attisdropped AND a.attnum > 0)), NULL, 'import_batch has the 15 columns of the brief and version');
SELECT is((SELECT count(*)::int FROM pg_attribute WHERE attrelid = to_regclass('catalog.import_batch') AND attname IN ('counts','errors','payload') AND atttypid = 'jsonb'::regtype), 3, 'counts, errors and payload are jsonb');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('catalog.import_batch')), true, 'import_batch: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('catalog.import_batch') AND polcmd = 'd'), 0, 'import_batch: no DELETE policy (history is kept)');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('catalog.import_batch') AND polcmd IN ('r','a','w')), 3, 'import_batch: one SELECT, one INSERT, one UPDATE policy');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('catalog.import_batch') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND pg_get_expr(polwithcheck, polrelid) !~ 'tenant_id')), 0, 'import_batch: every policy is tenant scoped');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'catalog.import_batch', 'SELECT') AND has_table_privilege('lims_app', 'catalog.import_batch', 'INSERT')
  AND NOT has_table_privilege('lims_app', 'catalog.import_batch', 'DELETE'))::text$q$), 'true', 'import_batch: lims_app has SELECT and INSERT and no DELETE');
SELECT is(pg_temp.q($q$SELECT (EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'catalog.import_batch'::regclass AND NOT tgisinternal AND (tgtype & 16) = 16))::text$q$), 'true', 'import_batch: a BEFORE/AFTER UPDATE trigger guards the append-only rule (superuser and lims_app alike)');

-- ===================================================================================================================================== (2) inserts and CHECKs
SELECT is(pg_temp.ib(201, pg_temp.ta()), 'ok', 'insert: tenant A validated batch');
SELECT is(pg_temp.ib(202, pg_temp.tb()), 'ok', 'insert: tenant B validated batch');
SELECT is(pg_temp.ib(203, pg_temp.ta(), jsonb_build_object('created_at', now() - interval '25 hours')), 'ok', 'insert: a 25 hour old validated batch (fixture for the expiry rule)');
SELECT is(pg_temp.q($q$SELECT (created_at < now() - interval '24 hours')::text FROM catalog.import_batch WHERE id = '0190c600-0000-7000-8000-000000000203'$q$), 'true', 'fixture 203 really is older than 24 hours (created_at is accepted as given)');
SELECT is(pg_temp.ib(204, pg_temp.ta(), jsonb_build_object('status', 'rejected', 'errors', '[{"sheet":"Tests","row":2,"column":"Test Code","code":"code_duplicate","message":"Synthetic: duplicate code"}]'::jsonb,
  'counts', '{"tests":1,"analytes":0,"ranges":0,"panels":0,"errors":1}'::jsonb)), 'ok', 'insert: a rejected batch with one error row');
SELECT is(pg_temp.ib(205, pg_temp.ta(), jsonb_build_object('created_at', now() - interval '23 hours')), 'ok', 'insert: a 23 hour old validated batch (still inside the window)');
SELECT is(pg_temp.ib(206, pg_temp.ta()), 'ok', 'insert: tenant A validated batch used for the immutability checks');
SELECT is(pg_temp.ib(207, pg_temp.ta()), 'ok', 'insert: tenant A validated batch used for expiry');
SELECT is(pg_temp.ib(208, pg_temp.ta(), jsonb_build_object('mode', 'update')), 'ok', 'insert: mode update accepted');
SELECT is(pg_temp.ib(209, pg_temp.ta(), jsonb_build_object('status', 'committed', 'committed_at', now(), 'committed_by', pg_temp.sys())), 'ok', 'insert: a committed row with committed_at and committed_by is accepted');
SELECT is(pg_temp.ib(210, pg_temp.ta(), jsonb_build_object('status', 'committed')), '23514', 'insert: committed without committed_at and committed_by rejected');
SELECT is(pg_temp.ib(211, pg_temp.ta(), jsonb_build_object('status', 'uploaded')), '23514', 'insert: unknown status rejected');
SELECT is(pg_temp.ib(212, pg_temp.ta(), jsonb_build_object('mode', 'replace')), '23514', 'insert: unknown mode rejected');
SELECT is(pg_temp.ib(213, pg_temp.ta(), jsonb_build_object('file_sha256', 'not-a-hash')), '23514', 'insert: file_sha256 must be 64 hex characters');
SELECT is(pg_temp.ib(214, pg_temp.ta(), jsonb_build_object('file_sha256', upper(repeat('ab', 32)))), '23514', 'insert: upper case hash rejected (lower case hex only)');
SELECT is(pg_temp.ib(215, pg_temp.ta(), jsonb_build_object('file_name', '')), '23514', 'insert: empty file_name rejected');
SELECT is(pg_temp.ib(216, pg_temp.ta(), jsonb_build_object('template_version', '')), '23514', 'insert: empty template_version rejected');
SELECT is(pg_temp.ib(217, pg_temp.ta(), jsonb_build_object('counts', '{"tests":1}'::jsonb)), '23514', 'insert: counts without the keys analytes, ranges, panels, errors rejected');
SELECT is(pg_temp.ib(218, pg_temp.ta(), jsonb_build_object('counts', '[]'::jsonb)), '23514', 'insert: counts that is not an object rejected');
SELECT is(pg_temp.ib(219, pg_temp.ta(), jsonb_build_object('errors', '{}'::jsonb)), '23514', 'insert: errors that is not an array rejected');
SELECT is(pg_temp.ib(220, pg_temp.ta(), jsonb_build_object('errors', (SELECT jsonb_agg(jsonb_build_object('sheet','Tests','row',g,'column','Test Code','code','code_duplicate','message','Synthetic')) FROM generate_series(1, 1000) g))), 'ok',
  'insert: exactly 1000 error entries accepted');
SELECT is(pg_temp.ib(221, pg_temp.ta(), jsonb_build_object('errors', (SELECT jsonb_agg(jsonb_build_object('sheet','Tests','row',g,'column','Test Code','code','code_duplicate','message','Synthetic')) FROM generate_series(1, 1001) g))), '23514',
  'insert: 1001 error entries rejected (at most 1000)');
SELECT is(pg_temp.ib(222, pg_temp.ta(), jsonb_build_object('payload', jsonb_build_object('blob', repeat('x', 1000000)))), 'ok', 'insert: a 1 MB payload accepted');
SELECT is(pg_temp.ib(223, pg_temp.ta(), jsonb_build_object('payload', jsonb_build_object('blob', repeat('x', 20000000)))), '23514', 'insert: a 20 MB payload rejected (size capped)');
SELECT is(pg_temp.ib(224, pg_temp.ta(), jsonb_build_object('payload', '[]'::jsonb)), '23514', 'insert: payload must be a JSON object (the normalized workbook)');
SELECT is(pg_temp.a($q$INSERT INTO catalog.import_batch (id, tenant_id, created_by, file_name, file_sha256, template_version, mode, status, counts, errors, payload)
  VALUES ('0190c600-0000-7000-8000-000000000225', '01a1a98a-ac40-7000-8000-00000000b001', '01a1a98a-ac40-7000-8000-00000000a300', 'x.xlsx', repeat('ab', 32), '1', 'create_only', 'validated',
  '{"tests":0,"analytes":0,"ranges":0,"panels":0,"errors":0}', '[]', '{}')$q$), 'E42501', 'tenant A staff cannot insert a batch for tenant B (RLS WITH CHECK)');
SELECT is(pg_temp.a($q$INSERT INTO catalog.import_batch (id, tenant_id, created_by, file_name, file_sha256, template_version, mode, status, counts, errors, payload)
  VALUES ('0190c600-0000-7000-8000-000000000226', '01a1a98a-ac40-7000-8000-00000000a001', '01a1a98a-ac40-7000-8000-00000000a300', 'x.xlsx', repeat('cd', 32), '1', 'create_only', 'validated',
  '{"tests":0,"analytes":0,"ranges":0,"panels":0,"errors":0}', '[]', '{}')$q$), 'n=1', 'tenant A staff can insert its own batch');

-- ===================================================================================================================================== (3) append only except status and commit columns
SELECT is(pg_temp.a($q$DELETE FROM catalog.import_batch WHERE id = '0190c600-0000-7000-8000-000000000206'$q$), 'E42501', 'tenant A staff cannot DELETE a batch (no grant)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET payload = '{"tests":[]}' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'a validated batch: payload cannot be changed (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET counts = '{"tests":9,"analytes":9,"ranges":9,"panels":9,"errors":0}' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'a validated batch: counts cannot be changed (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET errors = '[]' WHERE id = '0190c600-0000-7000-8000-000000000204'$q$)), 'a rejected batch: its errors cannot be wiped (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET file_sha256 = repeat('cd', 32) WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'a validated batch: file_sha256 cannot be changed (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET file_name = 'other.xlsx' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'a validated batch: file_name cannot be changed (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET template_version = '2' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'a validated batch: template_version cannot be changed (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET mode = 'update' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'a validated batch: mode cannot be changed (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET created_by = '01a1a98a-ac40-7000-8000-00000000a300' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'a validated batch: created_by cannot be changed (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET created_at = now() WHERE id = '0190c600-0000-7000-8000-000000000203'$q$)), 'an old batch: created_at cannot be moved forward to dodge the 24 hour rule (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET tenant_id = '01a1a98a-ac40-7000-8000-00000000b001' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'a validated batch: tenant_id cannot be changed (staff)');
SELECT isnt(pg_temp.try($q$UPDATE catalog.import_batch SET payload = '{"tests":[]}' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$), 'ok', 'a validated batch: payload cannot be changed even by the superuser (trigger, not only grants)');
SELECT isnt(pg_temp.try($q$UPDATE catalog.import_batch SET counts = '{"tests":9,"analytes":9,"ranges":9,"panels":9,"errors":0}' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$), 'ok', 'a validated batch: counts cannot be changed even by the superuser');
SELECT isnt(pg_temp.try($q$UPDATE catalog.import_batch SET errors = '[]' WHERE id = '0190c600-0000-7000-8000-000000000204'$q$), 'ok', 'a rejected batch: errors cannot be wiped even by the superuser');
SELECT isnt(pg_temp.try($q$UPDATE catalog.import_batch SET file_sha256 = repeat('cd', 32) WHERE id = '0190c600-0000-7000-8000-000000000206'$q$), 'ok', 'a validated batch: file_sha256 cannot be changed even by the superuser');
SELECT is(pg_temp.q($q$SELECT (payload = '{"tests":[{"code":"SYN1"}]}'::jsonb AND counts = '{"tests":1,"analytes":2,"ranges":3,"panels":0,"errors":0}'::jsonb AND file_sha256 = repeat('ab', 32)
  AND file_name = 'tests-synthetic.xlsx' AND status = 'validated')::text FROM catalog.import_batch WHERE id = '0190c600-0000-7000-8000-000000000206'$q$), 'true', 'batch 206 is exactly as inserted after every refused change');

-- ===================================================================================================================================== (4) status transitions and the 24 hour rule
SELECT is(pg_temp.a($q$UPDATE catalog.import_batch SET status = 'expired' WHERE id = '0190c600-0000-7000-8000-000000000207'$q$), 'n=1', 'validated -> expired is allowed');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET status = 'committed', committed_at = now(), committed_by = '01a1a98a-ac40-7000-8000-00000000a300' WHERE id = '0190c600-0000-7000-8000-000000000207'$q$)), 'an expired batch cannot be committed');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET status = 'committed', committed_at = now(), committed_by = '01a1a98a-ac40-7000-8000-00000000a300' WHERE id = '0190c600-0000-7000-8000-000000000204'$q$)), 'a rejected batch (it has errors) cannot be committed');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET status = 'committed', committed_at = now(), committed_by = '01a1a98a-ac40-7000-8000-00000000a300' WHERE id = '0190c600-0000-7000-8000-000000000203'$q$)), 'a batch older than 24 hours cannot be committed (staff)');
SELECT isnt(pg_temp.try($q$UPDATE catalog.import_batch SET status = 'committed', committed_at = now(), committed_by = '01a1a98a-ac40-7000-8000-00000000a300' WHERE id = '0190c600-0000-7000-8000-000000000203'$q$), 'ok', 'a batch older than 24 hours cannot be committed (superuser too: a database rule, not only a service check)');
SELECT is(pg_temp.q($q$SELECT status FROM catalog.import_batch WHERE id = '0190c600-0000-7000-8000-000000000203'$q$), 'validated', 'the old batch stays validated after the refused commits');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET status = 'committed' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'a commit without committed_at and committed_by is refused');
SELECT is(pg_temp.a($q$UPDATE catalog.import_batch SET status = 'committed', committed_at = now(), committed_by = '01a1a98a-ac40-7000-8000-00000000a300' WHERE id = '0190c600-0000-7000-8000-000000000205'$q$), 'n=1', 'a 23 hour old validated batch can be committed');
SELECT is(pg_temp.q($q$SELECT status || ':' || (committed_at IS NOT NULL)::text || ':' || (committed_by IS NOT NULL)::text FROM catalog.import_batch WHERE id = '0190c600-0000-7000-8000-000000000205'$q$), 'committed:true:true', 'the committed batch shows status, committed_at and committed_by');
SELECT is(pg_temp.a($q$UPDATE catalog.import_batch SET status = 'committed', committed_at = now(), committed_by = '01a1a98a-ac40-7000-8000-00000000a300' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$), 'n=1', 'a fresh validated batch can be committed');

-- ===================================================================================================================================== (5) a committed batch cannot be changed
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET status = 'validated' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'committed: status cannot go back to validated (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET status = 'expired' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'committed: status cannot become expired (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET status = 'rejected' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'committed: status cannot become rejected (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET committed_at = now() + interval '1 day' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'committed: committed_at cannot be rewritten (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET committed_by = '01a1a98a-ac40-7000-8000-00000000a300' WHERE id = '0190c600-0000-7000-8000-000000000209'$q$)), 'committed: committed_by cannot be rewritten (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET payload = '{}' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'committed: payload cannot be changed (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET counts = '{"tests":0,"analytes":0,"ranges":0,"panels":0,"errors":0}' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'committed: counts cannot be changed (staff)');
SELECT ok(pg_temp.refused(pg_temp.a($q$UPDATE catalog.import_batch SET errors = '[{"sheet":"Tests","row":2,"column":"Test Code","code":"x","message":"y"}]' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$)), 'committed: errors cannot be changed (staff)');
SELECT isnt(pg_temp.try($q$UPDATE catalog.import_batch SET status = 'validated' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$), 'ok', 'committed: status cannot go back even for the superuser');
SELECT isnt(pg_temp.try($q$UPDATE catalog.import_batch SET payload = '{}' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$), 'ok', 'committed: payload cannot be changed even for the superuser');
SELECT isnt(pg_temp.try($q$UPDATE catalog.import_batch SET committed_at = now() + interval '1 day' WHERE id = '0190c600-0000-7000-8000-000000000209'$q$), 'ok', 'committed: committed_at cannot be rewritten even for the superuser');
SELECT is(pg_temp.q($q$SELECT (status = 'committed' AND payload = '{"tests":[{"code":"SYN1"}]}'::jsonb)::text FROM catalog.import_batch WHERE id = '0190c600-0000-7000-8000-000000000206'$q$), 'true', 'the committed batch keeps its status and payload after every refused change');

-- ===================================================================================================================================== (6) tenant isolation
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.import_batch$q$, 'n'), 'n=' || (SELECT count(*) FROM catalog.import_batch WHERE tenant_id = pg_temp.ta()), 'tenant A staff sees all and only its own batches');
SELECT is(pg_temp.b($q$SELECT 1 FROM catalog.import_batch$q$, 'n'), 'n=1', 'tenant B staff sees its 1 batch');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.import_batch WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$, 'n'), 'n=0', 'tenant A cannot read tenant B batches by filter');
SELECT is(pg_temp.a($q$UPDATE catalog.import_batch SET status = 'expired' WHERE id = '0190c600-0000-7000-8000-000000000202'$q$), 'n=0', 'tenant A cannot update a tenant B batch');
SELECT is(pg_temp.b($q$UPDATE catalog.import_batch SET status = 'committed', committed_at = now(), committed_by = '01a1a98a-ac40-7000-8000-00000000b300' WHERE id = '0190c600-0000-7000-8000-000000000201'$q$), 'n=0', 'tenant B cannot commit a tenant A batch');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM catalog.import_batch', 'n'), 'n=0', 'patient claims see 0 batches');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner'), 'SELECT 1 FROM catalog.import_batch', 'n'), 'n=0', 'partner claims see 0 batches');

-- ===================================================================================================================================== (7) idempotent re-apply: second run changes nothing and the rules still hold
CREATE TEMP TABLE before_state AS
  SELECT (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped) AS cols,
         (SELECT count(*) FROM pg_constraint k WHERE k.connamespace = 'catalog'::regnamespace) AS cons,
         (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'catalog'::regnamespace) AS idxs,
         (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = 'catalog'::regnamespace) AS pols,
         (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'catalog'::regnamespace AND NOT t.tgisinternal) AS trgs,
         (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind IN ('r','p')) AS tbls,
         (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'catalog'::regnamespace) AS procs,
         (SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint WHERE connamespace = 'catalog'::regnamespace AND contype = 'c') AS checks,
         (SELECT count(*) FROM catalog.import_batch) AS n_batch;
\ir ../../migrations/20261117180000_catalog__add_import_batches.sql
RESET ROLE;
SELECT is((SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped), (SELECT cols FROM before_state), 're-apply: column count unchanged');
SELECT is((SELECT count(*) FROM pg_constraint k WHERE k.connamespace = 'catalog'::regnamespace), (SELECT cons FROM before_state), 're-apply: constraint count unchanged');
SELECT is((SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'catalog'::regnamespace), (SELECT idxs FROM before_state), 're-apply: index count unchanged');
SELECT is((SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = 'catalog'::regnamespace), (SELECT pols FROM before_state), 're-apply: policy count unchanged');
SELECT is((SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'catalog'::regnamespace AND NOT t.tgisinternal), (SELECT trgs FROM before_state), 're-apply: trigger count unchanged');
SELECT is((SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind IN ('r','p')), (SELECT tbls FROM before_state), 're-apply: table count unchanged');
SELECT is((SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'catalog'::regnamespace), (SELECT procs FROM before_state), 're-apply: function count unchanged');
SELECT is((SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint WHERE connamespace = 'catalog'::regnamespace AND contype = 'c'), (SELECT checks FROM before_state), 're-apply: every CHECK definition unchanged');
SELECT is((SELECT count(*) FROM catalog.import_batch), (SELECT n_batch FROM before_state), 're-apply: no batch row added or removed');
SELECT isnt(pg_temp.try($q$UPDATE catalog.import_batch SET payload = '{}' WHERE id = '0190c600-0000-7000-8000-000000000206'$q$), 'ok', 're-apply: a committed batch is still immutable');
SELECT isnt(pg_temp.try($q$UPDATE catalog.import_batch SET status = 'committed', committed_at = now(), committed_by = '01a1a98a-ac40-7000-8000-00000000a300' WHERE id = '0190c600-0000-7000-8000-000000000203'$q$), 'ok', 're-apply: the 24 hour rule still holds');

SELECT * FROM finish();
ROLLBACK;
