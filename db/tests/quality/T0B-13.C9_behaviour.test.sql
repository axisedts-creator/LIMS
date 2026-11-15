-- T0B-13.C9 behaviour suite: tenant / centre isolation, non-staff actors and fail-closed no-claims, append-only + immutable tables, tat_items purge rule, guard triggers (qc_runs, qc_observations, qc_targets, autoverify_versions),
-- CHECK constraints, cross-tenant composite FK, audit, published view quality.v_pub_qc_summary (C9 05-SCHEMA §2, §4, §5, §6, §8; AC-0B-2.4, 3.1-3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 6.1-6.3).
-- The generated per-table probes (db/tests/isolation/quality.<t>.test.sql) are the AC-0B-3.x proof for every table; this file proves what the generator cannot know.
-- Synthetic data only (seeds 010: tenant A 01a1a98a-...-a001, tenant B ...-b001; centres a201, a202, b201; memberships a500 all-centres staff, a50a staff restricted to centre a201, b500).
-- One rolled-back transaction. RLS is never disabled. FK PARENT rows of other chunks (catalog, instruments, frontdesk, lab) are not built here: the fixtures are inserted by the superuser test session inside ONE block with
-- the replica session replication role (FK + user triggers off; RLS, CHECK and NOT NULL stay on; C9-T20 precedent) that is reset to origin before the first assertion. Every assertion runs as SET LOCAL ROLE lims_app / lims_api (pg_temp.x).
-- Run from the repo root: pg_prove -d <db> db/tests/quality/T0B-13.C9_behaviour.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers: C9 check 8 fixtures + seeds, 9 tenant isolation (AC-0B-3.1/3.2/3.3/3.5), 10 centre isolation (AC-0B-3.4), 11 non-staff actors + no claims (AC-0B-3.6/3.7), 12 append-only + no DELETE (AC-0B-4.1/4.2),
-- 13 tat_items purge rule (P-18(c), AC-0B-4.3), 14 immutability triggers (qc_targets, qc_observations, qc_runs, autoverify_versions), 15 CHECK constraints + cross-tenant FK + audit (AC-0B-5.1/5.2/5.3), 16 view v_pub_qc_summary (AC-0B-6.1/6.2/6.3).
-- Order matters inside the transaction: read-only checks first, state-changing statements last.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c900-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
CREATE FUNCTION pg_temp.m(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-00000000' || s)::uuid $$;     -- membership ids: a500, a50a, b500
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);

-- fixture insert: only the keys given are written (defaults apply to the rest); created_by / updated_by default to the system actor
CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r jsonb := p_row; a text; cols text;
BEGIN
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.sys()); END IF;
  END LOOP;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, r::text);
END $f$;
-- run p_sql as p_role with p_claims; mode n = count of a query, w = ROW_COUNT of a statement, s = the single scalar; errors -> 'E' || SQLSTATE || '|' || SQLERRM
CREATE FUNCTION pg_temp.x(p_role text, p_claims jsonb, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 's' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSE
      IF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; END IF;
      r := 'n=' || n;
    END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || '|' || SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'system', p_mem uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', pg_temp.sys()) || CASE WHEN p_mem IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('membership_id', p_mem) END $$;
CREATE FUNCTION pg_temp.sa(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;                  -- tenant A system actor
CREATE FUNCTION pg_temp.sb(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.ua(p_mem uuid, p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'user', p_mem), p_sql, p_mode) $$;   -- tenant A staff user
CREATE TEMP TABLE tt(q) AS VALUES
  ('quality.settings'),('quality.cs_corrective_actions'),('quality.cs_exclusion_reasons'),('quality.control_materials'),('quality.control_levels'),('quality.control_lots'),('quality.control_id_maps'),('quality.qc_plans'),
  ('quality.qc_plan_versions'),('quality.qc_targets'),('quality.qc_runs'),('quality.qc_observations'),('quality.qc_corrective_actions'),('quality.qc_run_reviews'),('quality.qc_activity'),('quality.sync_state'),
  ('quality.autoverify_rule_sets'),('quality.autoverify_versions'),('quality.autoverify_decisions'),('quality.verification_log'),('quality.tat_items'),('quality.tat_alert_events'),('quality.tat_alert_acks');

-- ===================================================================================================================================== fixtures (superuser, replica block)
-- C9 check 8: plans, targets, runs, observations, auto-verify, TAT rows of tenant A (centres a201 / a202) and tenant B (b201)
SET LOCAL session_replication_role = replica;      -- FIXTURE-ONLY: FK parents of other chunks are not built; RLS, CHECK, NOT NULL stay on; reset to origin below
SELECT pg_temp.ins('quality.qc_plans', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'instrument_id', pg_temp.uid(r.n + 1000), 'test_id', pg_temp.uid(2000), 'analyte_id', pg_temp.uid(r.n + 3000), 'status', 'active'))
  FROM (VALUES (1, pg_temp.ta()), (2, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('quality.qc_plan_versions', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'plan_id', pg_temp.uid(r.p), 'version_no', 1, 'controls_per_run', 2, 'composition', jsonb_build_array(jsonb_build_object('level_id', pg_temp.uid(4000), 'count', 2)),
    'mean_rule', '10x', 'effective_from', now()))
  FROM (VALUES (11, pg_temp.ta(), 1), (12, pg_temp.tb(), 2)) r(n, t, p);
SELECT pg_temp.ins('quality.qc_targets', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'plan_id', pg_temp.uid(r.p), 'lot_id', pg_temp.uid(4100), 'level_id', pg_temp.uid(4000), 'mean', 5, 'sd', 0.2, 'unit_code', 'mmol/L', 'source', 'manufacturer', 'status', 'active', 'effective_from', now()))
  FROM (VALUES (21, pg_temp.ta(), 1), (22, pg_temp.tb(), 2)) r(n, t, p);
SELECT pg_temp.ins('quality.qc_runs', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'plan_id', pg_temp.uid(r.p), 'plan_version_no', 1, 'instrument_id', pg_temp.uid(r.p + 1000), 'analyte_id', pg_temp.uid(r.p + 3000), 'controls_per_run', 2,
    'rule_mode', 'classic', 'mean_rule', '10x', 'run_at', now() - interval '1 hour', 'last_member_received_at', now(), 'last_assembled_at', now(), 'status', r.st) || r.x)
  FROM (VALUES (31, pg_temp.ta(), 1, 'collecting', '{}'::jsonb),
               (32, pg_temp.ta(), 1, 'evaluated', jsonb_build_object('outcome', 'rejected', 'is_complete', true, 'rules_violated', jsonb_build_array('1-3s'), 'hold_since', now(), 'evaluated_at', now())),
               (33, pg_temp.tb(), 2, 'collecting', '{}'::jsonb)) r(n, t, p, st, x);
