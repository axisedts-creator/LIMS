-- T0B-13.C18 live-DB behaviour under FORCE RLS: the 11 DB tests of C18 05-SCHEMA §12 (REQ-SEC-042; 08 A17 P-16 / P-18, A19 D-133 / D-134).
-- ACs: AC-0B-2.1 AC-0B-2.2 AC-0B-2.3 AC-0B-2.4 (policies + FORCE RLS exercised), AC-0B-3.1 AC-0B-3.2 AC-0B-3.3 AC-0B-3.4 AC-0B-3.5 AC-0B-3.6 AC-0B-3.7 (tenant isolation, P-16 actor guard), AC-0B-4.1 AC-0B-4.2 AC-0B-4.3 (immutability, append-only, grants),
-- AC-0B-5.1 AC-0B-5.2 AC-0B-5.3 (no row audit on staging rows), AC-0B-6.1 AC-0B-6.2 AC-0B-6.3 AC-0B-6.4 (apply order, owner, no view).
-- Synthetic data only. One rolled-back transaction. RLS is never disabled for the assertions (rows are seeded with session_replication_role = replica, as the isolation probes do; replica mode is reset to origin before the first assertion;
-- CHECK constraints still apply, so every seeded row is valid). Counts marked "superuser" bypass RLS and show the truth, not a policy-filtered view.
-- Run: pg_prove -d <migrated db with the migration_staging DDL and the lims_migration role> db/tests/migration_staging/T0B-13.C18_behaviour.test.sql   (superuser; pgTAP in schema `extensions`; run from the repo root)
-- Needs a live Postgres with C0 + C18 migrations; it is NOT part of .orchestra/notes/T0B-13.C18-verify.cmd (no database in the unit-test environment).
-- Fails now: migration_staging.* and the role lims_migration do not exist in the migrated database.
-- Markers: "-- C18 T<n>" = §12 test n (1 RLS probe per table, 2 no privilege for other roles, 3 purge DELETE by run state, 4 append-only, 5 lifecycle guard, 6 immutable columns, 7 one writing run, 8 no audit trigger on staging rows,
-- 9 P-16 guard probe partner / portal / patient, 10 decided match pair needs lab_form_reference, 11 EXECUTE on the two DEFINERs only). T1 covers all 16 tables; the generated probes db/tests/isolation/migration_staging.*.test.sql repeat it per table.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\ir ../fixtures/T0B-06_identity_standin.sql

