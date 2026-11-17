-- T0C-PRICETOOLS-1 pgTAP suite (LD-321, LD-325; founder 2026-11-17 09:18 NPT order, ElabAssist "Price Allocation") for migration
-- 20261117200000_catalog__add_price_list_tools.sql: catalog.price_list_import_batch + catalog.price_list_import_error (tenant RLS FORCE-d, history never deleted),
-- effective_from / effective_to on catalog.price_list_assignments and the rule "assignments of one party never overlap in time", idempotent re-apply.
-- Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written by the superuser test session with system claims (audit context),
-- every isolation assertion runs as SET LOCAL ROLE lims_app. Seeds 010 supply tenant A/B (a001/b001).
-- Run: bash db/tests/run-suites.sh db/tests/catalog/T0C-PRICETOOLS-1_price_list_tools.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (brief names tables and the listed columns; a different choice needs a ruling, not a silent test edit; names equal the contract test pricetools1-openapi.test.ts):
--  - catalog.price_list_import_batch(id, tenant_id, price_list_id, status, row_count, error_count, file_ref, file_sha256, summary jsonb, created_by, created_at): composite FK (tenant_id, price_list_id) to catalog.price_lists,
--    status CHECK dry_run | committed | failed | cancelled, row_count 0..5000, error_count >= 0, file_sha256 = 64 lower-case hex chars. lims_app: SELECT, INSERT, UPDATE (status moves dry_run -> committed), no DELETE.
--  - catalog.price_list_import_error(id, tenant_id, batch_id, row_no, column_name, code, message, created_at): composite FK (tenant_id, batch_id), row_no >= 1, code and message not empty.
--    Append only: lims_app has SELECT and INSERT, no UPDATE, no DELETE (the history of what was wrong is evidence).
--  - catalog.price_list_assignments gains effective_from and effective_to (timestamptz, like catalog.price_list_versions). effective_from is NOT NULL (an existing row is valid from its creation), effective_to NULL = open ended,
--    effective_to > effective_from. The old "one row per party" partial unique indexes go (a party may have a list per period); two assignments of one party (credit party, doctor or centre) may never overlap in time,
--    whatever the list (exclusion constraint or trigger; any of 23P01, 23505, 23514, P0001 counts as refused). Parties with a gap between periods are fine.
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
-- fixture insert that must work (old tables, old columns only): raises when it does not
CREATE FUNCTION pg_temp.fx(p_tbl text, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE s text := pg_temp.ins(p_tbl, p_row);
BEGIN IF s <> 'ok' THEN RAISE EXCEPTION 'fixture % failed with %', p_tbl, s; END IF; END $f$;

-- ===================================================================================================================================== fixtures (old columns only: proves existing rows)
SELECT pg_temp.fx('catalog.price_lists', jsonb_build_object('id', pg_temp.uid(101), 'tenant_id', pg_temp.ta(), 'code', 'DEFAULT', 'name', 'Default (SYNTHETIC)', 'owner_kind', 'default'));
SELECT pg_temp.fx('catalog.price_lists', jsonb_build_object('id', pg_temp.uid(102), 'tenant_id', pg_temp.ta(), 'code', 'CPLIST1', 'name', 'Party list 1 (SYNTHETIC)', 'owner_kind', 'credit_party'));
SELECT pg_temp.fx('catalog.price_lists', jsonb_build_object('id', pg_temp.uid(103), 'tenant_id', pg_temp.ta(), 'code', 'CPLIST2', 'name', 'Party list 2 (SYNTHETIC)', 'owner_kind', 'credit_party'));
SELECT pg_temp.fx('catalog.price_lists', jsonb_build_object('id', pg_temp.uid(104), 'tenant_id', pg_temp.ta(), 'code', 'REFLIST1', 'name', 'Referrer list 1 (SYNTHETIC)', 'owner_kind', 'referrer'));
SELECT pg_temp.fx('catalog.price_lists', jsonb_build_object('id', pg_temp.uid(105), 'tenant_id', pg_temp.tb(), 'code', 'DEFAULT', 'name', 'Default B (SYNTHETIC)', 'owner_kind', 'default'));
SELECT pg_temp.fx('catalog.price_lists', jsonb_build_object('id', pg_temp.uid(106), 'tenant_id', pg_temp.tb(), 'code', 'CPLIST1', 'name', 'Party list B (SYNTHETIC)', 'owner_kind', 'credit_party'));
SELECT pg_temp.fx('catalog.credit_parties', jsonb_build_object('id', pg_temp.uid(111), 'tenant_id', pg_temp.ta(), 'party_code', 'FRA1', 'name', 'Franchise 1 (SYNTHETIC)', 'kind', 'partner_lab'));
SELECT pg_temp.fx('catalog.credit_parties', jsonb_build_object('id', pg_temp.uid(112), 'tenant_id', pg_temp.ta(), 'party_code', 'CLI1', 'name', 'Client 1 (SYNTHETIC)', 'kind', 'company'));
SELECT pg_temp.fx('catalog.credit_parties', jsonb_build_object('id', pg_temp.uid(113), 'tenant_id', pg_temp.tb(), 'party_code', 'CLI1', 'name', 'Client B (SYNTHETIC)', 'kind', 'company'));
SELECT pg_temp.fx('catalog.doctors', jsonb_build_object('id', pg_temp.uid(121), 'tenant_id', pg_temp.ta(), 'doctor_code', 'DR1', 'display_name', 'Dr Synthetic One', 'name_normalised', 'dr synthetic one', 'source', 'back_office'));
-- an OLD-SHAPE assignment (no date columns named): proves existing rows stay valid after the migration
SELECT pg_temp.fx('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(131), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(102), 'owner_kind', 'credit_party', 'credit_party_id', pg_temp.uid(112)));

-- ===================================================================================================================================== (1) assignments: effective dates, no overlap per party
SELECT is((SELECT count(*)::int FROM pg_attribute WHERE attrelid = to_regclass('catalog.price_list_assignments') AND attname IN ('effective_from','effective_to') AND NOT attisdropped AND atttypid = 'timestamptz'::regtype), 2, 'assignments: effective_from and effective_to exist as timestamptz');
SELECT is(pg_temp.q($q$SELECT (effective_from IS NOT NULL)::text FROM catalog.price_list_assignments WHERE id = '0190c600-0000-7000-8000-000000000131'$q$), 'true', 'existing assignment: effective_from is filled (valid from creation)');
SELECT is(pg_temp.q($q$SELECT coalesce(effective_to::text, 'NULL') FROM catalog.price_list_assignments WHERE id = '0190c600-0000-7000-8000-000000000131'$q$), 'NULL', 'existing assignment: effective_to is open ended');
SELECT is(pg_temp.q($q$SELECT count(*)::text FROM pg_indexes WHERE schemaname = 'catalog' AND tablename = 'price_list_assignments' AND indexdef ILIKE '%UNIQUE%' AND (indexdef ILIKE '%(tenant_id, credit_party_id)%' OR indexdef ILIKE '%(tenant_id, doctor_id)%' OR indexdef ILIKE '%(tenant_id, centre_id)%') AND indexdef NOT ILIKE '%effective%'$q$), '0', 'assignments: the old "one row per party" unique indexes are gone');
SELECT is(pg_temp.try($q$UPDATE catalog.price_list_assignments SET effective_from = '2026-01-01T00:00:00Z', effective_to = '2026-06-30T00:00:00Z' WHERE id = '0190c600-0000-7000-8000-000000000131'$q$), 'ok', 'assignment: a row can be closed with a date range');
SELECT is(pg_temp.ins('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(132), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(103), 'owner_kind', 'credit_party', 'credit_party_id', pg_temp.uid(112),
  'effective_from', '2026-08-01T00:00:00Z')), 'ok', 'assignment: the same party gets another list from a later date (gap between periods, open ended)');
SELECT ok(pg_temp.ins('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(133), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(102), 'owner_kind', 'credit_party', 'credit_party_id', pg_temp.uid(112),
  'effective_from', '2026-03-01T00:00:00Z', 'effective_to', '2026-04-01T00:00:00Z')) IN ('23P01','23505','23514','P0001'), 'assignment: a period inside an existing one for the same party is refused');
