-- T0C-VERLEVEL-1 pgTAP suite (LD-316, LD-318 follow-up (4), LD-335; founder 2026-11-17 08:39 NPT "verification level 1 2 3") for migration
-- 20261117150000_lab__add_verification_policy_and_signoffs.sql: lab.verification_policy (per lab / department / test), lab.result_signoff (append only chain),
-- additive columns lab.results.signoff_required / signoff_count with their backfill, the result lock after the change, idempotent re-apply.
-- Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written by the superuser test session with system claims (audit context),
-- every behaviour assertion runs as SET LOCAL ROLE lims_app. Seeds 010 supply tenant A/B (a001/b001). Fixture parents copy db/tests/lab/T0B-10.C5_behaviour.test.sql.
-- Run: bash db/tests/run-suites.sh db/tests/lab/T0C-VERLEVEL-1_verification_levels.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (the brief names the tables and columns; a different choice needs a ruling, not a silent test edit; names equal tools/codegen/__tests__/verlevel1-openapi.test.ts):
--  - lab.verification_policy(id, tenant_id, scope, department_id, test_id, required_verifiers smallint, require_pathologist, allow_enterer_verify, active, created_at, updated_at, updated_by).
--    scope CHECK lab | department | test; EXACTLY the target that matches the scope is set (lab: neither, department: department_id only, test: test_id only);
--    required_verifiers NOT NULL CHECK 1..3; require_pathologist DEFAULT true; allow_enterer_verify DEFAULT false (LD-318 (4): the enterer cannot verify, switchable);
--    at most one ACTIVE row per tenant and scope target (partial unique index or exclusion); lims_app SELECT, INSERT, UPDATE, never DELETE (deactivate with active = false);
--    RLS FORCE-d, tenant scoped. department_id / test_id carry no cross-schema FK (same as lab.results.department_id).
--  - DEFAULT POLICY: after migrations + seeds every seeded tenant (A and B) already holds exactly one active lab scope row, required_verifiers 2, require_pathologist true, allow_enterer_verify false
--    (brief done_when 2: "seeded or created on first read"; the database test can prove only the seeded reading: a seed file or a tenant trigger; the service creates it for tenants created later).
--  - lab.result_signoff(id, tenant_id, result_id, result_version, seq smallint, action, signer_user_id, signer_display_name, signer_role_code, signer_is_pathologist, signer_registration_no,
--    signer_signature_asset_id, signed_at): composite FK (tenant_id, result_id) to lab.results, result_version >= 1, seq 1..3, action verify | approve, UNIQUE (result_id, result_version, seq),
--    UNIQUE (result_id, result_version, signer_user_id); lims_app SELECT + INSERT only (also no TRUNCATE); lims_worker no UPDATE/DELETE; RLS FORCE-d, tenant scoped, no UPDATE/DELETE policy.
--  - lab.results gains signoff_required smallint and signoff_count smallint (count NOT NULL DEFAULT 0). Backfill of existing rows, proven by dropping the two columns, re-applying the migration:
--    required 2 on every row; count 1 on status verified, 2 on status approved, 0 otherwise; a row that already holds new-model values (e.g. required 3 / count 1, or a level 1 approval 1 / 1) is never rewritten;
--    a cancelled row (frozen by lab.enforce_result_lock) must not make the migration fail.
--  - The result lock stays: an approved row still refuses a value change (P0001 immutable_row) but signoff_required, signoff_count may change together with current_version_no (an amendment is signed off again).
--  - The migration is re-runnable (every wave-2 migration is; pinned by the \ir re-apply at the end).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c700-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'system') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', pg_temp.sys(),
    'membership_id', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a500' ELSE '01a1a98a-ac40-7000-8000-00000000b500' END::uuid) $$;
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);