CREATE FUNCTION pg_temp.id(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01950c18-0000-7000-8000-' || lpad(to_hex(k), 12, '0'))::uuid $$;
-- claims of actor type p_type in tenant #p_tenant (1 = A, 2 = B)
CREATE FUNCTION pg_temp.cl(p_type text, p_tenant int) RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', pg_temp.id(p_tenant), 'sub', pg_temp.id(99))::text $$;
-- run p_sql as p_role with p_claims. modes: v scalar text, n row count of a SELECT, w DML row count. Errors -> 'E<SQLSTATE>:<message>'.
CREATE FUNCTION pg_temp.x(p_role text, p_claims text, p_sql text, p_mode text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSIF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := n::text;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := n::text; END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.m(p_type text, p_tenant int, p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_migration', pg_temp.cl(p_type, p_tenant), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $$ DECLARE r text; BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r, '<null>'); END $$;   -- superuser value (RLS bypassed)
-- one valid INSERT per table. tn = tenant (1 / 2), k = row key (unique per table and tenant), r = run number (run id = tn*1000 + r). Patient rows: id tn*1000 + 100 + r (r = 1..5), extra run-1 patients 106, 107.
-- LD-230 (5): PL/pgSQL DECLARE takes one declaration per ";" (a comma made the next ":=" a syntax error)
CREATE FUNCTION pg_temp.ins(p_t text, tn int, k int, r int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE tid text := format('pg_temp.id(%s)', tn); rid text := format('pg_temp.id(%s)', tn * 1000 + r); me text := 'pg_temp.id(99)'; i text := format('pg_temp.id(%s)', tn * 1000 + k);
        h text := format('md5(%L) || md5(%L)', 'h' || tn || '_' || k, 'k' || tn || '_' || k); a text := replace(translate(k::text, '0123456789', 'abcdefghij'), '-', 'z');
BEGIN
  RETURN CASE p_t
    WHEN 'runs' THEN format('INSERT INTO migration_staging.runs (id, tenant_id, run_code, source_system, kind, created_by, updated_by) VALUES (%s, %s, %L, %L, %L, %s, %s)', i, tid, 'MR-hc18-2026-' || tn || '-' || k, 'legacy_a', 'full', me, me)
    WHEN 'run_events' THEN format('INSERT INTO migration_staging.run_events (id, tenant_id, run_id, kind, command, args_sha256, outcome, exit_code, tool_version, host_name, operator_unix_user, created_by) VALUES (%s, %s, %s, %L, %L, %s, %L, 0, %L, %L, %L, %s)', i, tid, rid, 'status', 'status', h, 'ok', '1.0', 'host', 'op', me)
    WHEN 'run_files' THEN format('INSERT INTO migration_staging.run_files (id, tenant_id, run_id, path, file_kind, created_by, updated_by) VALUES (%s, %s, %s, %L, %L, %s, %s)', i, tid, rid, 'f_' || a || '.csv', 'csv', me, me)
    WHEN 'crosswalk_entries' THEN format('INSERT INTO migration_staging.crosswalk_entries (id, tenant_id, source_system, entity_kind, legacy_code, target_code, operator_id, created_by, updated_by) VALUES (%s, %s, %L, %L, %L, %L, %s, %s, %s)', i, tid, 'legacy_a', 'sex', 'S' || k, 'male', me, me, me)
    WHEN 'batches' THEN format('INSERT INTO migration_staging.batches (id, tenant_id, run_id, entity, seq, row_count, content_sha256, created_by, updated_by) VALUES (%s, %s, %s, %L, %s, 1, %s, %s, %s)', i, tid, rid, 'patients', k, h, me, me)
    WHEN 'reports' THEN format('INSERT INTO migration_staging.reports (id, tenant_id, run_id, report_kind, invariant_ok, body, created_by) VALUES (%s, %s, %s, %L, true, %L::jsonb, %s)', i, tid, rid, 'dry_run', '{}', me)
    WHEN 'signoffs' THEN format('INSERT INTO migration_staging.signoffs (id, tenant_id, run_id, kind, platform_staff_id, created_by) VALUES (%s, %s, %s, %L, %s, %s)', i, tid, rid, 'load_approval', me, me)
    WHEN 'stg_patients' THEN format('INSERT INTO migration_staging.stg_patients (id, tenant_id, run_id, row_no, source_row_sha256, legacy_patient_key, created_by) VALUES (%s, %s, %s, %s, %s, %L, %s)', i, tid, rid, k, h, 'P' || k, me)
    WHEN 'stg_visits' THEN format('INSERT INTO migration_staging.stg_visits (id, tenant_id, run_id, row_no, source_row_sha256, legacy_visit_key, legacy_patient_key, created_by) VALUES (%s, %s, %s, %s, %s, %L, %L, %s)', i, tid, rid, k, h, 'V' || k, 'P' || k, me)
    WHEN 'stg_results' THEN format('INSERT INTO migration_staging.stg_results (id, tenant_id, run_id, row_no, source_row_sha256, legacy_result_key, legacy_patient_key, legacy_test_code, legacy_analyte_code, analyte_display_name, result_status_raw, created_by) VALUES (%s, %s, %s, %s, %s, %L, %L, %L, %L, %L, %L, %s)', i, tid, rid, k, h, 'R' || k, 'P' || k, 'T1', 'A1', 'Synthetic analyte', 'F', me)
    WHEN 'stg_documents' THEN format('INSERT INTO migration_staging.stg_documents (id, tenant_id, run_id, row_no, source_row_sha256, legacy_document_key, legacy_patient_key, document_kind_raw, file_path, sha256, size_bytes, created_by) VALUES (%s, %s, %s, %s, %s, %L, %L, %L, %L, %s, 1000, %s)', i, tid, rid, k, h, 'D' || k, 'P' || k, 'rpt', 'documents/d' || k || '.pdf', h, me)
    WHEN 'stg_financial' THEN format('INSERT INTO migration_staging.stg_financial (id, tenant_id, run_id, row_no, source_row_sha256, item_kind, legacy_item_key, created_by) VALUES (%s, %s, %s, %s, %s, %L, %L, %s)', i, tid, rid, k, h, 'patient_due', 'F' || k, me)
    WHEN 'stg_masters' THEN format('INSERT INTO migration_staging.stg_masters (id, tenant_id, run_id, entity_kind, row_no, source_row_sha256, legacy_code, payload, created_by) VALUES (%s, %s, %s, %L, %s, %s, %L, %L::jsonb, %s)', i, tid, rid, 'test', k, h, 'M' || k, '{}', me)
    WHEN 'match_pairs' THEN format('INSERT INTO migration_staging.match_pairs (id, tenant_id, run_id, match_class, row_a_id, row_b_id, row_a_sha256, row_b_sha256, created_by) VALUES (%s, %s, %s, %L, pg_temp.id(%s), pg_temp.id(%s), %s, %s, %s)', i, tid, rid, 'strong', tn * 1000 + 101, tn * 1000 + CASE WHEN k = 1 THEN 106 ELSE 107 END, h, h, me)
    WHEN 'issues' THEN format('INSERT INTO migration_staging.issues (id, tenant_id, run_id, seq, entity, rule_code, severity, message, created_by) VALUES (%s, %s, %s, %s, %L, %L, %L, %L, %s)', i, tid, rid, k, 'run', 'mig.run.sample', 'error', 'synthetic issue', me)
    WHEN 'samples' THEN format('INSERT INTO migration_staging.samples (id, tenant_id, run_id, seed_sha256, stratum, stg_patient_id, created_by) VALUES (%s, %s, %s, %s, %L, pg_temp.id(%s), %s)', i, tid, rid, h, 'first_visit_year:2024', tn * 1000 + 101, me)
  END;
END $$;
CREATE TEMP TABLE tbl(t) AS VALUES ('runs'),('run_events'),('run_files'),('crosswalk_entries'),('batches'),('reports'),('signoffs'),('stg_patients'),('stg_visits'),('stg_results'),('stg_documents'),('stg_financial'),('stg_masters'),('match_pairs'),('issues'),('samples');

-- ---------------------------------------------------------------- fixtures: tenant A (1) and B (2). Runs 1..5: 1 loaded, 2 signed_off (purge_not_before in the future), 3 signed_off (purge_not_before passed),
-- 4 signed_off (future, with an early_purge_approval signoff), 5 abandoned (no purge_not_before). One staged patient per run (101..105) + two more in run 1 (106, 107).
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id(1), 'hc18_a', 'Lab A', 'Lab A', 'active', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), 'hc18_b', 'Lab B', 'Lab B', 'active', pg_temp.id(99), pg_temp.id(99));
DO $seed$
DECLARE tn int; r int; st text[] := ARRAY['loaded','signed_off','signed_off','signed_off','abandoned']; pnb text[] := ARRAY['NULL', 'now() + interval ''30 days''', 'now() - interval ''1 day''', 'now() + interval ''30 days''', 'NULL'];
BEGIN
  FOR tn IN 1..2 LOOP
    FOR r IN 1..5 LOOP
      EXECUTE pg_temp.ins('runs', tn, r, 1);
      EXECUTE format('UPDATE migration_staging.runs SET status = %L, signed_off_at = %s, purge_not_before = %s, end_reason_code = %s WHERE id = pg_temp.id(%s)', st[r], CASE WHEN st[r] = 'signed_off' THEN 'now() - interval ''40 days''' ELSE 'NULL' END, pnb[r], CASE WHEN st[r] = 'abandoned' THEN '''operator_abandon''' ELSE 'NULL' END, tn * 1000 + r);
      EXECUTE pg_temp.ins('stg_patients', tn, 100 + r, r);
    END LOOP;
    EXECUTE pg_temp.ins('stg_patients', tn, 106, 1); EXECUTE pg_temp.ins('stg_patients', tn, 107, 1);
    EXECUTE format('INSERT INTO migration_staging.signoffs (id, tenant_id, run_id, kind, platform_staff_id, created_by) VALUES (pg_temp.id(%s), pg_temp.id(%s), pg_temp.id(%s), %L, pg_temp.id(99), pg_temp.id(99))', tn * 1000 + 40, tn, tn * 1000 + 4, 'early_purge_approval');
    -- the other 14 tables (not runs, not stg_patients, not the early approval signoff): one row in run 1
    EXECUTE pg_temp.ins('run_events', tn, 11, 1); EXECUTE pg_temp.ins('run_files', tn, 12, 1); EXECUTE pg_temp.ins('crosswalk_entries', tn, 13, 1); EXECUTE pg_temp.ins('batches', tn, 14, 1);
    EXECUTE pg_temp.ins('reports', tn, 15, 1); EXECUTE pg_temp.ins('signoffs', tn, 16, 1); EXECUTE pg_temp.ins('stg_visits', tn, 17, 1); EXECUTE pg_temp.ins('stg_results', tn, 18, 1);
    EXECUTE pg_temp.ins('stg_documents', tn, 19, 1); EXECUTE pg_temp.ins('stg_financial', tn, 20, 1); EXECUTE pg_temp.ins('stg_masters', tn, 21, 1); EXECUTE pg_temp.ins('match_pairs', tn, 1, 1);
    EXECUTE pg_temp.ins('issues', tn, 1, 1); EXECUTE pg_temp.ins('samples', tn, 23, 1);
  END LOOP;
END $seed$;
SET LOCAL session_replication_role = origin;
-- HARNESS fix T0B-GREEN-2 (CR T0B-GREEN-2.migration-staging-loader-role): under LD-226 lims_migration has no lims_app membership, so it has no EXECUTE on app.current_tenant_id() /
-- app.is_staff_or_system() and every query of a migration_staging table fails with E42501 "permission denied for function current_tenant_id" (the psql abort at the first T1 line).
-- The first assertion pins that current state (red when D-136 is decided and the grant lands); then the D-136 PROPOSED EXCEPTION of C18 05-SCHEMA s2 is applied inside this rolled-back
-- transaction only, so T1..T11 prove the policies, grants and guards as the spec defines them for the loader.
SELECT is(has_function_privilege('lims_migration', 'app.current_tenant_id()', 'EXECUTE'), false, 'C18 setup / LD-226: without the D-136 grant lims_migration cannot evaluate its own policies (CR T0B-GREEN-2 migration-staging-loader-role)');
GRANT lims_app TO lims_migration WITH INHERIT TRUE, SET FALSE;

-- C18 T1 (§12.1): every table, claims of tenant A as lims_migration + actor system: SELECT sees A's rows only (>= 1, 0 of B); INSERT with B's tenant_id fails; UPDATE / DELETE of B rows affect 0 rows (AC-0B-3.1, 3.2, 3.3, 3.4, 3.7)
SELECT cmp_ok(pg_temp.m('system', 1, format('SELECT 1 FROM migration_staging.%I', t), 'n')::int, '>=', 1, 'C18 T1 / AC-0B-3.1: tenant A (system actor) sees its own rows of migration_staging.' || t) FROM tbl;
SELECT is(pg_temp.m('system', 1, format('SELECT 1 FROM migration_staging.%I WHERE tenant_id = pg_temp.id(2)', t), 'n'), '0', 'C18 T1 / AC-0B-3.2: tenant A reads 0 rows of tenant B in migration_staging.' || t) FROM tbl;
SELECT is(left(pg_temp.m('system', 1, pg_temp.ins(t, 2, 900, 1)), 6), 'E42501', 'C18 T1 / AC-0B-3.3: INSERT of a tenant-B row under tenant-A claims is rejected by RLS on migration_staging.' || t) FROM tbl;
SELECT is(pg_temp.m('system', 1, pg_temp.ins(t, 1, 900, 1)), '1', 'C18 T1 / AC-0B-3.4: INSERT of a tenant-A row under tenant-A claims succeeds on migration_staging.' || t) FROM tbl;
SELECT is(pg_temp.m('system', 1, format('UPDATE migration_staging.%I SET tenant_id = tenant_id WHERE tenant_id = pg_temp.id(2)', t)), '0', 'C18 T1 / AC-0B-3.3: UPDATE of tenant-B rows affects 0 rows in migration_staging.' || t) FROM tbl WHERE t NOT IN ('run_events', 'reports', 'signoffs', 'issues');
SELECT is(left(pg_temp.m('system', 1, format('UPDATE migration_staging.%I SET tenant_id = tenant_id WHERE tenant_id = pg_temp.id(2)', t)), 6), 'E42501', 'C18 T1 / AC-0B-4.2: append-only / recomputed table migration_staging.' || t || ' has no UPDATE privilege at all') FROM tbl WHERE t IN ('run_events', 'reports', 'signoffs', 'issues');
SELECT is(pg_temp.m('system', 1, format('DELETE FROM migration_staging.%I WHERE tenant_id = pg_temp.id(2)', t)), '0', 'C18 T1 / AC-0B-3.3: DELETE of tenant-B rows affects 0 rows in migration_staging.' || t) FROM tbl WHERE t IN ('stg_patients', 'stg_visits', 'stg_results', 'stg_documents', 'stg_financial', 'stg_masters', 'match_pairs', 'samples', 'issues');
SELECT is(pg_temp.m('system', 3, 'SELECT count(*) FROM migration_staging.runs', 'v'), '0', 'C18 T1 / AC-0B-3.5: a tenant claim for an unknown tenant sees no row');
SELECT is(pg_temp.x('lims_migration', jsonb_build_object('actor_type', 'system', 'sub', pg_temp.id(99))::text, 'SELECT count(*) FROM migration_staging.runs', 'v'), '0', 'C18 T1 / AC-0B-3.5: no tenant claim -> no row (fail closed)');
SELECT is((SELECT count(*)::int FROM migration_staging.runs WHERE tenant_id = pg_temp.id(1)), 6, 'C18 T1: control (superuser): the 5 seeded tenant-A runs plus the one inserted by the AC-0B-3.4 line above are really there (the zeros above are not vacuous)');

-- C18 T2 (§12.2): lims_api, lims_worker, lims_app (directly), lims_analytics, anon, authenticated: no SELECT on any table, no USAGE on the schema (AC-0B-4.3, §1.1)
SELECT is(has_table_privilege(r, 'migration_staging.' || t, 'SELECT'), false, 'C18 T2 / AC-0B-4.3: ' || r || ' has no SELECT on migration_staging.' || t) FROM tbl, unnest(ARRAY['lims_api','lims_worker','lims_app','lims_analytics','anon','authenticated']) r;
SELECT is(has_schema_privilege(r, 'migration_staging', 'USAGE'), false, 'C18 T2 / §1.1: ' || r || ' has no USAGE on schema migration_staging') FROM unnest(ARRAY['lims_api','lims_worker','lims_app','lims_analytics','anon','authenticated']) r;
SELECT is(left(pg_temp.x(r, pg_temp.cl('system', 1), 'SELECT count(*) FROM migration_staging.runs', 'v'), 6), 'E42501', 'C18 T2: ' || r || ' cannot read migration_staging.runs (permission denied)') FROM unnest(ARRAY['lims_api','lims_worker','lims_app']) r;

-- C18 T3 (§12.3): lims_migration DELETE on stg_patients by the state of the run (AC-0B-2.2, 4.2)
SELECT is(pg_temp.m('system', 1, format('DELETE FROM migration_staging.stg_patients WHERE run_id = pg_temp.id(1001)')), '0', 'C18 T3 / AC-0B-4.2: DELETE of stg_patients of a run in loaded affects 0 rows');
SELECT is(pg_temp.m('system', 1, format('DELETE FROM migration_staging.stg_patients WHERE run_id = pg_temp.id(1002)')), '0', 'C18 T3 / AC-0B-4.2: DELETE of a signed_off run before purge_not_before without early approval affects 0 rows');
SELECT is(pg_temp.m('system', 1, format('DELETE FROM migration_staging.stg_patients WHERE run_id = pg_temp.id(1003)')), '1', 'C18 T3 / AC-0B-4.2: DELETE of a signed_off run after purge_not_before succeeds');
SELECT is(pg_temp.m('system', 1, format('DELETE FROM migration_staging.stg_patients WHERE run_id = pg_temp.id(1004)')), '1', 'C18 T3 / AC-0B-4.2: DELETE before purge_not_before succeeds once an early_purge_approval signoff exists (D-133)');
SELECT is(pg_temp.m('system', 1, format('DELETE FROM migration_staging.stg_patients WHERE run_id = pg_temp.id(1005)')), '1', 'C18 T3 / AC-0B-4.2: DELETE of an abandoned run (no purge_not_before) succeeds');
SELECT is(pg_temp.m('system', 1, format('DELETE FROM migration_staging.stg_patients WHERE run_id = pg_temp.id(2003)')), '0', 'C18 T3 / AC-0B-3.3: DELETE of tenant B purgeable rows under tenant-A claims affects 0 rows');
SELECT cmp_ok((SELECT count(*)::int FROM migration_staging.stg_patients WHERE run_id = pg_temp.id(1001)), '>=', 3, 'C18 T3: the protected rows of the loaded run are still there (superuser)');
SELECT is((SELECT count(*)::int FROM migration_staging.stg_patients WHERE run_id = pg_temp.id(1002)), 1, 'C18 T3: the protected row of the signed_off run before purge_not_before is still there (superuser)');
SELECT is(pg_temp.m('system', 1, 'DELETE FROM migration_staging.stg_visits WHERE run_id = pg_temp.id(1001)'), '0', 'C18 T3: the same run-state rule holds on stg_visits (run in loaded)');
SELECT cmp_ok(pg_temp.m('system', 1, 'DELETE FROM migration_staging.issues WHERE run_id = pg_temp.id(1001)')::int, '>=', 1, 'C18 T3 / §5 (d): issues may be deleted in any run state (validate recomputes them)');
SELECT is(left(pg_temp.m('system', 1, 'DELETE FROM migration_staging.runs WHERE id = pg_temp.id(1005)'), 6), 'E42501', 'C18 T3 / AC-0B-4.2: runs are never deleted (no DELETE grant)');

-- C18 T4 (§12.4): append-only run_events, reports, signoffs: UPDATE by lims_migration -> permission denied; DELETE too (AC-0B-4.2)
SELECT is(left(pg_temp.m('system', 1, format('UPDATE migration_staging.%I SET created_by = created_by', t)), 6), 'E42501', 'C18 T4 / AC-0B-4.2: UPDATE on append-only migration_staging.' || t || ' -> permission denied') FROM unnest(ARRAY['run_events','reports','signoffs']) t;
SELECT is(left(pg_temp.m('system', 1, format('DELETE FROM migration_staging.%I', t)), 6), 'E42501', 'C18 T4 / AC-0B-4.2: DELETE on append-only migration_staging.' || t || ' -> permission denied') FROM unnest(ARRAY['run_events','reports','signoffs']) t;

-- C18 T5 (§12.5): runs lifecycle guard (migration_staging.runs_lifecycle_guard, BEFORE UPDATE on runs): a representative forbidden transition (validated -> loading) is rejected; the 22 transitions T1..T22 of 03-APP-FLOW §2 are accepted (AC-0B-4.1)
CREATE FUNCTION pg_temp.mv(p_run int, p_to text, p_extra text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.cl('system', 1), true);   -- HARNESS fix T0B-GREEN-2: migration_staging.runs has runs__audit (class M), which raises audit_context_missing without claims
  EXECUTE format('UPDATE migration_staging.runs SET status = %L, updated_at = now() %s WHERE id = pg_temp.id(%s)', p_to, p_extra, p_run);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN 'E' || SQLSTATE || ':' || SQLERRM;
END $$;
DO $mk$ DECLARE k int; BEGIN PERFORM set_config('request.jwt.claims', pg_temp.cl('system', 1), true); FOR k IN 31..40 LOOP EXECUTE pg_temp.ins('runs', 1, k, 1); END LOOP; END $mk$;   -- 10 fresh runs in tenant A, status created (ids 1031..1040)
SELECT matches(pg_temp.mv(1031, 'loading'), '^E', 'C18 T5 / §12.5: created -> loading is rejected');
SELECT is(pg_temp.mv(1031, 'staging'), 'ok', 'C18 T5 / T2: created -> staging');
SELECT is(pg_temp.mv(1031, 'staged'), 'ok', 'C18 T5 / T3: staging -> staged');
SELECT is(pg_temp.mv(1031, 'validating'), 'ok', 'C18 T5 / T4: staged -> validating');
SELECT is(pg_temp.mv(1031, 'validated'), 'ok', 'C18 T5 / T5: validating -> validated');
SELECT matches(pg_temp.mv(1031, 'loading'), 'P0001', 'C18 T5 / §12.5: validated -> loading is rejected with P0001 (the representative forbidden transition)');
SELECT is((SELECT status FROM migration_staging.runs WHERE id = pg_temp.id(1031)), 'validated', 'C18 T5: the rejected transition left the status unchanged');
SELECT is(pg_temp.mv(1031, 'dry_running'), 'ok', 'C18 T5 / T7: validated -> dry_running');
SELECT is(pg_temp.mv(1031, 'dry_run_passed'), 'ok', 'C18 T5 / T8: dry_running -> dry_run_passed');
SELECT is(pg_temp.mv(1031, 'approved_for_load'), 'ok', 'C18 T5 / T11: dry_run_passed -> approved_for_load');
SELECT is(pg_temp.mv(1031, 'loading'), 'ok', 'C18 T5 / T12: approved_for_load -> loading');
SELECT is(pg_temp.mv(1031, 'loaded'), 'ok', 'C18 T5 / T13: loading -> loaded');
SELECT is(pg_temp.mv(1031, 'verifying'), 'ok', 'C18 T5 / T15: loaded -> verifying');
SELECT is(pg_temp.mv(1031, 'verified'), 'ok', 'C18 T5 / T16: verifying -> verified');
SELECT is(pg_temp.mv(1031, 'signed_off', ', signed_off_at = now(), purge_not_before = now() + interval ''30 days'''), 'ok', 'C18 T5 / T18: verified -> signed_off');
SELECT is(pg_temp.mv(1031, 'purged'), 'ok', 'C18 T5 / T21: signed_off -> purged');
SELECT matches(pg_temp.mv(1031, 'created'), '^E', 'C18 T5: purged is terminal');
SELECT is(pg_temp.mv(1032, 'staging'), 'ok', 'C18 T5: run 1032 created -> staging'); SELECT is(pg_temp.mv(1032, 'staged'), 'ok', 'C18 T5: staging -> staged'); SELECT is(pg_temp.mv(1032, 'validating'), 'ok', 'C18 T5: staged -> validating');
SELECT is(pg_temp.mv(1032, 'validation_failed'), 'ok', 'C18 T5 / T6: validating -> validation_failed');
SELECT is(pg_temp.mv(1032, 'validating'), 'ok', 'C18 T5 / T4: validation_failed -> validating');
SELECT is(pg_temp.mv(1032, 'validated'), 'ok', 'C18 T5: validating -> validated'); SELECT is(pg_temp.mv(1032, 'dry_running'), 'ok', 'C18 T5: validated -> dry_running');
SELECT is(pg_temp.mv(1032, 'dry_run_failed'), 'ok', 'C18 T5 / T9: dry_running -> dry_run_failed');
SELECT is(pg_temp.mv(1032, 'validating'), 'ok', 'C18 T5 / T10: dry_run_failed -> validating');
SELECT is(pg_temp.mv(1032, 'abandoned', ', end_reason_code = ''operator_abandon'''), 'ok', 'C18 T5 / T22: validating -> abandoned');
SELECT is(pg_temp.mv(1032, 'purged'), 'ok', 'C18 T5 / T21: abandoned -> purged');
DO $path$ DECLARE s text; BEGIN FOREACH s IN ARRAY ARRAY['staging','staged','validating','validated','dry_running','dry_run_passed','approved_for_load','loading'] LOOP PERFORM pg_temp.mv(1033, s); END LOOP; END $path$;
SELECT is(pg_temp.mv(1033, 'load_failed'), 'ok', 'C18 T5 / T14: loading -> load_failed');
SELECT is(pg_temp.mv(1033, 'loading'), 'ok', 'C18 T5 / T12: load_failed -> loading (retry)');
SELECT is(pg_temp.mv(1033, 'loaded'), 'ok', 'C18 T5: loading -> loaded'); SELECT is(pg_temp.mv(1033, 'verifying'), 'ok', 'C18 T5: loaded -> verifying');
SELECT is(pg_temp.mv(1033, 'verify_failed'), 'ok', 'C18 T5 / T17: verifying -> verify_failed');
SELECT is(pg_temp.mv(1033, 'verifying'), 'ok', 'C18 T5 / T15: verify_failed -> verifying');
SELECT is(pg_temp.mv(1033, 'verified'), 'ok', 'C18 T5: verifying -> verified');
SELECT is(pg_temp.mv(1033, 'voiding'), 'ok', 'C18 T5 / T19: verified -> voiding');
SELECT is(pg_temp.mv(1033, 'voided'), 'ok', 'C18 T5 / T20: voiding -> voided');
SELECT is(pg_temp.mv(1033, 'purged', ', end_reason_code = ''operator_void'''), 'ok', 'C18 T5 / T21: voided -> purged');
DO $path2$ DECLARE s text; BEGIN FOREACH s IN ARRAY ARRAY['staging','staged','validating','validated','dry_running','dry_run_passed','approved_for_load','loading','loaded'] LOOP PERFORM pg_temp.mv(1034, s); END LOOP; END $path2$;
SELECT is(pg_temp.mv(1034, 'voiding'), 'ok', 'C18 T5 / T19: loaded -> voiding'); SELECT is(pg_temp.mv(1034, 'voided_partial'), 'ok', 'C18 T5 / T20: voiding -> voided_partial');
SELECT is(pg_temp.mv(1034, 'purged', ', end_reason_code = ''operator_void'''), 'ok', 'C18 T5 / T21: voided_partial -> purged');
SELECT matches(pg_temp.mv(1035, 'dry_running'), '^E', 'C18 T5: created -> dry_running is rejected'); SELECT matches(pg_temp.mv(1035, 'signed_off', ', signed_off_at = now()'), '^E', 'C18 T5: created -> signed_off is rejected');
SELECT is(pg_temp.mv(1035, 'abandoned', ', end_reason_code = ''operator_abandon'''), 'ok', 'C18 T5 / T22: created -> abandoned');

-- C18 T6 (§12.6): immutable columns of runs: UPDATE of tenant_id / kind / run_code -> P0001 immutable_row (AC-0B-4.1)
SELECT matches(pg_temp.m('system', 1, 'UPDATE migration_staging.runs SET tenant_id = pg_temp.id(2) WHERE id = pg_temp.id(1036)'), 'P0001.*immutable_row', 'C18 T6 / AC-0B-4.1: UPDATE of runs.tenant_id -> immutable_row');
SELECT matches(pg_temp.m('system', 1, 'UPDATE migration_staging.runs SET kind = ''delta'' WHERE id = pg_temp.id(1036)'), 'P0001.*immutable_row', 'C18 T6 / AC-0B-4.1: UPDATE of runs.kind -> immutable_row');
SELECT matches(pg_temp.m('system', 1, 'UPDATE migration_staging.runs SET run_code = ''MR-other-1'' WHERE id = pg_temp.id(1036)'), 'P0001.*immutable_row', 'C18 T6 / AC-0B-4.1: UPDATE of runs.run_code -> immutable_row');
SELECT matches(pg_temp.m('system', 1, 'UPDATE migration_staging.batches SET entity = ''results'' WHERE tenant_id = pg_temp.id(1)'), 'P0001.*immutable_row', 'C18 T6 / AC-0B-4.1: UPDATE of batches.entity -> immutable_row');
SELECT matches(pg_temp.m('system', 1, 'UPDATE migration_staging.run_files SET path = ''x_y.csv'' WHERE tenant_id = pg_temp.id(1)'), 'P0001.*immutable_row', 'C18 T6 / AC-0B-4.1: UPDATE of run_files.path -> immutable_row');
SELECT is(pg_temp.m('system', 1, 'UPDATE migration_staging.runs SET counts = ''{"patients": 1}''::jsonb, last_progress_at = now() WHERE id = pg_temp.id(1036)'), '1', 'C18 T6: a mutable (lifecycle) column of runs can be updated');

-- C18 T7 (§12.7): runs__tenant_id_active_writer__p_uq: a second run of the tenant entering loading fails (unique violation 23505); another tenant is not blocked
DO $w$ DECLARE s text; BEGIN FOREACH s IN ARRAY ARRAY['staging','staged','validating','validated','dry_running','dry_run_passed','approved_for_load','loading'] LOOP PERFORM pg_temp.mv(1037, s); PERFORM pg_temp.mv(1038, s) WHERE s <> 'loading'; END LOOP; END $w$;
SELECT is((SELECT status FROM migration_staging.runs WHERE id = pg_temp.id(1037)), 'loading', 'C18 T7: run 1037 is the writing run of tenant A');
SELECT matches(pg_temp.mv(1038, 'loading'), '23505', 'C18 T7 / §12.7: a second run of tenant A entering loading fails (one writing run per tenant, 03-APP-FLOW E2)');
SELECT is((SELECT count(*)::int FROM migration_staging.runs WHERE tenant_id = pg_temp.id(1) AND status IN ('loading','voiding')), 1, 'C18 T7: exactly one writing run in tenant A');

-- C18 T8 (§12.8): no audit.tg_row_audit trigger on stg_*, match_pairs, issues, samples; present on runs, run_files, crosswalk_entries, batches (§1.5) (AC-0B-5.1, 5.2, 5.3)
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = ('migration_staging.' || t)::regclass AND NOT tgisinternal AND tgfoid = 'app.tg_row_audit'::regproc), 0, 'C18 T8 / AC-0B-5.3: no row-audit trigger on migration_staging.' || t) FROM unnest(ARRAY['stg_patients','stg_visits','stg_results','stg_documents','stg_financial','stg_masters','match_pairs','issues','samples']) t;
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = ('migration_staging.' || t)::regclass AND NOT tgisinternal AND tgfoid = 'app.tg_row_audit'::regproc), 1, 'C18 T8 / AC-0B-5.1: row-audit trigger on migration_staging.' || t) FROM unnest(ARRAY['runs','run_files','crosswalk_entries','batches']) t;
SELECT cmp_ok((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'migration_staging' AND table_name = 'stg_patients'), '=', 0, 'C18 T8 / AC-0B-5.2: the staged patient rows left no copy in audit.audit_log (PHI not duplicated, §1.5)');
SELECT cmp_ok((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'migration_staging' AND table_name = 'runs'), '>', 0, 'C18 T8 / AC-0B-5.1: runs changes (T5 transitions) were audited');