SELECT pg_temp.ins('quality.qc_observations', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'source_qc_result_id', pg_temp.uid(r.n + 5000), 'source', 'instrument', 'instrument_id', pg_temp.uid(r.p + 1000), 'analyte_id', pg_temp.uid(r.p + 3000),
    'control_id_raw', 'QC-L1', 'value', 5.1, 'received_at', now(), 'observed_at', now(), 'observed_at_basis', 'instrument', 'status', 'assigned', 'plan_id', pg_temp.uid(r.p), 'level_id', pg_temp.uid(4000), 'lot_id', pg_temp.uid(4100),
    'target_id', pg_temp.uid(r.p + 20), 'mean', 5, 'sd', 0.2, 'z', 0.5, 'qc_run_id', pg_temp.uid(r.run), 'classified_at', now()))
  FROM (VALUES (41, pg_temp.ta(), 1, 31), (42, pg_temp.ta(), 1, 32), (43, pg_temp.tb(), 2, 33)) r(n, t, p, run);
SELECT pg_temp.ins('quality.autoverify_rule_sets', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t)) FROM (VALUES (51, pg_temp.ta()), (52, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('quality.autoverify_versions', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'rule_set_id', pg_temp.uid(r.rs), 'version_no', r.v, 'status', r.st, 'definition', '{"schema_version":"1"}'::jsonb, 'rule_count', 0) || r.x)
  FROM (VALUES (61, pg_temp.ta(), 51, 1, 'draft', '{}'::jsonb), (62, pg_temp.ta(), 51, 2, 'active', jsonb_build_object('activated_at', now(), 'activated_by', pg_temp.uid(9002))), (63, pg_temp.tb(), 52, 1, 'draft', '{}'::jsonb)) r(n, t, rs, v, st, x);
SELECT pg_temp.ins('quality.autoverify_decisions', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'decided_at', now(), 'mode', 'live', 'result_id', pg_temp.uid(r.n + 7000), 'analyte_id', pg_temp.uid(3001), 'decision', 'allow', 'qc_status', 'in_control', 'inputs', '{}'::jsonb))
  FROM (VALUES (71, pg_temp.ta()), (72, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('quality.verification_log', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'result_id', pg_temp.uid(r.n + 7000), 'result_version_no', 1, 'order_id', pg_temp.uid(8000), 'order_item_id', pg_temp.uid(8001), 'test_id', pg_temp.uid(2000),
    'analyte_id', pg_temp.uid(3001), 'mode', 'manual', 'verified_at', now(), 'event_id', pg_temp.uid(r.n + 9000))) FROM (VALUES (81, pg_temp.ta()), (82, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('quality.tat_items', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'order_id', pg_temp.uid(8000 + r.n), 'order_item_id', pg_temp.uid(8100 + r.n), 'test_id', pg_temp.uid(2000), 'specimen_id', pg_temp.uid(8200 + r.n),
    'priority', 'routine', 'segment', 'total', 'target_seconds', 3600, 'start_basis', 'registered_at', 'state', 'running', 'started_at', now() - interval '2 hours', 'last_seen_sweep_at', now(), 'alert_level', 'breached', 'expires_at', r.ex))
  FROM (VALUES (91, pg_temp.ta(), pg_temp.id('00000000a201'), now() - interval '1 day'), (92, pg_temp.ta(), pg_temp.id('00000000a202'), now() + interval '300 days'), (93, pg_temp.tb(), pg_temp.id('00000000b201'), now() - interval '1 day'),
               (94, pg_temp.ta(), pg_temp.id('00000000a201'), now() - interval '1 day')) r(n, t, c, ex);
SELECT pg_temp.ins('quality.tat_alert_events', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'tat_item_id', pg_temp.uid(r.i), 'level', 'breached', 'raised_at', now(), 'elapsed_seconds', 4000, 'restart_no', 0))
  FROM (VALUES (101, pg_temp.ta(), pg_temp.id('00000000a201'), 91), (102, pg_temp.ta(), pg_temp.id('00000000a202'), 92), (103, pg_temp.tb(), pg_temp.id('00000000b201'), 93)) r(n, t, c, i);
SELECT pg_temp.ins('quality.tat_alert_acks', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'tat_item_id', pg_temp.uid(r.i), 'level', 'breached', 'acknowledged_by_membership_id', r.m))
  FROM (VALUES (111, pg_temp.ta(), pg_temp.id('00000000a201'), 91, pg_temp.m('a500')), (112, pg_temp.ta(), pg_temp.id('00000000a202'), 92, pg_temp.m('a500')), (113, pg_temp.tb(), pg_temp.id('00000000b201'), 93, pg_temp.m('b500'))) r(n, t, c, i, m);