-- run p_sql as p_role with claims; mode n = count of a query, w = ROW_COUNT of a statement; errors -> 'E' || SQLSTATE (or 'E' || SQLSTATE || '|' || SQLERRM when mode is 'wm')
CREATE FUNCTION pg_temp.x(p_role text, p_claims jsonb, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; END IF;
    r := 'n=' || n;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || CASE WHEN p_mode = 'wm' THEN '|' || SQLERRM ELSE '' END; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.a(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;   -- tenant A, system actor (all centres)
CREATE FUNCTION pg_temp.b(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r, 'NULL'); EXCEPTION WHEN OTHERS THEN RETURN 'E' || SQLSTATE; END $f$;
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
-- one sign-off row for tenant A (superuser fixture or probe): p_over replaces any key
CREATE FUNCTION pg_temp.so(p_id int, p_result int, p_ver int, p_seq int, p_signer int, p_action text, p_over jsonb DEFAULT '{}') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ins('lab.result_signoff', jsonb_build_object('id', pg_temp.uid(p_id), 'tenant_id', pg_temp.ta(), 'result_id', pg_temp.uid(p_result), 'result_version', p_ver, 'seq', p_seq,
    'action', p_action, 'signer_user_id', pg_temp.uid(p_signer), 'signer_display_name', 'Signer ' || p_signer || ' (SYNTHETIC)', 'signer_role_code', CASE WHEN p_action = 'approve' THEN 'pathologist' ELSE 'lab_technologist' END,
    'signer_is_pathologist', p_action = 'approve', 'signed_at', '2026-11-17T04:00:00Z') || p_over) $$;
-- one policy row for tenant A / B: p_over replaces any key
CREATE FUNCTION pg_temp.po(p_id int, p_tenant uuid, p_scope text, p_over jsonb DEFAULT '{}') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.ins('lab.verification_policy', jsonb_build_object('id', pg_temp.uid(p_id), 'tenant_id', p_tenant, 'scope', p_scope, 'required_verifiers', 2, 'require_pathologist', true,
    'allow_enterer_verify', false, 'active', true) || p_over) $$;

-- ===================================================================================================================================== fixtures (old columns only: proves existing rows)
SELECT pg_temp.fx('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(1), 'tenant_id', pg_temp.ta(), 'patient_code', 'P-0001', 'full_name', 'Test Patient 0001', 'name_search', 'test patient 0001', 'sex', 'female', 'registered_centre_id', pg_temp.id('00000000a201')));
SELECT pg_temp.fx('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(2), 'tenant_id', pg_temp.tb(), 'patient_code', 'P-0001', 'full_name', 'Test Patient 0002', 'name_search', 'test patient 0002', 'sex', 'male', 'registered_centre_id', pg_temp.id('00000000b201')));
SELECT pg_temp.fx('frontdesk.orders', jsonb_build_object('id', pg_temp.uid(o.n), 'tenant_id', o.t, 'branch_id', o.br, 'centre_id', o.c, 'patient_id', o.p, 'registration_no', 'R-' || o.n, 'status', 'registered', 'visit_type', 'opd',
    'billing_mode', 'cash', 'priority', 'routine', 'collection_mode', 'walk_in', 'source', 'front_desk', 'is_first_order_of_patient', true, 'catalog_revision', 1, 'registered_at', now()))
  FROM (VALUES (11, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1)), (13, pg_temp.tb(), pg_temp.id('00000000b101'), pg_temp.id('00000000b201'), pg_temp.uid(2))) o(n, t, br, c, p);
SELECT pg_temp.fx('frontdesk.order_items', jsonb_build_object('id', pg_temp.uid(i.n), 'tenant_id', i.t, 'order_id', pg_temp.uid(i.o), 'centre_id', i.c, 'orderable_id', pg_temp.uid(99), 'orderable_kind', 'test',
    'code', 'CBC', 'name', 'CBC (SYNTHETIC)', 'test_ids', jsonb_build_array(pg_temp.uid(99)), 'priority', 'routine', 'unit_price_paisa', 1000, 'price_list_id', pg_temp.uid(98), 'price_list_version', 1,
    'price_source', 'tenant_default', 'vat_treatment', 'exempt', 'added_in_items_version', 1))
  FROM (VALUES (21, pg_temp.ta(), 11, pg_temp.id('00000000a201')), (22, pg_temp.tb(), 13, pg_temp.id('00000000b201'))) i(n, t, o, c);
SELECT pg_temp.fx('lab.orders', jsonb_build_object('id', pg_temp.uid(o.n), 'tenant_id', o.t, 'centre_id', o.c, 'branch_id', o.br, 'patient_id', o.p, 'registration_no', 'R-' || o.n, 'visit_type', 'opd', 'priority', 'routine',
    'source', 'front_desk', 'registered_at', now(), 'patient_sex', 'female', 'last_order_seq', 1))
  FROM (VALUES (11, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1)), (13, pg_temp.tb(), pg_temp.id('00000000b101'), pg_temp.id('00000000b201'), pg_temp.uid(2))) o(n, t, br, c, p);
SELECT pg_temp.fx('lab.specimens', jsonb_build_object('id', pg_temp.uid(s.n), 'tenant_id', s.t, 'centre_id', s.c, 'order_id', s.o, 'patient_id', s.p, 'barcode', 'E26' || lpad(s.n::text, 8, '0'), 'creation_key', 'ck-' || s.n,
    'specimen_type_code', 'serum', 'priority', 'routine', 'patient_sex', 'female', 'status', 'ordered', 'ordered_at', now()))
  FROM (VALUES (31, pg_temp.ta(), pg_temp.id('00000000a201'), pg_temp.uid(11), pg_temp.uid(1)), (35, pg_temp.tb(), pg_temp.id('00000000b201'), pg_temp.uid(13), pg_temp.uid(2))) s(n, t, c, o, p);
SELECT pg_temp.fx('lab.order_tests', jsonb_build_object('id', pg_temp.uid(t.n), 'tenant_id', t.t, 'centre_id', t.c, 'order_id', pg_temp.uid(t.o), 'order_item_id', pg_temp.uid(t.i), 'test_id', pg_temp.uid(99), 'test_code', 'CBC',
    'test_revision', 1, 'catalog_revision', 1, 'department_id', pg_temp.uid(97), 'workflow_type', 'standard', 'priority', 'routine', 'specimen_id', pg_temp.uid(t.s), 'status', 'awaiting_receipt', 'ordered_at', now()))
  FROM (VALUES (41, pg_temp.ta(), pg_temp.id('00000000a201'), 11, 21, 31), (42, pg_temp.tb(), pg_temp.id('00000000b201'), 13, 22, 35)) t(n, t, c, o, i, s);
-- results of tenant A (analyte n+50): 51 pending, 52 resulted, 53 verified, 54 approved, 55 cancelled; tenant B: 58 resulted. NO signoff column named (these rows are the "existing rows" of the backfill proof at the end)
SELECT pg_temp.fx('lab.results', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'order_id', pg_temp.uid(r.o), 'order_item_id', pg_temp.uid(r.i), 'order_test_id', pg_temp.uid(r.ot), 'specimen_id', pg_temp.uid(r.s),
    'patient_id', pg_temp.uid(r.p), 'test_id', pg_temp.uid(99), 'analyte_id', pg_temp.uid(r.n + 50), 'analyte_code', 'AN' || r.n, 'department_id', pg_temp.uid(97), 'is_reportable', true, 'result_type', 'numeric', 'status', r.st) || r.x)
  FROM (VALUES
    (51, pg_temp.ta(), pg_temp.id('00000000a201'), 11, 21, 41, 31, 1, 'pending', '{}'::jsonb),
    (52, pg_temp.ta(), pg_temp.id('00000000a201'), 11, 21, 41, 31, 1, 'resulted', jsonb_build_object('origin', 'manual', 'value_numeric', 5.2, 'flag', 'N', 'first_resulted_at', now(), 'resulted_at', now())),
    (53, pg_temp.ta(), pg_temp.id('00000000a201'), 11, 21, 41, 31, 1, 'verified', jsonb_build_object('origin', 'manual', 'value_numeric', 5.3, 'flag', 'N', 'first_resulted_at', now(), 'resulted_at', now(), 'verified_at', now(), 'verified_by_membership_id', pg_temp.id('00000000a500'))),
    (54, pg_temp.ta(), pg_temp.id('00000000a201'), 11, 21, 41, 31, 1, 'approved', jsonb_build_object('origin', 'manual', 'value_numeric', 5.4, 'flag', 'N', 'first_resulted_at', now(), 'resulted_at', now(), 'verified_at', now(), 'verified_by_membership_id', pg_temp.id('00000000a500'), 'approved_at', now(), 'approved_by_membership_id', pg_temp.id('00000000a500'))),
    (55, pg_temp.ta(), pg_temp.id('00000000a201'), 11, 21, 41, 31, 1, 'cancelled', jsonb_build_object('cancelled_at', now(), 'cancel_reason', 'specimen_rejected')),
    (58, pg_temp.tb(), pg_temp.id('00000000b201'), 13, 22, 42, 35, 2, 'resulted', jsonb_build_object('origin', 'manual', 'value_numeric', 5.8, 'flag', 'N', 'first_resulted_at', now(), 'resulted_at', now()))
  ) r(n, t, c, o, i, ot, s, p, st, x);

-- ===================================================================================================================================== (1) lab.verification_policy: shape, RLS, grants
SELECT has_table('lab'::name, 'verification_policy'::name, 'lab.verification_policy exists');
SELECT is((SELECT string_agg(c, ',') FROM unnest(ARRAY['id','tenant_id','scope','department_id','test_id','required_verifiers','require_pathologist','allow_enterer_verify','active','created_at','updated_at','updated_by']) c
           WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('lab.verification_policy') AND a.attname = c AND NOT a.attisdropped AND a.attnum > 0)), NULL, 'verification_policy has the 12 columns of the brief');