-- C18 T9 (§12.9): P-16 guard probe: partner, portal and patient claims of tenant A read 0 rows of every staging table and cannot insert; the staff control (T1) shows the rows are there (AC-0B-3.6, 3.7)
CREATE TEMP TABLE actor(a) AS VALUES ('partner'), ('portal'), ('patient');
SELECT is(pg_temp.m(a, 1, format('SELECT 1 FROM migration_staging.%I', t), 'n'), '0', 'C18 T9 / AC-0B-3.6 / P-16: ' || a || ' claims read 0 rows of migration_staging.' || t) FROM tbl, actor;
SELECT is(left(pg_temp.m(a, 1, pg_temp.ins(t, 1, 950, 1)), 6), 'E42501', 'C18 T9 / AC-0B-3.7 / P-16: ' || a || ' claims cannot INSERT into migration_staging.' || t) FROM tbl, actor;
SELECT is(pg_temp.m(a, 1, format('UPDATE migration_staging.runs SET counts = counts WHERE tenant_id = pg_temp.id(1)'), 'w'), '0', 'C18 T9 / P-16: ' || a || ' claims UPDATE 0 runs') FROM actor;
SELECT is(pg_temp.m(a, 1, 'DELETE FROM migration_staging.stg_patients', 'w'), '0', 'C18 T9 / P-16: ' || a || ' claims DELETE 0 stg_patients rows') FROM actor;
SELECT cmp_ok(pg_temp.m('user', 1, 'SELECT 1 FROM migration_staging.runs', 'n')::int, '>=', 1, 'C18 T9: control: a staff (user) actor of tenant A reads the runs');