SELECT pg_temp.ins('quality.settings', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'activated_at', now() - interval '120 days')) FROM (VALUES (121, pg_temp.ta()), (122, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('quality.qc_activity', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'plan_id', pg_temp.uid(r.p))) FROM (VALUES (131, pg_temp.ta(), 1), (132, pg_temp.tb(), 2)) r(n, t, p);
SELECT pg_temp.ins('quality.sync_state', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'qc_cursor_at', now())) FROM (VALUES (141, pg_temp.ta()), (142, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('quality.cs_corrective_actions', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'code', 'tenant_code', 'display', 'Tenant override')) FROM (VALUES (151, pg_temp.ta()), (152, pg_temp.tb())) r(n, t);
SELECT pg_temp.ins('quality.qc_corrective_actions', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'qc_run_id', pg_temp.uid(r.run), 'action_code', 'recalibration', 'description', 'Synthetic action', 'performed_at', now(), 'performed_by_membership_id', r.m))
  FROM (VALUES (161, pg_temp.tb(), 33, pg_temp.m('b500'))) r(n, t, run, m);
SET LOCAL session_replication_role = origin;      -- back to normal: triggers and FKs are live for every assertion below

SELECT is((SELECT count(*)::int FROM quality.g_cs_corrective_actions), 7, 'C9 check 8: 7 global corrective actions seeded (§2)');
SELECT is((SELECT count(*)::int FROM quality.g_cs_exclusion_reasons), 6, 'C9 check 8: 6 global exclusion reasons seeded (§2)');
SELECT is((SELECT count(*)::int FROM quality.g_cs_corrective_actions WHERE code IN ('recalibration','new_control_vial','new_reagent_lot','instrument_maintenance','control_reconstituted','repeat_control','other')), 7, 'C9 check 8: the 7 spec codes');
SELECT is((SELECT count(*)::int FROM quality.g_cs_exclusion_reasons WHERE code IN ('wrong_material','wrong_level_mapping','handling_error','instrument_error','duplicate_entry','other')), 6, 'C9 check 8: the 6 spec codes');
SELECT is((SELECT count(*)::int FROM quality.qc_plans), 2, 'C9 check 8: fixtures present (superuser sees all tenants)');
SELECT is((SELECT count(*)::int FROM quality.tat_items), 4, 'C9 check 8: 4 tat_items fixtures');

