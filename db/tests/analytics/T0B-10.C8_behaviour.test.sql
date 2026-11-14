-- T0B-10.C8 behaviour suite: tenant / centre isolation, non-staff actors and fail-closed no-claims, class R write rules (system actor only, no UPDATE), refresh_state '_manual' user path, retention deletes by expires_at,
-- exports (own rows, queued insert, mutable columns + transition guard), export_files / report_runs / report_run_recipients visibility, schedules (codes guard, 20-active-recipient cap, audit, no DELETE)
-- (C8 05-SCHEMA §3, §4, §5, §6; AC-0B-2.4, 3.1-3.5, 3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3).
-- The generated per-table probes (db/tests/isolation/analytics.<t>.test.sql) are the AC-0B-3.x proof for every table; this file proves what the generator cannot know.
-- Synthetic data only (seeds 010: tenant A 01a1a98a-...-a001, tenant B ...-b001; centres a201, a202, b201; memberships a500 all-centres staff, a501/a502 staff, a50a staff restricted to centre a201, b500).
-- One rolled-back transaction. RLS is never disabled: fixtures are inserted by the superuser test session with the core system actor's claims set (audit context); every assertion runs as SET LOCAL ROLE lims_app / lims_api (pg_temp.x).
-- Run from the repo root: pg_prove -d <db> db/tests/analytics/T0B-10.C8_behaviour.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers: C8 check 8 fixtures + seeds, 9 tenant isolation (AC-0B-3.1/3.2/3.3/3.5), 10 centre isolation + non-staff actors + no claims (AC-0B-3.4/3.7), 11 class R write rules, 12 refresh bookkeeping + retention deletes,
-- 13 exports / export_files / report_runs / report_run_recipients (AC-0B-4.1), 14 schedules + audit + class A event_inbox (AC-0B-4.3, 5.1, 5.2, 5.3).
-- Order matters inside the transaction: read-only checks first, state-changing statements last.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c800-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
CREATE FUNCTION pg_temp.m(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-00000000' || s)::uuid $$;     -- membership ids: a500, a501, a502, a50a, b500
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);

CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r jsonb := p_row; a text; cols text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  IF r ? 'tenant_id' THEN PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', r->>'tenant_id', 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true); END IF;
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.sys()); END IF;
  END LOOP;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, r::text);
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
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
CREATE FUNCTION pg_temp.cpb(p_tbl regclass, p_where text, p_over jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE j jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE %s', p_tbl, p_where) INTO j;
  RETURN format('INSERT INTO %1$s SELECT * FROM jsonb_populate_record(NULL::%1$s, %2$L::jsonb)', p_tbl, (j || p_over)::text);
END $f$;
CREATE TEMP TABLE tt(q) AS VALUES
  ('analytics.daily_orders'),('analytics.daily_centre_volume'),('analytics.daily_referrer_volume'),('analytics.daily_income'),('analytics.daily_department_income'),('analytics.daily_collections'),
  ('analytics.daily_referrer_billing'),('analytics.daily_results'),('analytics.daily_specimens'),('analytics.daily_rejections'),('analytics.daily_critical_values'),('analytics.tat_facts'),
  ('analytics.daily_releases'),('analytics.daily_deliveries'),('analytics.daily_interface_messages'),('analytics.report_backlog'),('analytics.refresh_state'),('analytics.dirty_partitions'),
  ('analytics.refresh_runs'),('analytics.order_index'),('analytics.exports'),('analytics.export_files'),('analytics.schedules'),('analytics.schedule_recipients'),('analytics.report_runs'),('analytics.report_run_recipients');

-- ===================================================================================================================================== fixtures (superuser, system claims)
-- C8 check 8: rollup rows (A centre a201 / a202 / NULL centre, B), bookkeeping, exports, schedules, runs
SELECT pg_temp.ins('analytics.daily_orders', jsonb_build_object('tenant_id', r.t, 'business_date', current_date, 'branch_id', r.b, 'centre_id', r.c, 'orders_registered', 3, 'refresh_run_id', pg_temp.uid(700)))
  FROM (VALUES (pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201')), (pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a202')), (pg_temp.tb(), pg_temp.id('00000000b101'), pg_temp.id('00000000b201'))) r(t, b, c);