SELECT is((SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = to_regclass('lab.verification_policy') AND attname = 'required_verifiers'), 'smallint', 'required_verifiers is smallint');
SELECT is((SELECT (relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid = to_regclass('lab.verification_policy')), true, 'verification_policy: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('lab.verification_policy') AND polcmd = 'd'), 0, 'verification_policy: no DELETE policy (deactivate, never delete)');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('lab.verification_policy') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND coalesce(pg_get_expr(polwithcheck, polrelid), '') !~ 'tenant_id')), 0, 'verification_policy: every policy is tenant scoped');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'lab.verification_policy', 'SELECT') AND has_table_privilege('lims_app', 'lab.verification_policy', 'INSERT')
  AND has_table_privilege('lims_app', 'lab.verification_policy', 'UPDATE') AND NOT has_table_privilege('lims_app', 'lab.verification_policy', 'DELETE') AND NOT has_table_privilege('lims_app', 'lab.verification_policy', 'TRUNCATE'))::text$q$),
  'true', 'verification_policy: lims_app has SELECT, INSERT, UPDATE and no DELETE, no TRUNCATE');

-- (1a) the default policy: every seeded tenant holds ONE active lab scope row, level 2, pathologist required, enterer may not verify (brief done_when 2)
SELECT is(pg_temp.q($q$SELECT count(*)::text FROM lab.verification_policy WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001' AND scope = 'lab' AND active$q$), '1', 'default: tenant A has exactly one active lab scope policy');
SELECT is(pg_temp.q($q$SELECT count(*)::text FROM lab.verification_policy WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001' AND scope = 'lab' AND active$q$), '1', 'default: tenant B has exactly one active lab scope policy');
SELECT is(pg_temp.q($q$SELECT required_verifiers || '/' || require_pathologist || '/' || allow_enterer_verify FROM lab.verification_policy WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001' AND scope = 'lab' AND active$q$),
  '2/true/false', 'default lab policy of tenant A: required_verifiers 2, require_pathologist true, allow_enterer_verify false (reproduces today: technologist verifies, pathologist approves)');
SELECT is(pg_temp.q($q$SELECT required_verifiers || '/' || require_pathologist || '/' || allow_enterer_verify FROM lab.verification_policy WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001' AND scope = 'lab' AND active$q$),
  '2/true/false', 'default lab policy of tenant B: 2 / true / false');
SELECT is(pg_temp.q($q$SELECT (department_id IS NULL AND test_id IS NULL)::text FROM lab.verification_policy WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001' AND scope = 'lab' AND active$q$), 'true', 'default lab policy has no department and no test');
SELECT is(pg_temp.a($q$SELECT 1 FROM lab.verification_policy WHERE scope = 'lab'$q$, 'n'), 'n=1', 'tenant A staff reads its own default policy');
SELECT is(pg_temp.b($q$SELECT 1 FROM lab.verification_policy WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$q$, 'n'), 'n=0', 'tenant B staff cannot read the tenant A policy');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'user'), 'SELECT 1 FROM lab.verification_policy', 'n'), 'n=1', 'a tenant A user actor reads the policy (every lab role may read it)');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM lab.verification_policy', 'n'), 'n=0', 'patient claims see 0 policies');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner'), 'SELECT 1 FROM lab.verification_policy', 'n'), 'n=0', 'partner claims see 0 policies');

-- (1b) CHECKs
SELECT is(pg_temp.po(301, pg_temp.ta(), 'ward', jsonb_build_object('active', false)), '23514', 'policy: unknown scope rejected');
SELECT is(pg_temp.po(302, pg_temp.ta(), 'department', jsonb_build_object('active', false)), '23514', 'policy: department scope without department_id rejected');
SELECT is(pg_temp.po(303, pg_temp.ta(), 'test', jsonb_build_object('active', false)), '23514', 'policy: test scope without test_id rejected');
SELECT is(pg_temp.po(304, pg_temp.ta(), 'lab', jsonb_build_object('active', false, 'department_id', pg_temp.uid(97))), '23514', 'policy: lab scope with a department_id rejected (exactly the matching target)');
SELECT is(pg_temp.po(305, pg_temp.ta(), 'department', jsonb_build_object('active', false, 'department_id', pg_temp.uid(97), 'test_id', pg_temp.uid(99))), '23514', 'policy: department scope that also names a test rejected');
SELECT is(pg_temp.po(306, pg_temp.ta(), 'test', jsonb_build_object('active', false, 'test_id', pg_temp.uid(99), 'department_id', pg_temp.uid(97))), '23514', 'policy: test scope that also names a department rejected');
SELECT is(pg_temp.po(307, pg_temp.ta(), 'lab', jsonb_build_object('active', false, 'required_verifiers', 0)), '23514', 'policy: required_verifiers 0 rejected');
SELECT is(pg_temp.po(308, pg_temp.ta(), 'lab', jsonb_build_object('active', false, 'required_verifiers', 4)), '23514', 'policy: required_verifiers 4 rejected (levels are 1, 2, 3)');
SELECT is(pg_temp.po(309, pg_temp.ta(), 'lab', jsonb_build_object('active', false, 'required_verifiers', -1)), '23514', 'policy: negative required_verifiers rejected');
SELECT ok(pg_temp.po(310, pg_temp.ta(), 'lab', jsonb_build_object('active', false, 'required_verifiers', NULL)) IN ('23502', '23514'), 'policy: required_verifiers NULL rejected');
SELECT is(pg_temp.po(311, pg_temp.ta(), 'lab', jsonb_build_object('active', false, 'required_verifiers', 1)), 'ok', 'policy: level 1 accepted (inactive history row)');
SELECT is(pg_temp.po(312, pg_temp.ta(), 'lab', jsonb_build_object('active', false, 'required_verifiers', 3)), 'ok', 'policy: level 3 accepted (inactive history row)');
SELECT is(pg_temp.ins('lab.verification_policy', jsonb_build_object('id', pg_temp.uid(313), 'tenant_id', '0190c700-0000-7000-8000-0000000fffff', 'scope', 'lab', 'required_verifiers', 2, 'active', false)), '23503', 'policy: unknown tenant rejected (FK to core.tenants)');
-- defaults named by the brief: require_pathologist true, allow_enterer_verify false
SELECT is(pg_temp.ins('lab.verification_policy', jsonb_build_object('id', pg_temp.uid(314), 'tenant_id', pg_temp.ta(), 'scope', 'department', 'department_id', pg_temp.uid(91), 'required_verifiers', 2, 'active', false)), 'ok', 'policy insert naming neither flag');
SELECT is(pg_temp.q($q$SELECT require_pathologist || '/' || allow_enterer_verify FROM lab.verification_policy WHERE id = '0190c700-0000-7000-8000-000000000314'$q$), 'true/false', 'policy defaults: require_pathologist true, allow_enterer_verify false');

-- (1c) at most one ACTIVE row per tenant and scope target
SELECT is(pg_temp.po(320, pg_temp.ta(), 'lab'), '23505', 'unique: a second active lab policy for tenant A is refused');
SELECT is(pg_temp.po(321, pg_temp.ta(), 'lab', jsonb_build_object('active', false)), 'ok', 'unique: an inactive second lab row is fine (history)');
SELECT is(pg_temp.po(322, pg_temp.ta(), 'department', jsonb_build_object('department_id', pg_temp.uid(91))), 'ok', 'department 91 gets its own active policy');
SELECT is(pg_temp.po(323, pg_temp.ta(), 'department', jsonb_build_object('department_id', pg_temp.uid(91))), '23505', 'unique: a second active policy for department 91 is refused');
SELECT is(pg_temp.po(324, pg_temp.ta(), 'department', jsonb_build_object('department_id', pg_temp.uid(92), 'required_verifiers', 1)), 'ok', 'another department has its own active policy');
SELECT is(pg_temp.po(325, pg_temp.ta(), 'test', jsonb_build_object('test_id', pg_temp.uid(99), 'required_verifiers', 3)), 'ok', 'test 99 gets its own active policy');
SELECT is(pg_temp.po(326, pg_temp.ta(), 'test', jsonb_build_object('test_id', pg_temp.uid(99))), '23505', 'unique: a second active policy for test 99 is refused');
SELECT is(pg_temp.po(327, pg_temp.ta(), 'test', jsonb_build_object('test_id', pg_temp.uid(98))), 'ok', 'another test has its own active policy');
SELECT is(pg_temp.po(328, pg_temp.tb(), 'department', jsonb_build_object('department_id', pg_temp.uid(91))), 'ok', 'tenant B may use the same department id (the rule is per tenant)');
SELECT is(pg_temp.po(329, pg_temp.tb(), 'test', jsonb_build_object('test_id', pg_temp.uid(99))), 'ok', 'tenant B may use the same test id');
SELECT ok(pg_temp.try($q$UPDATE lab.verification_policy SET active = true WHERE id = '0190c700-0000-7000-8000-000000000321'$q$) IN ('23505', '23P01'), 'unique: re-activating the inactive lab row while another is active is refused (UPDATE is checked too)');
SELECT is(pg_temp.try($q$UPDATE lab.verification_policy SET active = false WHERE id = '0190c700-0000-7000-8000-000000000322'$q$), 'ok', 'a policy is deactivated with active = false');
SELECT is(pg_temp.po(330, pg_temp.ta(), 'department', jsonb_build_object('department_id', pg_temp.uid(91), 'required_verifiers', 3)), 'ok', 'after deactivation a new active policy for the same department is fine');

-- (1d) application role: upsert path, never delete, tenant isolation
SELECT is(pg_temp.a($q$UPDATE lab.verification_policy SET required_verifiers = 2, updated_by = '01a1a98a-ac40-7000-8000-00000000a300' WHERE id = '0190c700-0000-7000-8000-000000000330'$q$), 'n=1', 'tenant A staff changes the level of a policy');
SELECT is(pg_temp.a($q$INSERT INTO lab.verification_policy (id, tenant_id, scope, test_id, required_verifiers, require_pathologist, allow_enterer_verify, active, updated_by)
  VALUES ('0190c700-0000-7000-8000-000000000331', '01a1a98a-ac40-7000-8000-00000000a001', 'test', '0190c700-0000-7000-8000-000000000097', 1, false, true, true, '01a1a98a-ac40-7000-8000-00000000a300')$q$), 'n=1', 'tenant A staff inserts a test level policy (level 1, no pathologist, enterer may verify)');
SELECT is(pg_temp.a($q$DELETE FROM lab.verification_policy WHERE id = '0190c700-0000-7000-8000-000000000331'$q$), 'E42501', 'tenant A staff cannot DELETE a policy (no grant)');
SELECT is(pg_temp.q($q$SELECT count(*)::text FROM lab.verification_policy WHERE id = '0190c700-0000-7000-8000-000000000331'$q$), '1', 'the policy row is still there after the refused DELETE');
SELECT is(pg_temp.a($q$UPDATE lab.verification_policy SET active = false WHERE id = '0190c700-0000-7000-8000-000000000331'$q$), 'n=1', 'tenant A staff deactivates it instead');
SELECT is(pg_temp.a($q$INSERT INTO lab.verification_policy (id, tenant_id, scope, required_verifiers, active, updated_by) VALUES ('0190c700-0000-7000-8000-000000000332',
  '01a1a98a-ac40-7000-8000-00000000b001', 'lab', 2, false, '01a1a98a-ac40-7000-8000-00000000a300')$q$), 'E42501', 'tenant A cannot insert a policy for tenant B (RLS WITH CHECK)');
SELECT is(pg_temp.a($q$UPDATE lab.verification_policy SET required_verifiers = 1 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$), 'n=0', 'tenant A cannot update a tenant B policy');
SELECT is(pg_temp.b($q$SELECT 1 FROM lab.verification_policy WHERE scope = 'lab' AND active$q$, 'n'), 'n=1', 'tenant B staff sees only its own active default policy');
-- sign-off authority is security relevant: a change to a policy is audited (class C)
SELECT cmp_ok((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'lab' AND table_name = 'verification_policy' AND row_id = pg_temp.uid(330)), '>=', 2, 'policy INSERT and UPDATE are audited (audit.audit_log)');

-- ===================================================================================================================================== (2) lab.result_signoff: append only chain
SELECT has_table('lab'::name, 'result_signoff'::name, 'lab.result_signoff exists');
SELECT is((SELECT string_agg(c, ',') FROM unnest(ARRAY['id','tenant_id','result_id','result_version','seq','action','signer_user_id','signer_display_name','signer_role_code','signer_is_pathologist',
             'signer_registration_no','signer_signature_asset_id','signed_at']) c
           WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('lab.result_signoff') AND a.attname = c AND NOT a.attisdropped AND a.attnum > 0)), NULL, 'result_signoff has the 13 columns of the brief');
SELECT is((SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = to_regclass('lab.result_signoff') AND attname = 'seq'), 'smallint', 'seq is smallint');
SELECT is((SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = to_regclass('lab.result_signoff') AND attname = 'signer_is_pathologist'), 'boolean', 'signer_is_pathologist is boolean (a snapshot)');
SELECT is((SELECT string_agg(attname, ',' ORDER BY attname) FROM pg_attribute WHERE attrelid = to_regclass('lab.result_signoff') AND attname IN ('result_id','result_version','seq','action','signer_user_id','signer_display_name','signer_role_code','signer_is_pathologist','signed_at') AND NOT attnotnull),
  NULL, 'the snapshot columns are NOT NULL (a sign-off with no signer, role or time is not evidence)');
SELECT is((SELECT NOT attnotnull FROM pg_attribute WHERE attrelid = to_regclass('lab.result_signoff') AND attname = 'signer_signature_asset_id'), true, 'signer_signature_asset_id is nullable (a technologist has no signature image)');
SELECT is((SELECT (relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid = to_regclass('lab.result_signoff')), true, 'result_signoff: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('lab.result_signoff') AND polcmd IN ('d', 'w')), 0, 'result_signoff: no UPDATE and no DELETE policy (append only)');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('lab.result_signoff') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND coalesce(pg_get_expr(polwithcheck, polrelid), '') !~ 'tenant_id')), 0, 'result_signoff: every policy is tenant scoped');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'lab.result_signoff', 'SELECT') AND has_table_privilege('lims_app', 'lab.result_signoff', 'INSERT'))::text$q$), 'true', 'result_signoff: lims_app has SELECT and INSERT');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'lab.result_signoff', 'UPDATE') OR has_table_privilege('lims_app', 'lab.result_signoff', 'DELETE') OR has_table_privilege('lims_app', 'lab.result_signoff', 'TRUNCATE'))::text$q$),
  'false', 'result_signoff: lims_app has NO update, delete or truncate grant (brief done_when 3)');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_worker', 'lab.result_signoff', 'UPDATE') OR has_table_privilege('lims_worker', 'lab.result_signoff', 'DELETE') OR has_table_privilege('lims_worker', 'lab.result_signoff', 'TRUNCATE'))::text$q$),
  'false', 'result_signoff: lims_worker has no update, delete or truncate grant either');
SELECT is(pg_temp.q($q$SELECT (SELECT count(*) FROM information_schema.column_privileges WHERE table_schema = 'lab' AND table_name = 'result_signoff' AND grantee = 'lims_app' AND privilege_type IN ('UPDATE', 'DELETE'))::text$q$),
  '0', 'result_signoff: no column level UPDATE grant for lims_app either');

-- chain of result 54: v1 seq 1 verify (technologist 201), seq 2 approve (pathologist 202)
SELECT is(pg_temp.so(401, 54, 1, 1, 201, 'verify'), 'ok', 'chain: seq 1 verify by signer 201');
SELECT is(pg_temp.so(402, 54, 1, 2, 202, 'approve'), 'ok', 'chain: seq 2 approve by signer 202');
SELECT is(pg_temp.so(403, 54, 1, 2, 203, 'approve'), '23505', 'unique (result_id, result_version, seq): a second row for seq 2 is refused');
SELECT is(pg_temp.so(404, 54, 1, 3, 201, 'verify'), '23505', 'unique (result_id, result_version, signer_user_id): one person signs once per version');
SELECT is(pg_temp.so(405, 54, 1, 3, 203, 'verify'), 'ok', 'chain: seq 3 by a third person');
SELECT is(pg_temp.so(406, 54, 2, 1, 201, 'verify'), 'ok', 'chain: the same person may sign again on the next result version (an amendment is signed off again)');
SELECT is(pg_temp.so(407, 54, 1, 0, 204, 'verify'), '23514', 'seq 0 rejected');
SELECT is(pg_temp.so(408, 54, 1, 4, 204, 'verify'), '23514', 'seq 4 rejected (at most 3 people)');
SELECT is(pg_temp.so(409, 54, 3, 1, 204, 'reject'), '23514', 'action reject rejected (only verify and approve)');
SELECT is(pg_temp.so(410, 54, 0, 1, 204, 'verify'), '23514', 'result_version 0 rejected');
SELECT is(pg_temp.so(411, 54, 3, 1, 204, 'verify', jsonb_build_object('signer_display_name', NULL)), '23502', 'a sign-off without the signer name is rejected');
SELECT is(pg_temp.so(412, 54, 3, 1, 204, 'verify', jsonb_build_object('signer_is_pathologist', NULL)), '23502', 'a sign-off without the pathologist snapshot is rejected');
SELECT ok(pg_temp.so(413, 54, 3, 1, 204, 'verify', jsonb_build_object('signer_signature_asset_id', pg_temp.uid(950))) IN ('ok', '23503'), 'a sign-off may carry a signature asset snapshot (a snapshot, so no FK is needed; an FK to the asset table would answer 23503)');
SELECT is(pg_temp.so(414, 999, 1, 1, 204, 'verify'), '23503', 'a sign-off for a result that does not exist is rejected (composite FK)');
SELECT is(pg_temp.ins('lab.result_signoff', jsonb_build_object('id', pg_temp.uid(415), 'tenant_id', pg_temp.tb(), 'result_id', pg_temp.uid(54), 'result_version', 5, 'seq', 1, 'action', 'verify', 'signer_user_id', pg_temp.uid(210),
  'signer_display_name', 'Signer B (SYNTHETIC)', 'signer_role_code', 'lab_technologist', 'signer_is_pathologist', false, 'signed_at', '2026-11-17T04:00:00Z')), '23503', 'tenant B cannot sign off a tenant A result (composite FK on tenant_id, result_id)');
SELECT is(pg_temp.ins('lab.result_signoff', jsonb_build_object('id', pg_temp.uid(416), 'tenant_id', pg_temp.tb(), 'result_id', pg_temp.uid(58), 'result_version', 1, 'seq', 1, 'action', 'verify', 'signer_user_id', pg_temp.uid(210),
  'signer_display_name', 'Signer B (SYNTHETIC)', 'signer_role_code', 'lab_technologist', 'signer_is_pathologist', false, 'signed_at', '2026-11-17T04:00:00Z')), 'ok', 'tenant B signs off its own result');
SELECT is(pg_temp.so(417, 53, 1, 1, 201, 'verify'), 'ok', 'the verified result 53 carries its first sign-off');

-- the application role writes through the service path and can never change history
SELECT is(pg_temp.a($q$INSERT INTO lab.result_signoff (id, tenant_id, result_id, result_version, seq, action, signer_user_id, signer_display_name, signer_role_code, signer_is_pathologist, signed_at)
  VALUES ('0190c700-0000-7000-8000-000000000418', '01a1a98a-ac40-7000-8000-00000000a001', '0190c700-0000-7000-8000-000000000052', 1, 1, 'verify', '0190c700-0000-7000-8000-000000000205', 'Signer 205 (SYNTHETIC)', 'lab_technologist', false, now())$q$),
  'n=1', 'tenant A staff appends a sign-off');
SELECT is(pg_temp.a($q$UPDATE lab.result_signoff SET signer_display_name = 'edited' WHERE id = '0190c700-0000-7000-8000-000000000401'$q$), 'E42501', 'tenant A staff cannot UPDATE a sign-off (append only)');
SELECT is(pg_temp.a($q$UPDATE lab.result_signoff SET signer_is_pathologist = true WHERE id = '0190c700-0000-7000-8000-000000000401'$q$), 'E42501', 'tenant A staff cannot turn a technologist sign-off into a pathologist signature');
SELECT is(pg_temp.a($q$DELETE FROM lab.result_signoff WHERE id = '0190c700-0000-7000-8000-000000000401'$q$), 'E42501', 'tenant A staff cannot DELETE a sign-off');
SELECT is(pg_temp.a($q$TRUNCATE lab.result_signoff$q$), 'E42501', 'tenant A staff cannot TRUNCATE the chain');
SELECT is(pg_temp.q($q$SELECT signer_display_name FROM lab.result_signoff WHERE id = '0190c700-0000-7000-8000-000000000401'$q$), 'Signer 201 (SYNTHETIC)', 'the sign-off is unchanged after the refused UPDATE');
SELECT is(pg_temp.a($q$INSERT INTO lab.result_signoff (id, tenant_id, result_id, result_version, seq, action, signer_user_id, signer_display_name, signer_role_code, signer_is_pathologist, signed_at)
  VALUES ('0190c700-0000-7000-8000-000000000419', '01a1a98a-ac40-7000-8000-00000000b001', '0190c700-0000-7000-8000-000000000058', 1, 2, 'approve', '0190c700-0000-7000-8000-000000000211', 'Signer B2 (SYNTHETIC)', 'pathologist', true, now())$q$),
  'E42501', 'tenant A cannot append a sign-off for tenant B (RLS WITH CHECK)');
SELECT is(pg_temp.a($q$SELECT 1 FROM lab.result_signoff WHERE result_id = '0190c700-0000-7000-8000-000000000054'$q$, 'n'), 'n=5', 'tenant A staff reads the 5 sign-offs of result 54 (v1 x3, v2 x1, v3 x1)');
SELECT is(pg_temp.a($q$SELECT 1 FROM lab.result_signoff$q$, 'n'), 'n=7', 'tenant A staff sees its 7 sign-offs (54 x5, 53, 52)');
SELECT is(pg_temp.b($q$SELECT 1 FROM lab.result_signoff$q$, 'n'), 'n=1', 'tenant B staff sees its own 1 sign-off');
SELECT is(pg_temp.a($q$SELECT 1 FROM lab.result_signoff WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$, 'n'), 'n=0', 'tenant A cannot read tenant B sign-offs by filter');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM lab.result_signoff', 'n'), 'n=0', 'patient claims see 0 sign-offs');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner'), 'SELECT 1 FROM lab.result_signoff', 'n'), 'n=0', 'partner claims see 0 sign-offs');