SELECT ok(pg_temp.ins('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(134), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(103), 'owner_kind', 'credit_party', 'credit_party_id', pg_temp.uid(112),
  'effective_from', '2026-05-01T00:00:00Z')) IN ('23P01','23505','23514','P0001'), 'assignment: an open ended period that overlaps an existing period is refused');
SELECT ok(pg_temp.ins('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(135), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(102), 'owner_kind', 'credit_party', 'credit_party_id', pg_temp.uid(112),
  'effective_from', '2026-09-01T00:00:00Z', 'effective_to', '2026-10-01T00:00:00Z')) IN ('23P01','23505','23514','P0001'), 'assignment: a period inside the open ended later one is refused (any list, not only the same list)');
SELECT ok(pg_temp.ins('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(136), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(103), 'owner_kind', 'credit_party', 'credit_party_id', pg_temp.uid(112),
  'effective_from', '2026-08-01T00:00:00Z')) IN ('23P01','23505','23514','P0001'), 'assignment: an exact duplicate of the open ended period is refused');
SELECT is(pg_temp.ins('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(137), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(102), 'owner_kind', 'credit_party', 'credit_party_id', pg_temp.uid(112),
  'effective_from', '2026-07-05T00:00:00Z', 'effective_to', '2026-07-25T00:00:00Z')), 'ok', 'assignment: a period that fits in the gap between two periods is allowed');