SELECT pg_temp.ins('analytics.daily_income', jsonb_build_object('tenant_id', r.t, 'business_date', current_date, 'branch_id', r.b, 'centre_id', r.c, 'net_paisa', 1000, 'refresh_run_id', pg_temp.uid(700)))
  FROM (VALUES (pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201')), (pg_temp.ta(), pg_temp.id('00000000a101'), NULL::uuid), (pg_temp.tb(), pg_temp.id('00000000b101'), pg_temp.id('00000000b201'))) r(t, b, c);
SELECT pg_temp.ins('analytics.refresh_state', jsonb_build_object('tenant_id', r.t, 'family', r.f)) FROM (VALUES (pg_temp.ta(), 'orders'), (pg_temp.ta(), '_manual'), (pg_temp.tb(), 'orders')) r(t, f);
SELECT pg_temp.ins('analytics.dirty_partitions', jsonb_build_object('tenant_id', r.t, 'family', 'orders', 'business_date', current_date, 'reason', 'event')) FROM (VALUES (pg_temp.ta()), (pg_temp.tb())) r(t);
SELECT pg_temp.ins('analytics.refresh_runs', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'family', 'orders', 'trigger', 'manual', 'started_at', now() - r.age, 'status', r.st, 'expires_at', r.ex))
  FROM (VALUES (701, pg_temp.ta(), interval '100 days', 'succeeded', now() - interval '10 days'), (702, pg_temp.ta(), interval '1 hour', 'running', now() + interval '89 days'), (703, pg_temp.tb(), interval '100 days', 'succeeded', now() - interval '10 days')) r(n, t, age, st, ex);
SELECT pg_temp.ins('analytics.order_index', jsonb_build_object('tenant_id', r.t, 'order_id', pg_temp.uid(r.n), 'expires_at', r.ex))
  FROM (VALUES (711, pg_temp.ta(), now() - interval '1 day'), (712, pg_temp.ta(), now() + interval '300 days'), (713, pg_temp.tb(), now() - interval '1 day')) r(n, t, ex);
SELECT pg_temp.ins('analytics.exports', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'requested_by_membership_id', r.m, 'report_code', 'income', 'format', 'csv', 'params', '{}'::jsonb, 'scope_all_centres', true, 'status', r.st) || r.x)
  FROM (VALUES (721, pg_temp.ta(), pg_temp.m('a500'), 'queued', '{}'::jsonb), (722, pg_temp.ta(), pg_temp.m('a501'), 'queued', '{}'::jsonb), (723, pg_temp.tb(), pg_temp.m('b500'), 'queued', '{}'::jsonb),
               (724, pg_temp.ta(), pg_temp.m('a500'), 'ready', jsonb_build_object('ready_at', now(), 'expires_at', now() + interval '1 day', 'sha256', repeat('a', 64)))) r(n, t, m, st, x);
INSERT INTO analytics.export_files (tenant_id, export_id, content, content_type, sha256, created_by, expires_at)
  VALUES (pg_temp.ta(), pg_temp.uid(724), '\x00'::bytea, 'text/csv; charset=utf-8', repeat('a', 64), pg_temp.sys(), now() + interval '1 day');
SELECT pg_temp.ins('analytics.schedules', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'name', 'Synthetic schedule ' || r.n, 'report_codes', jsonb_build_array('income'), 'frequency', 'daily', 'send_time_local', '08:00',
    'period_rule', 'previous_business_day', 'scope_all_centres', true, 'owner_membership_id', r.m))
  FROM (VALUES (731, pg_temp.ta(), pg_temp.m('a500')), (732, pg_temp.ta(), pg_temp.m('a501')), (733, pg_temp.tb(), pg_temp.m('b500'))) r(n, t, m);
SELECT pg_temp.ins('analytics.schedule_recipients', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'schedule_id', pg_temp.uid(r.s), 'membership_id', r.m))
  FROM (VALUES (741, pg_temp.ta(), 731, pg_temp.m('a501')), (742, pg_temp.ta(), 731, pg_temp.m('a50a')), (743, pg_temp.tb(), 733, pg_temp.m('b500'))) r(n, t, s, m);
SELECT pg_temp.ins('analytics.report_runs', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'schedule_id', pg_temp.uid(r.s), 'slot_start', now() - r.age, 'report_codes', jsonb_build_array('income'), 'period_from', current_date - 1, 'period_to', current_date,
    'scope_all_centres', true, 'expires_at', r.ex))
  FROM (VALUES (751, pg_temp.ta(), 731, interval '1 hour', now() + interval '399 days'), (752, pg_temp.ta(), 731, interval '500 days', now() - interval '100 days'), (753, pg_temp.tb(), 733, interval '1 hour', now() + interval '399 days')) r(n, t, s, age, ex);
SELECT pg_temp.ins('analytics.report_run_recipients', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'report_run_id', pg_temp.uid(r.run), 'schedule_id', pg_temp.uid(r.s), 'membership_id', r.m, 'outcome', 'queued', 'expires_at', r.ex))
  FROM (VALUES (761, pg_temp.ta(), 751, 731, pg_temp.m('a501'), now() + interval '399 days'), (762, pg_temp.ta(), 751, 731, pg_temp.m('a50a'), now() + interval '399 days'),
               (763, pg_temp.ta(), 752, 731, pg_temp.m('a50a'), now() - interval '100 days'), (764, pg_temp.tb(), 753, 733, pg_temp.m('b500'), now() + interval '399 days')) r(n, t, run, s, m, ex);