-- ===================================================================================================================================== (3) lab.results: the two new columns and the lock
SELECT is((SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attname) FROM pg_attribute WHERE attrelid = to_regclass('lab.results') AND attname IN ('signoff_required', 'signoff_count') AND NOT attisdropped),
  'signoff_count:smallint,signoff_required:smallint', 'lab.results has signoff_required and signoff_count, both smallint');
SELECT is(pg_temp.q($q$SELECT signoff_count::text FROM lab.results WHERE id = '0190c700-0000-7000-8000-000000000051'$q$), '0', 'a row that never signed has signoff_count 0 (default)');
SELECT is(pg_temp.q($q$SELECT (attnotnull AND pg_get_expr(d.adbin, d.adrelid) = '0')::text FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = 'lab.results'::regclass AND a.attname = 'signoff_count'$q$),
  'true', 'signoff_count is NOT NULL DEFAULT 0');
SELECT is(pg_temp.a($q$UPDATE lab.results SET signoff_required = 2, signoff_count = 1 WHERE id = '0190c700-0000-7000-8000-000000000052'$q$), 'n=1', 'the service can move the counter of a resulted row');
SELECT is(pg_temp.a($q$UPDATE lab.results SET signoff_count = 2, status = 'verified', verified_at = now(), verified_by_membership_id = '01a1a98a-ac40-7000-8000-00000000a500' WHERE id = '0190c700-0000-7000-8000-000000000052'$q$), 'n=1', 'a row moves resulted -> verified with its counter');
SELECT is(pg_temp.a($q$UPDATE lab.results SET value_numeric = 9.9 WHERE id = '0190c700-0000-7000-8000-000000000054'$q$, 'wm'), 'EP0001|immutable_row', 'LOCK STAYS: an approved result still refuses a value change (immutable_row)');
SELECT is(pg_temp.a($q$UPDATE lab.results SET status = 'resulted' WHERE id = '0190c700-0000-7000-8000-000000000054'$q$), 'EP0001', 'LOCK STAYS: an approved result cannot go back to resulted');
SELECT is(pg_temp.a($q$UPDATE lab.results SET cancel_reason = 'x' WHERE id = '0190c700-0000-7000-8000-000000000055'$q$), 'EP0001', 'LOCK STAYS: a cancelled result is frozen');
SELECT is(pg_temp.a($q$UPDATE lab.results SET current_version_no = 2, signoff_count = 0, signoff_required = 2, version = version + 1 WHERE id = '0190c700-0000-7000-8000-000000000054'$q$), 'n=1',
  'an amendment of an approved result (new version) resets signoff_count / signoff_required together with current_version_no (it is signed off again)');