SELECT is(pg_temp.ins('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(138), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(102), 'owner_kind', 'credit_party', 'credit_party_id', pg_temp.uid(111),
  'effective_from', '2026-03-01T00:00:00Z', 'effective_to', '2026-04-01T00:00:00Z')), 'ok', 'assignment: another party may use the same window and list');
SELECT ok(pg_temp.try($q$UPDATE catalog.price_list_assignments SET effective_from = '2026-03-01T00:00:00Z' WHERE id = '0190c600-0000-7000-8000-000000000132'$q$) IN ('23P01','23505','23514','P0001'), 'assignment: moving a period start into another period is refused (UPDATE is checked too)');
SELECT ok(pg_temp.try($q$UPDATE catalog.price_list_assignments SET effective_to = NULL WHERE id = '0190c600-0000-7000-8000-000000000137'$q$) IN ('23P01','23505','23514','P0001'), 'assignment: opening an end date into the later period is refused');
SELECT is(pg_temp.ins('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(139), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(102), 'owner_kind', 'credit_party', 'credit_party_id', pg_temp.uid(111),
  'effective_from', '2026-05-01T00:00:00Z', 'effective_to', '2026-05-01T00:00:00Z')), '23514', 'assignment: effective_to equal to effective_from is rejected');
SELECT is(pg_temp.ins('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(140), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(102), 'owner_kind', 'credit_party', 'credit_party_id', pg_temp.uid(111),
  'effective_from', '2026-06-01T00:00:00Z', 'effective_to', '2026-05-01T00:00:00Z')), '23514', 'assignment: effective_to before effective_from is rejected');
-- referrers (Doctor party type) follow the same rule
SELECT is(pg_temp.ins('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(141), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(104), 'owner_kind', 'referrer', 'doctor_id', pg_temp.uid(121),
  'effective_from', '2026-01-01T00:00:00Z', 'effective_to', '2026-12-31T00:00:00Z')), 'ok', 'assignment: a doctor gets a dated list');