SELECT is((SELECT count(*)::int FROM analytics.g_cs_families), 17, 'C8 check 8: 16 families + _manual seeded (§4)');
SELECT is((SELECT is_active FROM analytics.g_cs_families WHERE code = '_manual'), false, 'C8 check 8: _manual family is inactive (never in UI lists)');
SELECT is((SELECT count(*)::int FROM analytics.g_cs_families WHERE is_active), 16, 'C8 check 8: 16 active families');
SELECT is((SELECT count(*)::int FROM analytics.g_cs_report_codes), 14, 'C8 check 8: 14 report codes seeded (§4)');
SELECT is((SELECT array_agg(code ORDER BY code) FROM analytics.g_cs_report_codes WHERE NOT is_schedulable), ARRAY['interfaces'], 'C8 check 8: only interfaces is not schedulable');
SELECT is((SELECT count(*)::int FROM analytics.daily_orders), 3, 'C8 check 8: fixtures present (superuser sees all)');

-- ===================================================================================================================================== read-only checks first
-- C8 check 9: tenant isolation (AC-0B-3.1 / 3.2 / 3.3 / 3.5)
SELECT is(pg_temp.sa('SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 'n'), 'n=0', 'C8 check 9 / AC-0B-3.1: tenant A system actor sees 0 tenant B rows of ' || q) FROM tt;
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 'n'), 'n=0', 'C8 check 9 / AC-0B-3.1: tenant A staff user sees 0 tenant B rows of ' || q) FROM tt;
SELECT is(pg_temp.sb('SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'C8 check 9 / AC-0B-3.1: tenant B system actor sees 0 tenant A rows of ' || q) FROM tt;
SELECT matches(pg_temp.sa('INSERT INTO analytics.daily_orders (tenant_id, business_date, branch_id, centre_id, refresh_run_id) VALUES (' || quote_literal(pg_temp.tb()) || ', current_date + 1, ' || quote_literal(pg_temp.id('00000000b101')) || ', ' || quote_literal(pg_temp.id('00000000b201')) || ', ' || quote_literal(pg_temp.uid(700)) || ')'), '^E42501\|', 'C8 check 9 / AC-0B-3.2: tenant A claims cannot INSERT a tenant B rollup row (42501)');
SELECT matches(pg_temp.sa(pg_temp.cpb('analytics.schedules', 'id = ' || quote_literal(pg_temp.uid(733)), jsonb_build_object('id', pg_temp.uid(799), 'tenant_id', pg_temp.tb(), 'name', 'x'))), '^E42501\|', 'C8 check 9 / AC-0B-3.2: tenant A claims cannot INSERT a tenant B schedule (42501)');
SELECT is(pg_temp.sa('UPDATE analytics.schedules SET name = ''hijack'' WHERE tenant_id = ' || quote_literal(pg_temp.tb())), 'n=0', 'C8 check 9 / AC-0B-3.3: tenant A claims update 0 tenant B schedules');
SELECT is(pg_temp.sa('DELETE FROM analytics.refresh_runs WHERE tenant_id = ' || quote_literal(pg_temp.tb())), 'n=0', 'C8 check 9 / AC-0B-3.3: tenant A system actor deletes 0 tenant B refresh_runs (even expired)');
SELECT is(pg_temp.sa('DELETE FROM analytics.daily_orders WHERE tenant_id = ' || quote_literal(pg_temp.tb())), 'n=0', 'C8 check 9 / AC-0B-3.3: tenant A system actor deletes 0 tenant B rollup rows');
SELECT matches(pg_temp.sa('INSERT INTO analytics.schedule_recipients (id, tenant_id, schedule_id, membership_id, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(798)) || ', ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.uid(733)) || ', '
    || quote_literal(pg_temp.m('a502')) || ', ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E(23503|42501)\|', 'C8 check 9 / AC-0B-3.5: a tenant A child row referencing tenant B''s schedule is refused (composite FK)');
SELECT matches(pg_temp.sa('INSERT INTO analytics.schedule_recipients (id, tenant_id, schedule_id, membership_id, created_by, updated_by) VALUES (' || quote_literal(pg_temp.uid(797)) || ', ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.uid(731)) || ', '
    || quote_literal(pg_temp.m('b500')) || ', ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E(23503|42501)\|', 'C8 check 9 / AC-0B-3.5: a tenant A recipient row referencing a tenant B membership is refused');

-- C8 check 10: centre isolation (AC-0B-3.4), NULL-centre rows, non-staff actors (AC-0B-3.6a/3.6b), no claims (AC-0B-3.7)
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM analytics.daily_orders WHERE centre_id = ' || quote_literal(pg_temp.id('00000000a202')), 'n'), 'n=0', 'C8 check 10 / AC-0B-3.4: centre-A1 staff sees 0 centre A2 rows of daily_orders');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM analytics.daily_orders WHERE centre_id = ' || quote_literal(pg_temp.id('00000000a201')), 'n'), 'n=1', 'C8 check 10 / AC-0B-3.4: centre-A1 staff sees its centre A1 row');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM analytics.daily_orders', 'n'), 'n=2', 'C8 check 10: all-centres staff sees both tenant A centres');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM analytics.daily_income WHERE centre_id IS NULL', 'n'), 'n=0', 'C8 check 10 / PRD §8.3: NULL-centre rollup rows are hidden from centre-restricted staff');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM analytics.daily_income WHERE centre_id IS NULL', 'n'), 'n=1', 'C8 check 10 / PRD §8.3: NULL-centre rollup rows are visible to all-centres staff');
SELECT is(pg_temp.sa('SELECT 1 FROM analytics.daily_income WHERE centre_id IS NULL', 'n'), 'n=1', 'C8 check 10: the system actor (has_all_centres) sees NULL-centre rows');
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM ' || q, 'n') ~ '^n=\d+$', true, 'C8 check 10: centre-restricted staff query on ' || q || ' does not error') FROM tt;
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'C8 check 10 / AC-0B-3.6a: ' || k.t || ' actor sees 0 rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('partner'),('portal'),('patient')) k(t);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device'), 'SELECT 1 FROM analytics.daily_orders', 'n'), 'n=0', 'C8 check 10: a device actor has no centre in scope and sees 0 rollup rows');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C8 check 10 / AC-0B-3.7: no claims -> lims_api sees 0 rows of ' || q) FROM tt;
SELECT is(pg_temp.x('lims_api', '{}'::jsonb, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C8 check 10 / AC-0B-3.7: empty claims -> 0 rows of ' || q) FROM tt;

-- C8 check 11: class R write rules (CR-C8-003): INSERT / DELETE by the system actor only, no UPDATE grant
SELECT matches(pg_temp.ua(pg_temp.m('a500'), 'INSERT INTO analytics.daily_orders (tenant_id, business_date, branch_id, centre_id, refresh_run_id) VALUES (' || quote_literal(pg_temp.ta()) || ', current_date - 1, ' || quote_literal(pg_temp.id('00000000a101')) || ', '
    || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(700)) || ')'), '^E42501\|', 'C8 check 11: a staff user (not system) cannot INSERT a rollup row (42501)');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'DELETE FROM analytics.daily_orders'), 'n=0', 'C8 check 11: a staff user deletes 0 rollup rows (DELETE is system-only)');
