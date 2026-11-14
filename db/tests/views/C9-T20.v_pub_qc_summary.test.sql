-- C9 T-20 view suite: quality.v_pub_qc_summary (PRD AC-15.1; 03-IC §6.7; 05-SCHEMA §6/§8; REQ-SEC-031, S-20). Synthetic data only.
-- Needs the C0 Wave-2 `quality` DDL (tables qc_runs, ... + the view). Run: bash db/tests/run-suites.sh db/tests/views/C9-T20.v_pub_qc_summary.test.sql
--   or: pg_prove -d <db> db/tests/views/C9-T20.v_pub_qc_summary.test.sql  (pgTAP in schema `extensions`; superuser). Rows are inserted as superuser with
--   session_replication_role = replica (FK + user triggers off; CHECK constraints stay on), so no plan/instrument/analyte fixtures are needed; the whole file rolls back.
-- Business date = Asia/Kathmandu (UTC+05:45): 2026-11-10T18:30Z is already 2026-11-11 (00:15) there.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

SELECT has_view('quality', 'v_pub_qc_summary', 'the published view exists');
SELECT columns_are('quality', 'v_pub_qc_summary', ARRAY['tenant_id','instrument_id','analyte_id','business_date','runs','accepted_runs','rejected_runs','warnings','last_in_control_run_at'],
  'AC-15.1 exactly the 03-IC §6.7 columns (no more, no fewer)');