SELECT ok(pg_temp.ins('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(142), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(104), 'owner_kind', 'referrer', 'doctor_id', pg_temp.uid(121),
  'effective_from', '2026-06-01T00:00:00Z', 'effective_to', '2027-01-31T00:00:00Z')) IN ('23P01','23505','23514','P0001'), 'assignment: overlapping periods of one doctor are refused');
-- tenant isolation of assignments (the existing RLS is unchanged)
SELECT is(pg_temp.ins('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(143), 'tenant_id', pg_temp.tb(), 'price_list_id', pg_temp.uid(106), 'owner_kind', 'credit_party', 'credit_party_id', pg_temp.uid(113),
  'effective_from', '2026-03-01T00:00:00Z', 'effective_to', '2026-04-01T00:00:00Z')), 'ok', 'assignment: tenant B has its own party and its own periods (no cross-tenant overlap rule)');
SELECT is(pg_temp.ins('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(144), 'tenant_id', pg_temp.tb(), 'price_list_id', pg_temp.uid(106), 'owner_kind', 'credit_party', 'credit_party_id', pg_temp.uid(112),
  'effective_from', '2026-11-01T00:00:00Z')), '23503', 'assignment: tenant B cannot assign a tenant A party (composite FK)');
SELECT is(pg_temp.b($q$SELECT 1 FROM catalog.price_list_assignments WHERE credit_party_id = '0190c600-0000-7000-8000-000000000112'$q$, 'n'), 'n=0', 'assignment: tenant B staff cannot read tenant A assignments');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.price_list_assignments WHERE credit_party_id = '0190c600-0000-7000-8000-000000000112'$q$, 'n'), 'n=3', 'assignment: tenant A staff reads the three periods of its party');

-- ===================================================================================================================================== (2) catalog.price_list_import_batch
SELECT has_table('catalog'::name, 'price_list_import_batch'::name, 'catalog.price_list_import_batch exists');
SELECT is((SELECT string_agg(c, ',') FROM unnest(ARRAY['id','tenant_id','price_list_id','status','row_count','error_count','file_ref','file_sha256','summary','created_by','created_at']) c
           WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('catalog.price_list_import_batch') AND a.attname = c AND NOT a.attisdropped AND a.attnum > 0)), NULL, 'import_batch has the 11 columns');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('catalog.price_list_import_batch')), true, 'import_batch: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('catalog.price_list_import_batch') AND polcmd = 'd'), 0, 'import_batch: no DELETE policy (history is kept)');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('catalog.price_list_import_batch') AND polcmd IN ('r','a','w')), 3, 'import_batch: one SELECT, one INSERT, one UPDATE policy');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('catalog.price_list_import_batch') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND pg_get_expr(polwithcheck, polrelid) !~ 'tenant_id')), 0, 'import_batch: every policy is tenant scoped');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'catalog.price_list_import_batch', 'SELECT') AND has_table_privilege('lims_app', 'catalog.price_list_import_batch', 'INSERT')
  AND has_table_privilege('lims_app', 'catalog.price_list_import_batch', 'UPDATE') AND NOT has_table_privilege('lims_app', 'catalog.price_list_import_batch', 'DELETE'))::text$q$), 'true', 'import_batch: lims_app has SELECT, INSERT, UPDATE and no DELETE');
SELECT is(pg_temp.ins('catalog.price_list_import_batch', jsonb_build_object('id', pg_temp.uid(151), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(101), 'status', 'dry_run', 'row_count', 120, 'error_count', 2,
  'file_ref', 'files/synthetic-1.xlsx', 'file_sha256', repeat('ab', 32), 'summary', '{"rows":120,"errors":2}'::jsonb)), 'ok', 'import_batch insert: tenant A / default list / dry run');