SELECT matches(pg_temp.sa('UPDATE analytics.daily_orders SET orders_registered = 99'), '^E42501\|permission denied', 'C8 check 11: even the system actor has no UPDATE grant on class R (delete + insert refresh only)');
SELECT matches(pg_temp.sa('UPDATE analytics.tat_facts SET duration_seconds = 1'), '^E42501\|permission denied', 'C8 check 11: no UPDATE on tat_facts');
SELECT is(pg_temp.sa('INSERT INTO analytics.daily_orders (tenant_id, business_date, branch_id, centre_id, refresh_run_id) VALUES (' || quote_literal(pg_temp.ta()) || ', current_date - 1, ' || quote_literal(pg_temp.id('00000000a101')) || ', '
    || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(700)) || ')'), 'n=1', 'C8 check 11: the system actor INSERTs a rollup row');
SELECT matches(pg_temp.sa('INSERT INTO analytics.daily_orders (tenant_id, business_date, branch_id, centre_id, refresh_run_id) VALUES (' || quote_literal(pg_temp.ta()) || ', current_date - 1, ' || quote_literal(pg_temp.id('00000000a101')) || ', '
    || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(700)) || ')'), '^E23505\|', 'C8 check 11: the natural key rejects a duplicate (delete + insert refresh)');
SELECT matches(pg_temp.sa('INSERT INTO analytics.daily_orders (tenant_id, business_date, branch_id, centre_id, refresh_run_id, orders_registered) VALUES (' || quote_literal(pg_temp.ta()) || ', current_date - 2, ' || quote_literal(pg_temp.id('00000000a101')) || ', '
    || quote_literal(pg_temp.id('00000000a201')) || ', ' || quote_literal(pg_temp.uid(700)) || ', -1)'), '^E23514\|', 'C8 check 11: counts are non-negative (CHECK)');
SELECT is(pg_temp.sa('INSERT INTO analytics.daily_income (tenant_id, business_date, branch_id, centre_id, refresh_run_id) VALUES (' || quote_literal(pg_temp.ta()) || ', current_date, ' || quote_literal(pg_temp.id('00000000a101')) || ', NULL, ' || quote_literal(pg_temp.uid(700)) || ')') ~ '^E23505\|', true,
          'C8 check 11: UNIQUE NULLS NOT DISTINCT: a second NULL-centre daily_income row for the same key is a duplicate');