SELECT col_type_is('quality', 'v_pub_qc_summary', 'tenant_id', 'uuid'); SELECT col_type_is('quality', 'v_pub_qc_summary', 'instrument_id', 'uuid'); SELECT col_type_is('quality', 'v_pub_qc_summary', 'analyte_id', 'uuid');
SELECT col_type_is('quality', 'v_pub_qc_summary', 'business_date', 'date');
SELECT col_type_is('quality', 'v_pub_qc_summary', 'runs', 'bigint'); SELECT col_type_is('quality', 'v_pub_qc_summary', 'accepted_runs', 'bigint');
SELECT col_type_is('quality', 'v_pub_qc_summary', 'rejected_runs', 'bigint'); SELECT col_type_is('quality', 'v_pub_qc_summary', 'warnings', 'bigint');
SELECT col_type_is('quality', 'v_pub_qc_summary', 'last_in_control_run_at', 'timestamp with time zone');
SELECT ok((SELECT coalesce(c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on'], false)
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'quality' AND c.relname = 'v_pub_qc_summary'), 'REQ-SEC-031 security_invoker = true (S-20: the caller''s RLS applies)');
SELECT ok(has_table_privilege('lims_app', 'quality.v_pub_qc_summary', 'SELECT'), 'lims_app may SELECT');
SELECT ok(NOT has_table_privilege('lims_app', 'quality.v_pub_qc_summary', 'INSERT') AND NOT has_table_privilege('lims_app', 'quality.v_pub_qc_summary', 'UPDATE') AND NOT has_table_privilege('lims_app', 'quality.v_pub_qc_summary', 'DELETE'), 'lims_app has no write privilege on the view');

-- ---- fixtures: tenant A (instrument I1 / analyte A1 / plan P1), tenant B (same ids shape, other tenant) ------------------------------------------------------------------------------------
SET LOCAL session_replication_role = replica;
CREATE TEMP TABLE ids AS SELECT '0190a000-0000-7000-8000-0000000000a1'::uuid AS ta, '0190a000-0000-7000-8000-0000000000b1'::uuid AS tb,
  '0190a000-0000-7000-8000-000000002001'::uuid AS i1, '0190a000-0000-7000-8000-000000002002'::uuid AS i2, '0190a000-0000-7000-8000-000000008001'::uuid AS a1,
  '0190a000-0000-7000-8000-000000009001'::uuid AS p1, '0190a000-0000-7000-8000-000000009002'::uuid AS p2, '0190a000-0000-7000-8000-0000000000d1'::uuid AS u;
CREATE FUNCTION pg_temp.run(n int, tenant uuid, plan uuid, instr uuid, at timestamptz, st text, oc text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO quality.qc_runs (id, tenant_id, plan_id, plan_version_no, instrument_id, analyte_id, controls_per_run, rule_mode, mean_rule, run_at, last_member_received_at, last_assembled_at,
                               status, outcome, rules_violated, hold_since, evaluated_at, closed_at, created_by, updated_by)
  SELECT ('0190a000-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, tenant, plan, 1, instr, (SELECT a1 FROM ids), 2, 'classic', '10x', at, at, at,
         st, oc, CASE WHEN oc = 'rejected' THEN ARRAY['1-3s'] ELSE '{}'::text[] END, CASE WHEN oc = 'rejected' THEN at END,
         CASE WHEN st <> 'collecting' THEN at END, CASE WHEN st = 'closed' THEN at END, (SELECT u FROM ids), (SELECT u FROM ids)
$$;
-- Business day 2026-11-10 (NPT) of tenant A / I1: accepted, accepted_warning, rejected (closed), incomplete, a still-collecting run (never counted)
SELECT pg_temp.run(1, (SELECT ta FROM ids), (SELECT p1 FROM ids), (SELECT i1 FROM ids), '2026-11-10T04:00:00Z', 'evaluated', 'accepted');
SELECT pg_temp.run(2, (SELECT ta FROM ids), (SELECT p1 FROM ids), (SELECT i1 FROM ids), '2026-11-10T06:00:00Z', 'evaluated', 'accepted_warning');
SELECT pg_temp.run(3, (SELECT ta FROM ids), (SELECT p1 FROM ids), (SELECT i1 FROM ids), '2026-11-10T08:00:00Z', 'closed',    'rejected');
SELECT pg_temp.run(4, (SELECT ta FROM ids), (SELECT p1 FROM ids), (SELECT i1 FROM ids), '2026-11-10T09:00:00Z', 'evaluated', 'incomplete');
SELECT pg_temp.run(5, (SELECT ta FROM ids), (SELECT p1 FROM ids), (SELECT i1 FROM ids), '2026-11-10T10:00:00Z', 'collecting', NULL);
-- 2026-11-10T18:30Z is 2026-11-11 00:15 in Asia/Kathmandu: belongs to business day 11-11, not 11-10
SELECT pg_temp.run(6, (SELECT ta FROM ids), (SELECT p1 FROM ids), (SELECT i1 FROM ids), '2026-11-10T18:30:00Z', 'evaluated', 'accepted');
SELECT pg_temp.run(7, (SELECT ta FROM ids), (SELECT p1 FROM ids), (SELECT i1 FROM ids), '2026-11-11T05:00:00Z', 'evaluated', 'rejected');
-- business day 11-12: only a rejected run; last_in_control_run_at comes from an EARLIER day
SELECT pg_temp.run(8, (SELECT ta FROM ids), (SELECT p1 FROM ids), (SELECT i1 FROM ids), '2026-11-12T05:00:00Z', 'evaluated', 'rejected');
-- another instrument of tenant A (own group), and tenant B with the same shape (must not mix into A)
SELECT pg_temp.run(9,  (SELECT ta FROM ids), (SELECT p2 FROM ids), (SELECT i2 FROM ids), '2026-11-10T05:00:00Z', 'evaluated', 'accepted');
SELECT pg_temp.run(10, (SELECT tb FROM ids), (SELECT p1 FROM ids), (SELECT i1 FROM ids), '2026-11-10T05:00:00Z', 'evaluated', 'rejected');

SELECT results_eq($$ SELECT business_date::text, runs, accepted_runs, rejected_runs, warnings, last_in_control_run_at FROM quality.v_pub_qc_summary
                      WHERE tenant_id = (SELECT ta FROM ids) AND instrument_id = (SELECT i1 FROM ids) ORDER BY business_date $$,
  $$ VALUES ('2026-11-10', 4::bigint, 2::bigint, 1::bigint, 1::bigint, '2026-11-10T06:00:00Z'::timestamptz),
            ('2026-11-11', 2::bigint, 1::bigint, 1::bigint, 0::bigint, '2026-11-10T18:30:00Z'::timestamptz),
            ('2026-11-12', 1::bigint, 0::bigint, 1::bigint, 0::bigint, '2026-11-10T18:30:00Z'::timestamptz) $$,
  'AC-15.1 per day: runs = evaluated+closed (collecting excluded, incomplete counted in runs only); accepted_runs = accepted + accepted_warning; rejected_runs; warnings = accepted_warning; last_in_control_run_at = latest in-control run before the END of the business day (11-11 sees the 00:15 run, 11-10 does not; 11-12 reuses an earlier day)');
SELECT is((SELECT count(*) FROM quality.v_pub_qc_summary WHERE tenant_id = (SELECT ta FROM ids) AND instrument_id = (SELECT i1 FROM ids)), 3::bigint, 'one row per tenant x instrument x analyte x business date (no row for days without runs)');
SELECT results_eq($$ SELECT instrument_id, business_date::text, runs, accepted_runs FROM quality.v_pub_qc_summary WHERE tenant_id = (SELECT ta FROM ids) AND instrument_id = (SELECT i2 FROM ids) $$,
  $$ SELECT (SELECT i2 FROM ids), '2026-11-10', 1::bigint, 1::bigint $$, 'a second instrument is its own group');
SELECT results_eq($$ SELECT runs, accepted_runs, rejected_runs, last_in_control_run_at FROM quality.v_pub_qc_summary WHERE tenant_id = (SELECT tb FROM ids) $$,
  $$ VALUES (1::bigint, 0::bigint, 1::bigint, NULL::timestamptz) $$, 'tenant B''s row counts only tenant B''s run and does not inherit A''s last in-control time (explicit tenant predicate in the lateral subquery)');
SELECT is((SELECT count(*) FROM quality.v_pub_qc_summary WHERE tenant_id NOT IN ((SELECT ta FROM ids), (SELECT tb FROM ids))), 0::bigint, 'no other tenant appears');

SELECT * FROM finish();
ROLLBACK;