SELECT is(pg_temp.ins('catalog.price_list_import_batch', jsonb_build_object('id', pg_temp.uid(152), 'tenant_id', pg_temp.tb(), 'price_list_id', pg_temp.uid(105), 'status', 'dry_run', 'row_count', 5, 'error_count', 0,
  'file_ref', 'files/synthetic-2.xlsx', 'file_sha256', repeat('cd', 32), 'summary', '{}'::jsonb)), 'ok', 'import_batch insert: tenant B');
SELECT is(pg_temp.ins('catalog.price_list_import_batch', jsonb_build_object('id', pg_temp.uid(153), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(101), 'status', 'cancelled', 'row_count', 0, 'error_count', 0,
  'file_ref', 'files/synthetic-3.xlsx', 'file_sha256', repeat('ef', 32), 'summary', '{}'::jsonb)), 'ok', 'import_batch insert: every status of the list is accepted (cancelled)');
SELECT is(pg_temp.ins('catalog.price_list_import_batch', jsonb_build_object('id', pg_temp.uid(154), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(106), 'status', 'dry_run', 'row_count', 1, 'error_count', 0,
  'file_ref', 'files/x.xlsx', 'file_sha256', repeat('ab', 32), 'summary', '{}'::jsonb)), '23503', 'import_batch insert: a price list of tenant B is rejected (composite FK)');
SELECT is(pg_temp.ins('catalog.price_list_import_batch', jsonb_build_object('id', pg_temp.uid(155), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(101), 'status', 'uploaded', 'row_count', 1, 'error_count', 0,
  'file_ref', 'files/x.xlsx', 'file_sha256', repeat('ab', 32), 'summary', '{}'::jsonb)), '23514', 'import_batch insert: unknown status rejected');
SELECT is(pg_temp.ins('catalog.price_list_import_batch', jsonb_build_object('id', pg_temp.uid(156), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(101), 'status', 'dry_run', 'row_count', 5001, 'error_count', 0,
  'file_ref', 'files/x.xlsx', 'file_sha256', repeat('ab', 32), 'summary', '{}'::jsonb)), '23514', 'import_batch insert: more than 5000 rows rejected');
SELECT is(pg_temp.ins('catalog.price_list_import_batch', jsonb_build_object('id', pg_temp.uid(157), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(101), 'status', 'dry_run', 'row_count', 5000, 'error_count', 0,
  'file_ref', 'files/x.xlsx', 'file_sha256', repeat('ab', 32), 'summary', '{}'::jsonb)), 'ok', 'import_batch insert: exactly 5000 rows accepted');
SELECT is(pg_temp.ins('catalog.price_list_import_batch', jsonb_build_object('id', pg_temp.uid(158), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(101), 'status', 'dry_run', 'row_count', -1, 'error_count', 0,
  'file_ref', 'files/x.xlsx', 'file_sha256', repeat('ab', 32), 'summary', '{}'::jsonb)), '23514', 'import_batch insert: negative row_count rejected');
SELECT is(pg_temp.ins('catalog.price_list_import_batch', jsonb_build_object('id', pg_temp.uid(159), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(101), 'status', 'dry_run', 'row_count', 1, 'error_count', -1,
  'file_ref', 'files/x.xlsx', 'file_sha256', repeat('ab', 32), 'summary', '{}'::jsonb)), '23514', 'import_batch insert: negative error_count rejected');
SELECT is(pg_temp.ins('catalog.price_list_import_batch', jsonb_build_object('id', pg_temp.uid(160), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(101), 'status', 'dry_run', 'row_count', 1, 'error_count', 0,
  'file_ref', 'files/x.xlsx', 'file_sha256', 'not-a-hash', 'summary', '{}'::jsonb)), '23514', 'import_batch insert: file_sha256 must be 64 hex characters');
SELECT is(pg_temp.ins('catalog.price_list_import_batch', jsonb_build_object('id', pg_temp.uid(161), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(101), 'status', 'dry_run', 'row_count', 1, 'error_count', 0,
  'file_ref', 'files/x.xlsx', 'file_sha256', upper(repeat('ab', 32)), 'summary', '{}'::jsonb)), '23514', 'import_batch insert: upper case hash rejected (lower case hex only)');