SELECT is(pg_temp.sa('DELETE FROM analytics.daily_orders WHERE business_date < current_date'), 'n=1', 'C8 check 11: the system actor DELETEs a rollup partition (partition replace)');

-- C8 check 12: refresh bookkeeping (P-22), dirty marks, retention deletes by expires_at (P-18(c)) as the system actor
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.refresh_state SET last_manual_at = now() WHERE family = ''_manual'''), 'n=1', 'C8 check 12 / P-22: a staff user updates the _manual throttle row');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.refresh_state SET consecutive_failures = 5 WHERE family = ''orders'''), 'n=0', 'C8 check 12: a staff user cannot update a system-written family row');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), 'INSERT INTO analytics.refresh_state (tenant_id, family, created_by) VALUES (' || quote_literal(pg_temp.ta()) || ', ''income'', ' || quote_literal(pg_temp.sys()) || ')'), '^E42501\|', 'C8 check 12: a staff user cannot insert a non-_manual refresh_state row');
SELECT is(pg_temp.sa('INSERT INTO analytics.refresh_state (tenant_id, family, created_by) VALUES (' || quote_literal(pg_temp.ta()) || ', ''income'', ' || quote_literal(pg_temp.sys()) || ')'), 'n=1', 'C8 check 12: the system actor inserts any family');
SELECT matches(pg_temp.sa('DELETE FROM analytics.refresh_state'), '^E42501\|permission denied','C8 check 12: nobody deletes refresh_state (no grant)');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'INSERT INTO analytics.dirty_partitions (tenant_id, family, business_date, reason, created_by) VALUES (' || quote_literal(pg_temp.ta()) || ', ''income'', current_date, ''manual'', ' || quote_literal(pg_temp.sys()) || ')'), 'n=1', 'C8 check 12: a staff user inserts a dirty mark (manual refresh)');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'DELETE FROM analytics.dirty_partitions'), 'n=0', 'C8 check 12: a staff user cannot delete dirty marks');
SELECT is(pg_temp.sa('DELETE FROM analytics.dirty_partitions WHERE family = ''income'''), 'n=1', 'C8 check 12: the system actor deletes a processed dirty mark');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM analytics.refresh_runs', 'n'), 'n=2', 'C8 check 12: staff read refresh_runs (pred_t)');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM analytics.order_index', 'n'), 'n=0', 'C8 check 12: order_index is readable by the system actor only');
SELECT is(pg_temp.sa('SELECT 1 FROM analytics.order_index', 'n'), 'n=2', 'C8 check 12: the system actor reads order_index');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'DELETE FROM analytics.refresh_runs WHERE true'), 'n=0', 'C8 check 12: staff cannot delete refresh_runs');
SELECT is(pg_temp.sa('DELETE FROM analytics.refresh_runs'), 'n=1', 'C8 check 12: system retention delete removes only the expired refresh_runs row (expires_at < now())');
SELECT is(pg_temp.sa('DELETE FROM analytics.order_index'), 'n=1', 'C8 check 12: system retention delete removes only the expired order_index row');
SELECT is(pg_temp.sa('UPDATE analytics.refresh_runs SET status = ''succeeded'', finished_at = now(), rows_written = 4 WHERE id = ' || quote_literal(pg_temp.uid(702))), 'n=1', 'C8 check 12: running -> succeeded finishes a refresh run');
SELECT matches(pg_temp.sa('UPDATE analytics.refresh_runs SET family = ''income'' WHERE id = ' || quote_literal(pg_temp.uid(702))), '^EP0001\|immutable_row', 'C8 check 12 / AC-0B-4.1: only finished_at / status / rows_written / error_code may change');
SELECT matches(pg_temp.sa('UPDATE analytics.refresh_runs SET status = ''running'', finished_at = NULL WHERE id = ' || quote_literal(pg_temp.uid(702))), '^E(P0001|23514)\|', 'C8 check 12 (§5): status moves running -> succeeded|failed only; a finished run cannot be reopened');