SELECT is(pg_temp.q($q$SELECT value_numeric::text FROM lab.results WHERE id = '0190c700-0000-7000-8000-000000000054'$q$), '5.4', 'the approved value is unchanged by all of the above');

-- ===================================================================================================================================== (4) backfill of existing rows + idempotent re-apply
-- The two columns are dropped (the state before the migration), the migration is applied again and must (a) re-create them, (b) fill every existing row, (c) change nothing else.
CREATE TEMP TABLE before_state AS
  SELECT (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped) AS cols,
         (SELECT count(*) FROM pg_constraint k WHERE k.connamespace = 'lab'::regnamespace) AS cons,
         (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'lab'::regnamespace) AS idxs,
         (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = 'lab'::regnamespace) AS pols,
         (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'lab'::regnamespace AND NOT t.tgisinternal) AS trgs,
         (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind IN ('r','p')) AS tbls,
         (SELECT count(*) FROM lab.verification_policy) AS n_policy, (SELECT count(*) FROM lab.result_signoff) AS n_signoff, (SELECT count(*) FROM lab.results) AS n_results;
ALTER TABLE lab.results DROP COLUMN signoff_required CASCADE, DROP COLUMN signoff_count CASCADE;
SELECT is((SELECT count(*)::int FROM pg_attribute WHERE attrelid = to_regclass('lab.results') AND attname IN ('signoff_required', 'signoff_count') AND NOT attisdropped), 0, 'precondition: lab.results is back to its pre-migration shape');
\ir ../../migrations/20261117150000_lab__add_verification_policy_and_signoffs.sql
RESET ROLE;
SELECT is((SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attname) FROM pg_attribute WHERE attrelid = to_regclass('lab.results') AND attname IN ('signoff_required', 'signoff_count') AND NOT attisdropped),
  'signoff_count:smallint,signoff_required:smallint', 're-apply re-creates the two columns');