SELECT is(pg_temp.a($q$DELETE FROM catalog.price_list_import_batch WHERE id = '0190c600-0000-7000-8000-000000000151'$q$), 'E42501', 'tenant A staff cannot DELETE a batch (no grant)');
SELECT is(pg_temp.a($q$UPDATE catalog.price_list_import_batch SET status = 'committed' WHERE id = '0190c600-0000-7000-8000-000000000151'$q$), 'n=1', 'tenant A staff can move a batch to committed');
SELECT is(pg_temp.q($q$SELECT status FROM catalog.price_list_import_batch WHERE id = '0190c600-0000-7000-8000-000000000151'$q$), 'committed', 'the batch keeps its row and shows the new status');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.price_list_import_batch$q$, 'n'), 'n=3', 'tenant A staff sees its 3 batches (151, 153, 157)');
SELECT is(pg_temp.b($q$SELECT 1 FROM catalog.price_list_import_batch$q$, 'n'), 'n=1', 'tenant B staff sees its 1 batch');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.price_list_import_batch WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$, 'n'), 'n=0', 'tenant A cannot read tenant B batches by filter');
SELECT is(pg_temp.a($q$UPDATE catalog.price_list_import_batch SET status = 'cancelled' WHERE id = '0190c600-0000-7000-8000-000000000152'$q$), 'n=0', 'tenant A cannot update a tenant B batch');
SELECT is(pg_temp.a($q$INSERT INTO catalog.price_list_import_batch (id, tenant_id, price_list_id, status, row_count, error_count, file_ref, file_sha256, summary, created_by) VALUES ('0190c600-0000-7000-8000-000000000162',
  '01a1a98a-ac40-7000-8000-00000000b001', '0190c600-0000-7000-8000-000000000105', 'dry_run', 1, 0, 'files/x.xlsx', repeat('ab', 32), '{}', '01a1a98a-ac40-7000-8000-00000000a300')$q$), 'E42501', 'tenant A cannot insert a batch for tenant B (RLS WITH CHECK)');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM catalog.price_list_import_batch', 'n'), 'n=0', 'patient claims see 0 batches');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner'), 'SELECT 1 FROM catalog.price_list_import_batch', 'n'), 'n=0', 'partner claims see 0 batches');

-- ===================================================================================================================================== (3) catalog.price_list_import_error
SELECT has_table('catalog'::name, 'price_list_import_error'::name, 'catalog.price_list_import_error exists');
SELECT is((SELECT string_agg(c, ',') FROM unnest(ARRAY['id','tenant_id','batch_id','row_no','column_name','code','message','created_at']) c
           WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('catalog.price_list_import_error') AND a.attname = c AND NOT a.attisdropped AND a.attnum > 0)), NULL, 'import_error has the 8 columns');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('catalog.price_list_import_error')), true, 'import_error: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('catalog.price_list_import_error') AND polcmd IN ('d','w')), 0, 'import_error: no UPDATE and no DELETE policy (append only)');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('catalog.price_list_import_error') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND pg_get_expr(polwithcheck, polrelid) !~ 'tenant_id')), 0, 'import_error: every policy is tenant scoped');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'catalog.price_list_import_error', 'SELECT') AND has_table_privilege('lims_app', 'catalog.price_list_import_error', 'INSERT')
  AND NOT has_table_privilege('lims_app', 'catalog.price_list_import_error', 'UPDATE') AND NOT has_table_privilege('lims_app', 'catalog.price_list_import_error', 'DELETE'))::text$q$), 'true', 'import_error: lims_app has SELECT and INSERT only');