-- C8 check 13: exports / export_files / report_runs / report_run_recipients (AC-0B-4.1)
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM analytics.exports', 'n'), 'n=2', 'C8 check 13: a user sees only its own exports (721, 724)');
SELECT is(pg_temp.ua(pg_temp.m('a501'), 'SELECT 1 FROM analytics.exports', 'n'), 'n=1', 'C8 check 13: another user sees only its own export');
SELECT is(pg_temp.sa('SELECT 1 FROM analytics.exports', 'n'), 'n=3', 'C8 check 13: the system actor sees all tenant A exports');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM analytics.export_files', 'n'), 'n=1', 'C8 check 13: the requester reads its export file');
SELECT is(pg_temp.ua(pg_temp.m('a501'), 'SELECT 1 FROM analytics.export_files', 'n'), 'n=0', 'C8 check 13: another user reads 0 export files');
SELECT is(pg_temp.sa('SELECT 1 FROM analytics.export_files', 'n'), 'n=1', 'C8 check 13: the system actor reads export files');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), 'INSERT INTO analytics.export_files (tenant_id, export_id, content, content_type, sha256, created_by, expires_at) VALUES (' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.uid(721)) || ', ''\x00''::bytea, ''text/csv; charset=utf-8'', repeat(''b'', 64), '
    || quote_literal(pg_temp.sys()) || ', now())'), '^E42501\|', 'C8 check 13: a user cannot write export_files (system only)');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.export_files SET sha256 = repeat(''c'', 64)'), '^E42501\|permission denied', 'C8 check 13: no UPDATE grant on export_files');
SELECT is(pg_temp.ua(pg_temp.m('a500'), pg_temp.cpb('analytics.exports', 'id = ' || quote_literal(pg_temp.uid(721)), jsonb_build_object('id', pg_temp.uid(790)))), 'n=1', 'C8 check 13: a user inserts a queued export for itself');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), pg_temp.cpb('analytics.exports', 'id = ' || quote_literal(pg_temp.uid(721)), jsonb_build_object('id', pg_temp.uid(791), 'requested_by_membership_id', pg_temp.m('a501')))), '^E42501\|', 'C8 check 13: a user cannot create an export for another membership');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), pg_temp.cpb('analytics.exports', 'id = ' || quote_literal(pg_temp.uid(724)), jsonb_build_object('id', pg_temp.uid(792)))), '^E42501\|', 'C8 check 13: a user cannot insert an export that is not queued');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.exports SET downloads_used = downloads_used + 1 WHERE id = ' || quote_literal(pg_temp.uid(724))), 'n=1', 'C8 check 13: a user may bump downloads_used by 1');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.exports SET downloads_used = downloads_used + 2 WHERE id = ' || quote_literal(pg_temp.uid(724))), '^E(P0001|23514)\|', 'C8 check 13 (§5): downloads_used may only increase by 1 (and stay <= downloads_allowed)');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.exports SET format = ''pdf'' WHERE id = ' || quote_literal(pg_temp.uid(724))), '^EP0001\|immutable_row', 'C8 check 13 / AC-0B-4.1: a column outside the mutable list fails with P0001 immutable_row');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.exports SET status = ''expired'' WHERE id = ' || quote_literal(pg_temp.uid(724))), '^EP0001\|', 'C8 check 13 (§5): a non-system actor may change only downloads_used / updated_at / updated_by / version');
SELECT is(pg_temp.ua(pg_temp.m('a501'), 'UPDATE analytics.exports SET downloads_used = downloads_used + 1 WHERE id = ' || quote_literal(pg_temp.uid(724))), 'n=0', 'C8 check 13: another user updates 0 rows of someone else''s export');
SELECT matches(pg_temp.sa('UPDATE analytics.exports SET status = ''expired'' WHERE id = ' || quote_literal(pg_temp.uid(721))), '^EP0001\|', 'C8 check 13 (§5): queued -> expired is not an allowed transition');
SELECT matches(pg_temp.sa('UPDATE analytics.exports SET status = ''queued'' WHERE id = ' || quote_literal(pg_temp.uid(724))), '^E(P0001|23514)\|', 'C8 check 13 (§5): ready -> queued is not an allowed transition');
SELECT is(pg_temp.sa('UPDATE analytics.exports SET status = ''building'', building_started_at = now() WHERE id = ' || quote_literal(pg_temp.uid(721))), 'n=1', 'C8 check 13 (§5): queued -> building by the system actor');
SELECT is(pg_temp.sa('UPDATE analytics.exports SET status = ''failed'', failure_code = ''export.build_failed'' WHERE id = ' || quote_literal(pg_temp.uid(721))), 'n=1', 'C8 check 13 (§5): building -> failed (with failure_code)');
SELECT is(pg_temp.sa('UPDATE analytics.exports SET status = ''expired'' WHERE id = ' || quote_literal(pg_temp.uid(724))), 'n=1', 'C8 check 13 (§5): ready -> expired');
SELECT is(pg_temp.sa('DELETE FROM analytics.exports'), 'n=0', 'C8 check 13: exports metadata is deleted only after 400 days (requested_at)');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM analytics.report_runs', 'n'), 'n=2', 'C8 check 13: the schedule owner sees both runs of its schedule');
SELECT is(pg_temp.ua(pg_temp.m('a501'), 'SELECT 1 FROM analytics.report_runs', 'n'), 'n=1', 'C8 check 13: a recipient sees only the run it received');
SELECT is(pg_temp.ua(pg_temp.m('a502'), 'SELECT 1 FROM analytics.report_runs', 'n'), 'n=0', 'C8 check 13: an unrelated user sees 0 runs');
SELECT is(pg_temp.sa('SELECT 1 FROM analytics.report_runs', 'n'), 'n=2', 'C8 check 13: the system actor sees all tenant A runs');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM analytics.report_run_recipients', 'n'), 'n=3', 'C8 check 13: the schedule owner sees every recipient row (via schedule_id)');
SELECT is(pg_temp.ua(pg_temp.m('a501'), 'SELECT 1 FROM analytics.report_run_recipients', 'n'), 'n=1', 'C8 check 13: a recipient sees only its own row');
SELECT is(pg_temp.ua(pg_temp.m('a502'), 'SELECT 1 FROM analytics.report_run_recipients', 'n'), 'n=0', 'C8 check 13: an unrelated user sees 0 recipient rows');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), pg_temp.cpb('analytics.report_runs', 'id = ' || quote_literal(pg_temp.uid(751)), jsonb_build_object('id', pg_temp.uid(793), 'slot_start', now() - interval '3 days'))), '^E42501\|', 'C8 check 13: a user cannot create report_runs (system only)');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.report_runs SET sent_count = 1'), 'n=0', 'C8 check 13: a user updates 0 report_runs rows');
SELECT is(pg_temp.sa('UPDATE analytics.report_runs SET sent_count = 2, state = ''dispatched'' WHERE id = ' || quote_literal(pg_temp.uid(751))), 'n=1', 'C8 check 13: the system actor updates counts of a run');
SELECT matches(pg_temp.sa('UPDATE analytics.report_runs SET schedule_id = ' || quote_literal(pg_temp.uid(732)) || ' WHERE id = ' || quote_literal(pg_temp.uid(751))), '^E(P0001|23503)\|', 'C8 check 13 / AC-0B-4.1: schedule_id of a run is frozen (mutable list)');
SELECT matches(pg_temp.sa('UPDATE analytics.report_run_recipients SET outcome = ''failed'''), '^E42501\|permission denied', 'C8 check 13: report_run_recipients has no UPDATE (outcome set once)');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'DELETE FROM analytics.report_run_recipients'), 'n=0', 'C8 check 13: a user deletes 0 recipient rows');
SELECT is(pg_temp.sa('DELETE FROM analytics.report_run_recipients'), 'n=1', 'C8 check 13: system retention delete removes only the expired recipient row');
SELECT is(pg_temp.sa('DELETE FROM analytics.report_runs'), 'n=1', 'C8 check 13: system retention delete removes only the expired run');
SELECT is(pg_temp.sa('DELETE FROM analytics.export_files'), 'n=1', 'C8 check 13: the system actor deletes an export file (also before expires_at)');