-- result 51 pending, 52 verified (moved above), 53 verified, 54 approved, 55 cancelled, 58 (tenant B) resulted. After the drop every row is "existing".
SELECT is(pg_temp.q($q$SELECT signoff_required || '/' || signoff_count FROM lab.results WHERE id = '0190c700-0000-7000-8000-000000000051'$q$), '2/0', 'backfill: pending row -> required 2, count 0');
SELECT is(pg_temp.q($q$SELECT signoff_required || '/' || signoff_count FROM lab.results WHERE id = '0190c700-0000-7000-8000-000000000052'$q$), '2/1', 'backfill: verified row -> required 2, count 1');
SELECT is(pg_temp.q($q$SELECT signoff_required || '/' || signoff_count FROM lab.results WHERE id = '0190c700-0000-7000-8000-000000000053'$q$), '2/1', 'backfill: second verified row -> required 2, count 1');
SELECT is(pg_temp.q($q$SELECT signoff_required || '/' || signoff_count FROM lab.results WHERE id = '0190c700-0000-7000-8000-000000000054'$q$), '2/2', 'backfill: approved row -> required 2, count 2 (past the result lock)');
SELECT is(pg_temp.q($q$SELECT signoff_count::text FROM lab.results WHERE id = '0190c700-0000-7000-8000-000000000055'$q$), '0', 'backfill: cancelled row keeps count 0 and does not make the migration fail');
SELECT is(pg_temp.q($q$SELECT signoff_required || '/' || signoff_count FROM lab.results WHERE id = '0190c700-0000-7000-8000-000000000058'$q$), '2/0', 'backfill: tenant B resulted row -> required 2, count 0 (every tenant)');
SELECT is(pg_temp.q($q$SELECT count(*)::text FROM lab.results WHERE status <> 'cancelled' AND (signoff_required IS NULL OR signoff_required <> 2)$q$), '0', 'backfill: no live row is left without required 2');
SELECT is(pg_temp.q($q$SELECT value_numeric::text FROM lab.results WHERE id = '0190c700-0000-7000-8000-000000000054'$q$), '5.4', 'backfill did not touch the approved value');
SELECT is(pg_temp.q($q$SELECT approved_by_membership_id::text FROM lab.results WHERE id = '0190c700-0000-7000-8000-000000000054'$q$), '01a1a98a-ac40-7000-8000-00000000a500', 'backfill did not touch the approver');
-- rows that already hold new-model values are never rewritten: a mid-chain row (level 3, one signature) and a level 1 approval
SELECT pg_temp.fx('lab.results', jsonb_build_object('id', pg_temp.uid(59), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'order_id', pg_temp.uid(11), 'order_item_id', pg_temp.uid(21), 'order_test_id', pg_temp.uid(41),
  'specimen_id', pg_temp.uid(31), 'patient_id', pg_temp.uid(1), 'test_id', pg_temp.uid(99), 'analyte_id', pg_temp.uid(109), 'analyte_code', 'AN59', 'department_id', pg_temp.uid(97), 'is_reportable', true, 'result_type', 'numeric',
  'status', 'resulted', 'origin', 'manual', 'value_numeric', 5.9, 'flag', 'N', 'first_resulted_at', now(), 'resulted_at', now(), 'signoff_required', 3, 'signoff_count', 1));