-- ===================================================================================================================================== read-only checks first
-- C9 check 9: tenant isolation (AC-0B-3.1 / 3.2 / 3.3 / 3.5)
SELECT is(pg_temp.sa('SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 'n'), 'n=0', 'C9 check 9 / AC-0B-3.1: tenant A system actor sees 0 tenant B rows of ' || q) FROM tt;
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 'n'), 'n=0', 'C9 check 9 / AC-0B-3.1: tenant A staff user sees 0 tenant B rows of ' || q) FROM tt;
SELECT is(pg_temp.sb('SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'C9 check 9 / AC-0B-3.1: tenant B system actor sees 0 tenant A rows of ' || q) FROM tt;
SELECT is(pg_temp.sa('SELECT 1 FROM quality.qc_plans', 'n'), 'n=1', 'C9 check 9: tenant A sees exactly its plan');
SELECT is(pg_temp.sb('SELECT 1 FROM quality.qc_runs', 'n'), 'n=1', 'C9 check 9: tenant B sees exactly its run');
SELECT matches(pg_temp.sa('INSERT INTO quality.qc_plans (id, tenant_id, instrument_id, test_id, analyte_id, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(901)) || ', ' || quote_literal(pg_temp.tb()) || ', '
  || quote_literal(pg_temp.uid(1)) || ', ' || quote_literal(pg_temp.uid(1)) || ', ' || quote_literal(pg_temp.uid(1)) || ', ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E42501\|', 'C9 check 9 / AC-0B-3.2: tenant A claims cannot INSERT a tenant B row');
SELECT is(pg_temp.sa('UPDATE quality.qc_plans SET status = ''inactive'' WHERE tenant_id = ' || quote_literal(pg_temp.tb())), 'n=0', 'C9 check 9 / AC-0B-3.3: tenant A updates 0 tenant B plans');
SELECT is(pg_temp.sa('UPDATE quality.tat_items SET alert_level = ''none'' WHERE tenant_id = ' || quote_literal(pg_temp.tb())), 'n=0', 'C9 check 9 / AC-0B-3.3: tenant A updates 0 tenant B tat_items');
SELECT is(pg_temp.sa('DELETE FROM quality.tat_items WHERE tenant_id = ' || quote_literal(pg_temp.tb())), 'n=0', 'C9 check 9 / AC-0B-3.3: tenant A system actor deletes 0 tenant B tat_items (even expired)');
SELECT is(pg_temp.sa('SELECT 1 FROM quality.g_cs_corrective_actions', 'n'), 'n=7', 'C9 check 9 / AC-0B-3.5: the global coded sets are readable by every tenant');
SELECT is(pg_temp.sb('SELECT 1 FROM quality.g_cs_exclusion_reasons', 'n'), 'n=6', 'C9 check 9: global exclusion reasons readable by tenant B');

-- C9 check 10: centre isolation (AC-0B-3.4) on tat_items / tat_alert_events / tat_alert_acks
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM ' || q || ' WHERE centre_id = ' || quote_literal(pg_temp.id('00000000a202')), 'n'), 'n=0', 'C9 check 10 / AC-0B-3.4: centre-A1 staff sees 0 centre A2 rows of ' || q) FROM (VALUES ('quality.tat_items'),('quality.tat_alert_events'),('quality.tat_alert_acks')) v(q);
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM ' || q || ' WHERE centre_id = ' || quote_literal(pg_temp.id('00000000a201')), 'n') ~ '^n=[1-9]', true, 'C9 check 10 / AC-0B-3.4: centre-A1 staff sees its own centre rows of ' || q) FROM (VALUES ('quality.tat_items'),('quality.tat_alert_events'),('quality.tat_alert_acks')) v(q);
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM quality.tat_items', 'n'), 'n=3', 'C9 check 10: all-centres staff sees all three tenant A tat_items');
SELECT is(pg_temp.sa('SELECT 1 FROM quality.tat_items', 'n'), 'n=3', 'C9 check 10: the system actor (has_all_centres) sees all tenant A tat_items');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM quality.qc_runs', 'n'), 'n=2', 'C9 check 10 / §1: QC tables are tenant-scoped (no centre predicate): restricted staff still sees the plan''s runs');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'UPDATE quality.tat_items SET alert_level = ''warning'' WHERE centre_id = ' || quote_literal(pg_temp.id('00000000a202'))), 'n=0', 'C9 check 10 / AC-0B-3.4: centre-A1 staff updates 0 centre A2 tat_items');
SELECT matches(pg_temp.ua(pg_temp.m('a50a'), 'INSERT INTO quality.tat_alert_acks (id, tenant_id, centre_id, tat_item_id, level, acknowledged_by_membership_id, created_by) VALUES (' || quote_literal(pg_temp.uid(902)) || ', ' || quote_literal(pg_temp.ta()) || ', '
  || quote_literal(pg_temp.id('00000000a202')) || ', ' || quote_literal(pg_temp.uid(92)) || ', ''breached'', ' || quote_literal(pg_temp.m('a50a')) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E42501\|', 'C9 check 10 / AC-0B-3.4: centre-A1 staff cannot ack an alert of centre A2');

-- C9 check 11: non-staff actors (AC-0B-3.6) and fail-closed without claims (AC-0B-3.7)
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'C9 check 11 / AC-0B-3.6: ' || k.t || ' actor sees 0 rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('partner'),('portal'),('patient')) k(t);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal', pg_temp.m('a500')), 'UPDATE quality.qc_plans SET status = ''inactive'''), 'n=0', 'C9 check 11 / AC-0B-3.6: a portal actor updates 0 plans');
SELECT matches(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner', pg_temp.m('a500')), 'INSERT INTO quality.sync_state (id, tenant_id, qc_cursor_at) VALUES (' || quote_literal(pg_temp.uid(903)) || ', ' || quote_literal(pg_temp.ta()) || ', now())'), '^E42501\|', 'C9 check 11 / AC-0B-3.6: a partner actor cannot INSERT');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device'), 'SELECT 1 FROM quality.qc_plans', 'n'), 'n=0', 'C9 check 11: a device actor is not staff and sees 0 plans');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C9 check 11 / AC-0B-3.7: no claims -> lims_api sees 0 rows of ' || q) FROM tt;
SELECT is(pg_temp.x('lims_api', '{}'::jsonb, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C9 check 11 / AC-0B-3.7: empty claims -> 0 rows of ' || q) FROM tt;
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM quality.v_pub_qc_summary', 'n'), 'n=0', 'C9 check 11 / AC-0B-3.7: no claims -> the invoker view returns 0 rows');

-- C9 check 12: append-only tables and immutable plan versions (AC-0B-4.1 / 4.2): INSERT + SELECT only
SELECT matches(pg_temp.sa('UPDATE ' || q || ' SET created_by = created_by'), '^E42501\|', 'C9 check 12 / AC-0B-4.1: even the system actor has no UPDATE grant on ' || q)
  FROM (VALUES ('quality.qc_plan_versions'),('quality.qc_corrective_actions'),('quality.qc_run_reviews'),('quality.autoverify_decisions'),('quality.verification_log'),('quality.tat_alert_events'),('quality.tat_alert_acks')) v(q);
SELECT matches(pg_temp.sa('DELETE FROM ' || q), '^E42501\|', 'C9 check 12 / AC-0B-4.2: no DELETE grant on ' || q)
  FROM (VALUES ('quality.settings'),('quality.qc_plans'),('quality.qc_plan_versions'),('quality.qc_targets'),('quality.qc_runs'),('quality.qc_observations'),('quality.qc_corrective_actions'),('quality.qc_run_reviews'),('quality.qc_activity'),('quality.sync_state'),
    ('quality.autoverify_versions'),('quality.autoverify_decisions'),('quality.verification_log'),('quality.tat_alert_events'),('quality.tat_alert_acks'),('quality.control_materials'),('quality.cs_corrective_actions')) v(q);
SELECT matches(pg_temp.sa('INSERT INTO quality.g_cs_corrective_actions (id, code, display) VALUES (' || quote_literal(pg_temp.uid(904)) || ', ''x_test'', ''X'')'), '^E42501\|', 'C9 check 12: global coded sets are not writable by lims_app');
SELECT matches(pg_temp.sa('UPDATE quality.g_cs_exclusion_reasons SET display = ''X'''), '^E42501\|', 'C9 check 12: global exclusion reasons are not updatable by lims_app');
SELECT is(pg_temp.sa('INSERT INTO quality.qc_run_reviews (id, tenant_id, qc_run_id, kind, comment, reviewed_by_membership_id, created_by) VALUES (' || quote_literal(pg_temp.uid(905)) || ', ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.uid(32))
  || ', ''acknowledge'', ''Synthetic acknowledgement'', ' || quote_literal(pg_temp.m('a500')) || ', ' || quote_literal(pg_temp.sys()) || ')'), 'n=1', 'C9 check 12: an append-only table accepts INSERT');
SELECT matches(pg_temp.sa('INSERT INTO quality.qc_run_reviews (id, tenant_id, qc_run_id, kind, reviewed_by_membership_id, created_by) VALUES (' || quote_literal(pg_temp.uid(906)) || ', ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.uid(32))
  || ', ''acknowledge'', ' || quote_literal(pg_temp.m('a500')) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E23514\|', 'C9 check 12 / §8: an acknowledgement needs a comment (qc_run_reviews__comment__ck)');

-- C9 check 13: tat_items purge rule (P-18(c), AC-0B-4.3): DELETE only by the system actor on expired rows of its tenant
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'DELETE FROM quality.tat_items WHERE id = ' || quote_literal(pg_temp.uid(94))), 'n=0', 'C9 check 13 / AC-0B-4.3: a staff user (not system actor) deletes 0 tat_items, even an expired one');
SELECT is(pg_temp.sa('DELETE FROM quality.tat_items WHERE id = ' || quote_literal(pg_temp.uid(92))), 'n=0', 'C9 check 13 / P-18(c): the system actor does not delete a row that has not expired');
SELECT matches(pg_temp.sa('DELETE FROM quality.tat_items WHERE id = ' || quote_literal(pg_temp.uid(91))), '^E23503\|', 'C9 check 13: an expired row referenced by tat_alert_events / tat_alert_acks is kept by the FK (the task predicate skips such rows, §7)');
SELECT is(pg_temp.sa('DELETE FROM quality.tat_items WHERE id = ' || quote_literal(pg_temp.uid(94))), 'n=1', 'C9 check 13 / P-18(c): the system actor deletes an expired, unreferenced tat_item');

-- ===================================================================================================================================== state-changing checks
-- C9 check 14: immutability triggers (§4); SQLSTATE P0001 + immutable_row
SELECT matches(pg_temp.sa('UPDATE quality.qc_targets SET mean = 6 WHERE id = ' || quote_literal(pg_temp.uid(21))), '^EP0001\|', 'C9 check 14: qc_targets.mean is immutable (enforce_mutable_columns)');
SELECT matches(pg_temp.sa('UPDATE quality.qc_targets SET sd = 0.5 WHERE id = ' || quote_literal(pg_temp.uid(21))), '^EP0001\|', 'C9 check 14: qc_targets.sd is immutable');
SELECT is(pg_temp.sa('UPDATE quality.qc_targets SET status = ''superseded'', effective_to = now() + interval ''1 day'', updated_at = now() WHERE id = ' || quote_literal(pg_temp.uid(21))), 'n=1', 'C9 check 14: qc_targets lifecycle columns stay updatable');
SELECT matches(pg_temp.sa('UPDATE quality.qc_observations SET value = 9 WHERE id = ' || quote_literal(pg_temp.uid(41))), '^EP0001\|', 'C9 check 14: qc_observations source column value is frozen');
SELECT is(pg_temp.sa('UPDATE quality.qc_observations SET excluded_comment = ''c'', excluded_reason_code = ''handling_error'', excluded_by = ' || quote_literal(pg_temp.sys()) || ', excluded_at = now(), status = ''excluded'' WHERE id = ' || quote_literal(pg_temp.uid(41))), 'n=1', 'C9 check 14: an observation of a collecting run may be excluded');
SELECT matches(pg_temp.sa('UPDATE quality.qc_observations SET excluded_comment = ''c'', excluded_reason_code = ''handling_error'', excluded_by = ' || quote_literal(pg_temp.sys()) || ', excluded_at = now(), status = ''excluded'' WHERE id = ' || quote_literal(pg_temp.uid(42))), '^EP0001\|', 'C9 check 14: an observation of an evaluated run cannot be excluded (enforce_observation_exclusion)');
SELECT matches(pg_temp.sa('UPDATE quality.qc_runs SET outcome = ''accepted'' WHERE id = ' || quote_literal(pg_temp.uid(32))), '^EP0001\|', 'C9 check 14: qc_runs.outcome is frozen once set (enforce_run_frozen)');
SELECT matches(pg_temp.sa('UPDATE quality.qc_runs SET rules_violated = ''{}'' WHERE id = ' || quote_literal(pg_temp.uid(32))), '^EP0001\|', 'C9 check 14: qc_runs.rules_violated is frozen once the outcome is set');
SELECT matches(pg_temp.sa('UPDATE quality.qc_runs SET status = ''closed'', closed_at = now(), closed_by = ' || quote_literal(pg_temp.sys()) || ' WHERE id = ' || quote_literal(pg_temp.uid(32))), '^EP0001\|', 'C9 check 14: evaluated -> closed needs >= 1 corrective action (backstop of the #32 service guard)');
SELECT is(pg_temp.sa('INSERT INTO quality.qc_corrective_actions (id, tenant_id, qc_run_id, action_code, description, performed_at, performed_by_membership_id, created_by) VALUES (' || quote_literal(pg_temp.uid(907)) || ', ' || quote_literal(pg_temp.ta()) || ', '
  || quote_literal(pg_temp.uid(32)) || ', ''recalibration'', ''Synthetic action'', now(), ' || quote_literal(pg_temp.m('a500')) || ', ' || quote_literal(pg_temp.sys()) || ')'), 'n=1', 'C9 check 14: a corrective action is appended for the rejected run');
SELECT is(pg_temp.sa('UPDATE quality.qc_runs SET status = ''closed'', closed_at = now(), closed_by = ' || quote_literal(pg_temp.sys()) || ' WHERE id = ' || quote_literal(pg_temp.uid(32))), 'n=1', 'C9 check 14: with a corrective action the rejected run closes');
SELECT matches(pg_temp.sa('UPDATE quality.qc_runs SET status = ''evaluated'' WHERE id = ' || quote_literal(pg_temp.uid(32))), '^EP0001\|', 'C9 check 14: a closed run never changes status');
SELECT matches(pg_temp.sa('UPDATE quality.autoverify_versions SET definition = ''{"schema_version":"1","x":1}'' WHERE id = ' || quote_literal(pg_temp.uid(62))), '^EP0001\|', 'C9 check 14: the definition of a non-draft auto-verify version is frozen (enforce_version_frozen)');
SELECT is(pg_temp.sa('UPDATE quality.autoverify_versions SET definition = ''{"schema_version":"1","x":1}'', rule_count = 1 WHERE id = ' || quote_literal(pg_temp.uid(61))), 'n=1', 'C9 check 14: a draft version stays editable');
SELECT is(pg_temp.sa('UPDATE quality.autoverify_versions SET status = ''retired'', retired_at = now(), retired_by = ' || quote_literal(pg_temp.uid(9003)) || ' WHERE id = ' || quote_literal(pg_temp.uid(62))), 'n=1', 'C9 check 14: active -> retired is allowed');
SELECT matches(pg_temp.sa('UPDATE quality.autoverify_versions SET status = ''active'' WHERE id = ' || quote_literal(pg_temp.uid(62))), '^EP0001\|', 'C9 check 14: retired is terminal (no status change out of stopped / retired / discarded)');

-- C9 check 15: CHECK constraints, cross-tenant composite FK (AC-0B-3.6 FK probe), audit (AC-0B-5.1 / 5.2 / 5.3)
SELECT matches(pg_temp.sa('UPDATE quality.qc_plans SET status = ''paused'' WHERE id = ' || quote_literal(pg_temp.uid(1))), '^E23514\|', 'C9 check 15: qc_plans.status closed list');
SELECT matches(pg_temp.sa('INSERT INTO quality.qc_plan_versions (id, tenant_id, plan_id, version_no, controls_per_run, composition, mean_rule, effective_from, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(908)) || ', ' || quote_literal(pg_temp.ta()) || ', '
  || quote_literal(pg_temp.uid(1)) || ', 2, 3, ''[{"level_id":"x","count":3}]'', ''10x'', now(), ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E23514\|', 'C9 check 15: N = 3 admits mean rules 6x / 9x only (qc_plan_versions__mean_rule__ck)');
SELECT matches(pg_temp.sa('INSERT INTO quality.qc_plan_versions (id, tenant_id, plan_id, version_no, controls_per_run, composition, mean_rule, effective_from, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(909)) || ', ' || quote_literal(pg_temp.ta()) || ', '
  || quote_literal(pg_temp.uid(1)) || ', 3, 5, ''[{"level_id":"x","count":5}]'', ''10x'', now(), ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E23514\|', 'C9 check 15: N in (2,3,4) (qc_plan_versions__n__ck)');
SELECT matches(pg_temp.sa('INSERT INTO quality.qc_plan_versions (id, tenant_id, plan_id, version_no, controls_per_run, composition, mean_rule, effective_from, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(910)) || ', ' || quote_literal(pg_temp.ta()) || ', '
  || quote_literal(pg_temp.uid(2)) || ', 1, 2, ''[{"level_id":"x","count":2}]'', ''10x'', now(), ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E23503\|', 'C9 check 15 / AC-0B-3.6: a tenant A plan version cannot reference a tenant B plan (composite FK (tenant_id, plan_id))');
SELECT matches(pg_temp.sa('INSERT INTO quality.autoverify_decisions (id, tenant_id, decided_at, mode, result_id, analyte_id, decision, reasons, qc_status, inputs, created_by) VALUES (' || quote_literal(pg_temp.uid(911)) || ', ' || quote_literal(pg_temp.ta())
  || ', now(), ''live'', ' || quote_literal(pg_temp.uid(1)) || ', ' || quote_literal(pg_temp.uid(1)) || ', ''allow'', ARRAY[''critical''], ''in_control'', ''{}'', ' || quote_literal(pg_temp.sys()) || ')'), '^E23514\|', 'C9 check 15: an allow decision carries no reasons (03-IC §4.11 invariant)');
SELECT matches(pg_temp.sa('INSERT INTO quality.tat_items (id, tenant_id, centre_id, order_id, order_item_id, test_id, specimen_id, priority, segment, target_seconds, start_basis, state, last_seen_sweep_at, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(912)) || ', '
  || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(1)) || ', ' || quote_literal(pg_temp.uid(1)) || ', ' || quote_literal(pg_temp.uid(1)) || ', ' || quote_literal(pg_temp.uid(1))
  || ', ''routine'', ''within_lab'', 60, ''registered_at'', ''not_started'', now(), ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E23514\|', 'C9 check 15: within_lab rows start at specimen_received_at only (tat_items__start_basis__ck)');
SELECT matches(pg_temp.sa('UPDATE quality.tat_items SET state = ''stopped'' WHERE id = ' || quote_literal(pg_temp.uid(92))), '^E23514\|', 'C9 check 15: a stopped tat_item needs stopped_at and a stop_source (tat_items__stopped__ck)');
SELECT matches(pg_temp.sa('UPDATE quality.settings SET tat_warn_pct = 10 WHERE tenant_id = ' || quote_literal(pg_temp.ta())), '^E23514\|', 'C9 check 15: settings ranges (tat_warn_pct 50..99)');
SELECT matches(pg_temp.sa('INSERT INTO quality.settings (id, tenant_id, activated_at, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(913)) || ', ' || quote_literal(pg_temp.ta()) || ', now(), ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E23505\|', 'C9 check 15: one settings row per tenant (settings__tenant__uq)');
SELECT matches(pg_temp.sa('INSERT INTO quality.qc_runs (id, tenant_id, plan_id, plan_version_no, instrument_id, analyte_id, controls_per_run, rule_mode, mean_rule, run_at, last_member_received_at, last_assembled_at, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(914))
  || ', ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.uid(1)) || ', 1, ' || quote_literal(pg_temp.uid(1001)) || ', ' || quote_literal(pg_temp.uid(3001)) || ', 2, ''classic'', ''10x'', now(), now(), now(), ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'),
  '^E23505\|', 'C9 check 15: at most one collecting run per plan (qc_runs__tenant_plan_collecting__p_uq)');
-- audit (AC-0B-5.x): M / C tables are audited, A / E tables are not
SELECT is(pg_temp.sa('UPDATE quality.qc_plans SET status = ''inactive'' WHERE id = ' || quote_literal(pg_temp.uid(1))), 'n=1', 'C9 check 15 / AC-0B-5.1: an audited class M update succeeds');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'quality' AND table_name = 'qc_plans' AND row_id = pg_temp.uid(1) AND tenant_id = pg_temp.ta()), 1, 'C9 check 15 / AC-0B-5.1: the update wrote one audit_log row');
SELECT is((SELECT changed_columns @> ARRAY['status'] FROM audit.audit_log WHERE schema_name = 'quality' AND table_name = 'qc_plans' AND row_id = pg_temp.uid(1)), true, 'C9 check 15 / AC-0B-5.2: only the changed columns are recorded');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'quality' AND table_name IN ('qc_corrective_actions', 'qc_run_reviews', 'tat_items', 'qc_activity', 'autoverify_decisions')), 0, 'C9 check 15 / AC-0B-5.3: class A / E tables are not audited (the earlier writes left no audit row)');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'quality' AND table_name = 'qc_runs' AND tenant_id = pg_temp.ta()) >= 1, true, 'C9 check 15 / AC-0B-5.1: qc_runs (class C) updates are audited');

-- C9 check 16: published view quality.v_pub_qc_summary (§6; AC-0B-6.1 / 6.2 / 6.3). Business date = Asia/Kathmandu (UTC+05:45)
SET LOCAL session_replication_role = replica;      -- FIXTURE-ONLY for the FK parents of the view rows (plan version, instrument, analyte); reset to origin right after
SELECT pg_temp.ins('quality.qc_runs', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'plan_id', pg_temp.uid(r.p), 'plan_version_no', 1, 'instrument_id', pg_temp.uid(r.p + 1000), 'analyte_id', pg_temp.uid(r.p + 3000), 'controls_per_run', 2, 'rule_mode', 'classic',
    'mean_rule', '10x', 'run_at', r.at, 'last_member_received_at', r.at, 'last_assembled_at', r.at, 'status', 'evaluated', 'outcome', r.oc, 'is_complete', true, 'evaluated_at', r.at, 'rules_violated', CASE WHEN r.oc = 'rejected' THEN jsonb_build_array('1-3s') ELSE '[]'::jsonb END,
    'hold_since', CASE WHEN r.oc = 'rejected' THEN to_jsonb(r.at) END))
  FROM (VALUES (201, pg_temp.ta(), 1, '2026-11-10T04:00:00Z'::timestamptz, 'accepted'), (202, pg_temp.ta(), 1, '2026-11-10T06:00:00Z'::timestamptz, 'accepted_warning'), (203, pg_temp.ta(), 1, '2026-11-10T08:00:00Z'::timestamptz, 'rejected'),
               (204, pg_temp.ta(), 1, '2026-11-10T09:00:00Z'::timestamptz, 'incomplete'), (205, pg_temp.ta(), 1, '2026-11-10T18:30:00Z'::timestamptz, 'accepted'), (206, pg_temp.ta(), 1, '2026-11-12T05:00:00Z'::timestamptz, 'rejected'),
               (207, pg_temp.tb(), 2, '2026-11-10T05:00:00Z'::timestamptz, 'rejected')) r(n, t, p, at, oc);
SET LOCAL session_replication_role = origin;
SELECT is(pg_temp.sa('SELECT runs || '','' || accepted_runs || '','' || rejected_runs || '','' || warnings FROM quality.v_pub_qc_summary WHERE business_date = DATE ''2026-11-10''', 's'), '4,2,1,1', 'C9 check 16 / §6: business day 2026-11-10 (NPT): runs 4 (incomplete counts in runs only), accepted_runs 2, rejected 1, warnings 1');
SELECT is(pg_temp.sa('SELECT count(*)::text FROM quality.v_pub_qc_summary WHERE business_date = DATE ''2026-11-11''', 's'), '1', 'C9 check 16 / §6: 2026-11-10T18:30Z is 2026-11-11 00:15 in Asia/Kathmandu: it opens business day 11-11');
SELECT is(pg_temp.sa('SELECT to_char(last_in_control_run_at AT TIME ZONE ''UTC'', ''YYYY-MM-DD HH24:MI'') FROM quality.v_pub_qc_summary WHERE business_date = DATE ''2026-11-12''', 's'), '2026-11-10 18:30', 'C9 check 16 / §6: last_in_control_run_at of a day with only a rejected run comes from an earlier day');
SELECT is(pg_temp.sa('SELECT count(*)::text FROM quality.v_pub_qc_summary WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 's'), '0', 'C9 check 16 / AC-0B-6.2: the invoker view applies the caller''s RLS: tenant A sees no tenant B summary row');
SELECT is(pg_temp.sb('SELECT count(*)::text FROM quality.v_pub_qc_summary', 's'), '1', 'C9 check 16: tenant B sees only its own summary row');
SELECT is(pg_temp.sa('SELECT sum(runs)::text FROM quality.v_pub_qc_summary', 's'), '7', 'C9 check 16: 6 evaluated + 1 closed run counted; the collecting run never appears (status evaluated / closed only)');
SELECT matches(pg_temp.sa('INSERT INTO quality.v_pub_qc_summary (tenant_id) VALUES (' || quote_literal(pg_temp.ta()) || ')'), '^E', 'C9 check 16 / AC-0B-6.3: the published view is read-only');

SELECT * FROM finish();
ROLLBACK;