-- C8 check 14: schedules (guards, cap, deactivate-only), audit (AC-0B-5.1 / 5.2 / 5.3), class A event_inbox (AC-0B-4.3)
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.schedules SET name = ''Renamed schedule'' WHERE id = ' || quote_literal(pg_temp.uid(731))), 'n=1', 'C8 check 14: the schedule is renamed under staff claims');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'analytics' AND table_name = 'schedules' AND row_id = pg_temp.uid(731) AND action = 'UPDATE'), 1, 'C8 check 14 / AC-0B-5.1: exactly one audit_log row for the UPDATE');
SELECT is((SELECT changed_columns FROM audit.audit_log WHERE schema_name = 'analytics' AND table_name = 'schedules' AND row_id = pg_temp.uid(731) AND action = 'UPDATE' ORDER BY occurred_at DESC LIMIT 1) @> ARRAY['name'], true, 'C8 check 14 / AC-0B-5.2: changed_columns lists name');
SELECT is((SELECT new_values ? 'owner_membership_id' FROM audit.audit_log WHERE schema_name = 'analytics' AND table_name = 'schedules' AND row_id = pg_temp.uid(731) AND action = 'UPDATE' ORDER BY occurred_at DESC LIMIT 1), false, 'C8 check 14 / AC-0B-5.2: new_values holds only the changed columns');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'analytics' AND table_name = 'schedule_recipients' AND action = 'INSERT') > 0, true, 'C8 check 14 / AC-0B-5.1: schedule_recipients writes are audited');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'analytics' AND table_name NOT IN ('schedules','schedule_recipients')), 0, 'C8 check 14: no other analytics table is audited');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), 'INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_type) VALUES (gen_random_uuid(), ' || quote_literal(pg_temp.ta()) || ', ''analytics'', ''schedules'', ''INSERT'', ''user'')'), '^E42501\|', 'C8 check 14 / AC-0B-5.3: lims_app cannot INSERT into audit.audit_log');
SELECT is(has_table_privilege('lims_app', 'analytics.event_inbox', 'UPDATE'), false, 'C8 check 14 / AC-0B-4.3: lims_app has no UPDATE on the class A analytics.event_inbox');
SELECT is(has_table_privilege('lims_app', 'analytics.event_inbox', 'DELETE'), false, 'C8 check 14 / AC-0B-4.2: lims_app has no DELETE on the class A analytics.event_inbox');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), pg_temp.cpb('analytics.schedules', 'id = ' || quote_literal(pg_temp.uid(731)), jsonb_build_object('id', pg_temp.uid(780), 'report_codes', jsonb_build_array('interfaces')))), '^E23514\|', 'C8 check 14 (§6): a non-schedulable report code is refused on INSERT (23514)');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.schedules SET report_codes = ARRAY[''income'',''no_such_report''] WHERE id = ' || quote_literal(pg_temp.uid(731))), '^E23514\|', 'C8 check 14 (§6): an unknown report code is refused on UPDATE (23514)');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.schedules SET report_codes = ARRAY[''income'',''tat''] WHERE id = ' || quote_literal(pg_temp.uid(731))), 'n=1', 'C8 check 14: schedulable codes are accepted');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), 'DELETE FROM analytics.schedules'), '^E42501\|permission denied', 'C8 check 14 / D-45: schedules cannot be deleted (deactivate only)');
SELECT matches(pg_temp.sa('DELETE FROM analytics.schedule_recipients'), '^E42501\|permission denied', 'C8 check 14 / D-45: schedule_recipients cannot be deleted');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.schedule_recipients SET is_active = false WHERE id = ' || quote_literal(pg_temp.uid(742))), 'n=1', 'C8 check 14 / D-45: a recipient is removed by deactivation');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.schedule_recipients SET is_active = true WHERE id = ' || quote_literal(pg_temp.uid(742))), 'n=1', 'C8 check 14 / D-45: re-adding reactivates the same row');
-- cap: <= 20 ACTIVE recipients per schedule. 22 extra synthetic memberships of tenant A (superuser fixtures, system claims) fill schedule 732 up to 20 active; the 21st is refused; a deactivated row does not count.
SELECT pg_temp.ins('core.users', jsonb_build_object('tenant_id', pg_temp.ta(), 'id', pg_temp.uid(900 + g), 'display_name', 'Synthetic cap user ' || g)) FROM generate_series(1, 22) g;
SELECT pg_temp.ins('core.memberships', jsonb_build_object('id', pg_temp.uid(930 + g), 'tenant_id', pg_temp.ta(), 'user_id', pg_temp.uid(900 + g), 'actor_type', 'user', 'all_centres', false, 'status', 'active')) FROM generate_series(1, 22) g;
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'INSERT INTO analytics.schedule_recipients (id, tenant_id, schedule_id, membership_id, created_by, updated_by) VALUES '
    || (SELECT string_agg(format('(gen_random_uuid(), %L, %L, %L, %L, %L)', pg_temp.ta(), pg_temp.uid(732), pg_temp.uid(930 + g), pg_temp.sys(), pg_temp.sys()), ',') FROM generate_series(1, 20) g)), 'n=20', 'C8 check 14 (§5): 20 active recipients are accepted');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), 'INSERT INTO analytics.schedule_recipients (id, tenant_id, schedule_id, membership_id, created_by, updated_by) VALUES (gen_random_uuid(), ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.uid(732)) || ', '
    || quote_literal(pg_temp.uid(951)) || ', ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), '^E(23514|P0001)\|', 'C8 check 14 (§5): the 21st active recipient is refused');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.schedule_recipients SET is_active = false WHERE schedule_id = ' || quote_literal(pg_temp.uid(732)) || ' AND membership_id = ' || quote_literal(pg_temp.uid(931))), 'n=1', 'C8 check 14: one recipient is deactivated');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'INSERT INTO analytics.schedule_recipients (id, tenant_id, schedule_id, membership_id, created_by, updated_by) VALUES (gen_random_uuid(), ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.uid(732)) || ', '
    || quote_literal(pg_temp.uid(951)) || ', ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')'), 'n=1', 'C8 check 14 (D-45): a deactivated recipient frees a slot (the cap counts is_active rows only)');
SELECT matches(pg_temp.ua(pg_temp.m('a500'), 'UPDATE analytics.schedule_recipients SET is_active = true WHERE schedule_id = ' || quote_literal(pg_temp.uid(732)) || ' AND membership_id = ' || quote_literal(pg_temp.uid(931))), '^E(23514|P0001)\|', 'C8 check 14 (D-45): reactivating beyond 20 active is refused');

SELECT * FROM finish();
ROLLBACK;