SELECT pg_temp.fx('lab.results', jsonb_build_object('id', pg_temp.uid(60), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'order_id', pg_temp.uid(11), 'order_item_id', pg_temp.uid(21), 'order_test_id', pg_temp.uid(41),
  'specimen_id', pg_temp.uid(31), 'patient_id', pg_temp.uid(1), 'test_id', pg_temp.uid(99), 'analyte_id', pg_temp.uid(110), 'analyte_code', 'AN60', 'department_id', pg_temp.uid(97), 'is_reportable', true, 'result_type', 'numeric',
  'status', 'approved', 'origin', 'manual', 'value_numeric', 6.0, 'flag', 'N', 'first_resulted_at', now(), 'resulted_at', now(), 'approved_at', now(), 'approved_by_membership_id', pg_temp.id('00000000a500'), 'signoff_required', 1, 'signoff_count', 1));
\ir ../../migrations/20261117150000_lab__add_verification_policy_and_signoffs.sql
RESET ROLE;
SELECT is(pg_temp.q($q$SELECT signoff_required || '/' || signoff_count FROM lab.results WHERE id = '0190c700-0000-7000-8000-000000000059'$q$), '3/1', 're-apply: a level 3 row that is one signature in keeps 3 / 1 (the backfill never rewrites new-model rows)');
SELECT is(pg_temp.q($q$SELECT signoff_required || '/' || signoff_count FROM lab.results WHERE id = '0190c700-0000-7000-8000-000000000060'$q$), '1/1', 're-apply: a level 1 approval keeps 1 / 1 (not pushed back to 2 / 2)');
SELECT is(pg_temp.q($q$SELECT signoff_required || '/' || signoff_count FROM lab.results WHERE id = '0190c700-0000-7000-8000-000000000054'$q$), '2/2', 're-apply: the backfilled approved row is stable');
SELECT is((SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped), (SELECT cols FROM before_state), 're-apply: lab column count equals the count before the drop (the two columns are back, nothing else)');
SELECT is((SELECT count(*) FROM pg_constraint k WHERE k.connamespace = 'lab'::regnamespace), (SELECT cons FROM before_state), 're-apply: constraint count unchanged');
SELECT is((SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'lab'::regnamespace), (SELECT idxs FROM before_state), 're-apply: index count unchanged');
SELECT is((SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = 'lab'::regnamespace), (SELECT pols FROM before_state), 're-apply: policy count unchanged');
SELECT is((SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'lab'::regnamespace AND NOT t.tgisinternal), (SELECT trgs FROM before_state), 're-apply: trigger count unchanged');
SELECT is((SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'lab'::regnamespace AND c.relkind IN ('r','p')), (SELECT tbls FROM before_state), 're-apply: table count unchanged');
SELECT is((SELECT count(*) FROM lab.verification_policy), (SELECT n_policy FROM before_state), 're-apply: no policy row added (the default policy is not duplicated, ON CONFLICT safe)');
SELECT is((SELECT count(*) FROM lab.result_signoff), (SELECT n_signoff FROM before_state), 're-apply: no sign-off row added or removed (the chain is never rewritten)');
SELECT is((SELECT count(*) FROM lab.results), (SELECT n_results + 2 FROM before_state), 're-apply: no result row added or removed (the two fixtures above are the only new rows)');
SELECT is(pg_temp.q($q$SELECT count(*)::text FROM lab.verification_policy WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001' AND scope = 'lab' AND active$q$), '1', 're-apply: tenant A still has exactly one active lab scope policy');
SELECT is(pg_temp.q($q$SELECT required_verifiers || '/' || require_pathologist || '/' || allow_enterer_verify FROM lab.verification_policy WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001' AND scope = 'lab' AND active$q$), '2/true/false', 're-apply: the default policy values are intact');
SELECT is(pg_temp.try($q$UPDATE lab.results SET value_numeric = 9.9 WHERE id = '0190c700-0000-7000-8000-000000000054'$q$), 'P0001', 're-apply: the result lock is intact (approved value cannot change)');
SELECT is(pg_temp.a($q$UPDATE lab.result_signoff SET seq = 3 WHERE id = '0190c700-0000-7000-8000-000000000401'$q$), 'E42501', 're-apply: the chain is still append only');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('lab.result_signoff')), true, 're-apply: result_signoff keeps RLS FORCE');

SELECT * FROM finish();
ROLLBACK;