SELECT is(pg_temp.ins('catalog.price_list_import_error', jsonb_build_object('id', pg_temp.uid(171), 'tenant_id', pg_temp.ta(), 'batch_id', pg_temp.uid(151), 'row_no', 7, 'column_name', 'test code', 'code', 'code_not_found', 'message', 'Synthetic: test code XX999 does not exist')), 'ok', 'import_error insert: row 7, column test code');
SELECT is(pg_temp.ins('catalog.price_list_import_error', jsonb_build_object('id', pg_temp.uid(172), 'tenant_id', pg_temp.ta(), 'batch_id', pg_temp.uid(151), 'row_no', 7, 'column_name', 'price', 'code', 'price_invalid', 'message', 'Synthetic: more than 2 decimals')), 'ok', 'import_error insert: two errors for one row are both kept');
SELECT is(pg_temp.ins('catalog.price_list_import_error', jsonb_build_object('id', pg_temp.uid(173), 'tenant_id', pg_temp.tb(), 'batch_id', pg_temp.uid(152), 'row_no', 2, 'column_name', 'price', 'code', 'price_negative', 'message', 'Synthetic: price below 0')), 'ok', 'import_error insert: tenant B');
SELECT is(pg_temp.ins('catalog.price_list_import_error', jsonb_build_object('id', pg_temp.uid(174), 'tenant_id', pg_temp.ta(), 'batch_id', pg_temp.uid(152), 'row_no', 2, 'column_name', 'price', 'code', 'price_negative', 'message', 'x')), '23503', 'import_error insert: a batch of tenant B is rejected (composite FK)');
SELECT is(pg_temp.ins('catalog.price_list_import_error', jsonb_build_object('id', pg_temp.uid(175), 'tenant_id', pg_temp.ta(), 'batch_id', pg_temp.uid(151), 'row_no', 0, 'column_name', 'price', 'code', 'price_invalid', 'message', 'x')), '23514', 'import_error insert: row_no 0 rejected (rows start at 1)');
SELECT is(pg_temp.ins('catalog.price_list_import_error', jsonb_build_object('id', pg_temp.uid(176), 'tenant_id', pg_temp.ta(), 'batch_id', pg_temp.uid(151), 'row_no', 3, 'column_name', 'price', 'code', '', 'message', 'x')), '23514', 'import_error insert: empty code rejected');
SELECT is(pg_temp.ins('catalog.price_list_import_error', jsonb_build_object('id', pg_temp.uid(177), 'tenant_id', pg_temp.ta(), 'batch_id', pg_temp.uid(151), 'row_no', 3, 'column_name', 'price', 'code', 'price_invalid', 'message', '')), '23514', 'import_error insert: empty message rejected');
SELECT is(pg_temp.a($q$DELETE FROM catalog.price_list_import_error WHERE id = '0190c600-0000-7000-8000-000000000171'$q$), 'E42501', 'tenant A staff cannot DELETE an import error (no grant)');
SELECT is(pg_temp.a($q$UPDATE catalog.price_list_import_error SET message = 'edited' WHERE id = '0190c600-0000-7000-8000-000000000171'$q$), 'E42501', 'tenant A staff cannot UPDATE an import error (append only)');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.price_list_import_error$q$, 'n'), 'n=2', 'tenant A staff sees its 2 import errors');
SELECT is(pg_temp.b($q$SELECT 1 FROM catalog.price_list_import_error$q$, 'n'), 'n=1', 'tenant B staff sees its 1 import error');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.price_list_import_error WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$, 'n'), 'n=0', 'tenant A cannot read tenant B import errors by filter');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM catalog.price_list_import_error', 'n'), 'n=0', 'patient claims see 0 import errors');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner'), 'SELECT 1 FROM catalog.price_list_import_error', 'n'), 'n=0', 'partner claims see 0 import errors');