-- C18 T10 (§12.10): match_pairs with status = 'decided' and no lab_form_reference -> CHECK violation (D-133)
SELECT matches(pg_temp.m('system', 1, 'UPDATE migration_staging.match_pairs SET status = ''decided'', decision = ''merge'', decided_at = now(), decided_by_membership_id = pg_temp.id(98) WHERE tenant_id = pg_temp.id(1) AND id = pg_temp.id(1001)'), '23514', 'C18 T10 / D-133: a decided pair without lab_form_reference -> check_violation');
SELECT is(pg_temp.m('system', 1, 'UPDATE migration_staging.match_pairs SET status = ''decided'', decision = ''merge'', decided_at = now(), decided_by_membership_id = pg_temp.id(98), lab_form_reference = ''FORM-0001'' WHERE tenant_id = pg_temp.id(1) AND id = pg_temp.id(1001)'), '1', 'C18 T10 / D-133: with lab_form_reference the same decision is accepted');
SELECT matches(pg_temp.m('system', 1, 'UPDATE migration_staging.match_pairs SET lab_form_reference = '''' WHERE tenant_id = pg_temp.id(1)'), '23514', 'C18 T10: an empty lab_form_reference violates match_pairs__form_ref__ck');
SELECT matches(pg_temp.m('system', 1, 'UPDATE migration_staging.match_pairs SET decision = ''link'' WHERE tenant_id = pg_temp.id(1) AND id = pg_temp.id(1001)'), '23514', 'C18 T10: decision ''link'' is not allowed for a strong pair');

-- C18 T11 (§12.11): lims_migration can EXECUTE app.core_resolve_tenant_code and app.cron_tenant_ids and no other DEFINER (D-134)
SELECT is(has_function_privilege('lims_migration', 'app.core_resolve_tenant_code(text)', 'EXECUTE'), true, 'C18 T11 / D-134: EXECUTE app.core_resolve_tenant_code(text)');
SELECT is(has_function_privilege('lims_migration', 'app.cron_tenant_ids()', 'EXECUTE'), true, 'C18 T11 / A13 P-6: EXECUTE app.cron_tenant_ids()');
SELECT is((SELECT array_agg(p.proname::text ORDER BY p.proname::text) FROM pg_proc p WHERE p.prosecdef AND has_function_privilege('lims_migration', p.oid, 'EXECUTE') AND NOT has_function_privilege('lims_app', p.oid, 'EXECUTE')), ARRAY['core_resolve_tenant_code','cron_tenant_ids'], 'C18 T11: no other DEFINER is executable by lims_migration');
SELECT is(pg_temp.x('lims_migration', pg_temp.cl('system', 1), $$SELECT status FROM app.core_resolve_tenant_code('hc18_a')$$, 'v'), 'active', 'C18 T11 / D-121: lims_migration resolves --tenant <code> through the DEFINER');
SELECT is(left(pg_temp.x('lims_migration', pg_temp.cl('system', 1), 'SELECT * FROM app.cron_tenant_ids()', 'v'), 1) <> 'E', true, 'C18 T11: lims_migration may call app.cron_tenant_ids()');

SELECT * FROM finish();
ROLLBACK;