-- ===================================================================================================================================== (4) the existing price list tables keep their RLS (nothing weakened)
SELECT is((SELECT bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid IN (to_regclass('catalog.price_lists'), to_regclass('catalog.price_list_versions'), to_regclass('catalog.price_list_items'), to_regclass('catalog.price_list_assignments'))), true, 'the four existing price list tables still have FORCE RLS');
SELECT is(pg_temp.a($q$SELECT 1 FROM catalog.price_lists$q$, 'n'), 'n=4', 'tenant A staff sees its 4 price lists');
SELECT is(pg_temp.b($q$SELECT 1 FROM catalog.price_lists$q$, 'n'), 'n=2', 'tenant B staff sees its 2 price lists');

-- ===================================================================================================================================== (5) idempotent re-apply: second run changes nothing
CREATE TEMP TABLE before_state AS
  SELECT (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped) AS cols,
         (SELECT count(*) FROM pg_constraint k WHERE k.connamespace = 'catalog'::regnamespace) AS cons,
         (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'catalog'::regnamespace) AS idxs,
         (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = 'catalog'::regnamespace) AS pols,
         (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'catalog'::regnamespace AND NOT t.tgisinternal) AS trgs,
         (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind IN ('r','p')) AS tbls,
         (SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint WHERE connamespace = 'catalog'::regnamespace AND contype = 'c') AS checks,
         (SELECT count(*) FROM catalog.price_list_assignments) AS n_assign, (SELECT count(*) FROM catalog.price_list_import_batch) AS n_batch, (SELECT count(*) FROM catalog.price_list_import_error) AS n_err,
         pg_temp.q('SELECT effective_from::text FROM catalog.price_list_assignments WHERE id = ''0190c600-0000-7000-8000-000000000131''') AS from_131;
\ir ../../migrations/20261117200000_catalog__add_price_list_tools.sql
RESET ROLE;
SELECT is((SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped), (SELECT cols FROM before_state), 're-apply: column count unchanged');
SELECT is((SELECT count(*) FROM pg_constraint k WHERE k.connamespace = 'catalog'::regnamespace), (SELECT cons FROM before_state), 're-apply: constraint count unchanged');
SELECT is((SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'catalog'::regnamespace), (SELECT idxs FROM before_state), 're-apply: index count unchanged');
SELECT is((SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = 'catalog'::regnamespace), (SELECT pols FROM before_state), 're-apply: policy count unchanged');
SELECT is((SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'catalog'::regnamespace AND NOT t.tgisinternal), (SELECT trgs FROM before_state), 're-apply: trigger count unchanged');
SELECT is((SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'catalog'::regnamespace AND c.relkind IN ('r','p')), (SELECT tbls FROM before_state), 're-apply: table count unchanged');
SELECT is((SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint WHERE connamespace = 'catalog'::regnamespace AND contype = 'c'), (SELECT checks FROM before_state), 're-apply: every CHECK definition unchanged');
SELECT is((SELECT count(*) FROM catalog.price_list_assignments), (SELECT n_assign FROM before_state), 're-apply: no assignment row added or removed');
SELECT is((SELECT count(*) FROM catalog.price_list_import_batch), (SELECT n_batch FROM before_state), 're-apply: no batch row added or removed');
SELECT is((SELECT count(*) FROM catalog.price_list_import_error), (SELECT n_err FROM before_state), 're-apply: no import error row added or removed');
SELECT is(pg_temp.q('SELECT effective_from::text FROM catalog.price_list_assignments WHERE id = ''0190c600-0000-7000-8000-000000000131'''), (SELECT from_131 FROM before_state), 're-apply: no data rewrite (effective_from intact)');
SELECT ok(pg_temp.ins('catalog.price_list_assignments', jsonb_build_object('id', pg_temp.uid(145), 'tenant_id', pg_temp.ta(), 'price_list_id', pg_temp.uid(102), 'owner_kind', 'credit_party', 'credit_party_id', pg_temp.uid(112),
  'effective_from', '2026-03-01T00:00:00Z', 'effective_to', '2026-04-01T00:00:00Z')) IN ('23P01','23505','23514','P0001'), 're-apply: the no-overlap rule still refuses an overlap');

SELECT * FROM finish();
ROLLBACK;
