-- T0B-13.C15 behaviour suite: tenant isolation, staff/system-only actor guard (P-16), no DELETE anywhere, immutable columns, intent + refund transition guards (every allowed and every forbidden pair), partial uniques,
-- composite FKs, CHECKs, DEFINER callback lookup (A12.7 a-c), audit without secrets (C15 05-SCHEMA §3, §4, §6, §10 tests 1-14; AC-0B-2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3).
-- The generated per-table probes (db/tests/isolation/payments.<t>.test.sql) are the AC-0B-3.x proof for every table; this file proves what the generator cannot know (guards, transitions, uniques, FKs, CHECKs, actor guard, DEFINER).
-- Synthetic data only (seeds 010: tenant A 01a1a98a-...-a001, tenant B ...-b001; branches a101 / b101; centres a201, a202, b201; memberships a500 all-centres staff, a50a staff restricted to centre a201, b500).
-- One rolled-back transaction. RLS is never disabled. FK PARENT rows of other chunks (frontdesk patients / orders) and every payments fixture are inserted by the superuser test session inside ONE block
-- with the replica session replication role (FK + user triggers off; RLS, CHECK and NOT NULL stay on; C9..C14 precedent) that is reset to origin before the first assertion; a second block (marked) adds the transition-pair rows
-- late, after every count assertion. Every assertion runs as SET LOCAL ROLE lims_app / lims_api.
-- Run from the repo root: pg_prove -d <db> db/tests/payments/T0B-13.C15_behaviour.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers: C15 check 8 fixtures; "C15 test N" = 05-SCHEMA §10 test N: 1 tenant isolation + no DELETE (AC-0B-3.1/3.2/3.3/3.5, 4.2), 2 staff-actor guard (AC-0B-3.6/3.7), 3 immutable columns (AC-0B-4.1), 4 intent transition pairs,
-- 5 refund transition pairs, 6 partial unique open-intent race, 7 callbacks__no_mobile__ck, 8 idempotency-key grammar, 9 refunds__held__ck, 10 gateway_calls FKs, 11-13 DEFINER (A12.7 a, b, c), 14 audit (AC-0B-5.1/5.2/5.3).
-- AC-0B-3.4 (centre probe) is documented, not asserted as a restriction: payments policies are tenant-scoped (§3), so a centre-restricted staff user sees the same rows as a hub user.
-- Order matters inside the transaction: read-only checks first, failing statements next, state-changing statements last (fixtures are shared; each mutation is listed in its section).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c900-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
CREATE FUNCTION pg_temp.m(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-00000000' || s)::uuid $$;     -- membership ids: a500, a50a, b500
CREATE FUNCTION pg_temp.q(u uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal(u::text) $$;
CREATE FUNCTION pg_temp.u(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal(pg_temp.uid(n)::text) $$;
CREATE FUNCTION pg_temp.tok(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '\x' || encode(sha256(convert_to('syn-token-' || n::text, 'UTF8')), 'hex') $$;     -- callback_token_sha256 of intent n as a bytea literal text
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
-- run p_sql as p_role with p_claims (after the optional statement p_pre, same role); mode n = count of a query, w = ROW_COUNT of a statement, s = the single scalar; errors -> 'E' || SQLSTATE || '|' || SQLERRM
CREATE FUNCTION pg_temp.x(p_role text, p_claims jsonb, p_sql text, p_mode text DEFAULT 'n', p_pre text DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_pre IS NOT NULL THEN EXECUTE p_pre; END IF;
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
CREATE FUNCTION pg_temp.sb(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;                  -- tenant B system actor
CREATE FUNCTION pg_temp.ua(p_mem uuid, p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'user', p_mem), p_sql, p_mode) $$;   -- tenant A staff user
-- copy statement: INSERT of an existing row (by id; aid 0 = the tenant A payments.settings row) with overrides; the row is read NOW (superuser) and embedded as a literal, so it runs under any claims without reading the table
CREATE FUNCTION pg_temp.cps(p_q text, p_aid int, p_over jsonb DEFAULT '{}'::jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE j jsonb; cols text;
BEGIN
  IF p_aid = 0 THEN EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE tenant_id = %L', p_q, pg_temp.ta()) INTO j; p_over := p_over - 'id';
  ELSE EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE id = %L', p_q, pg_temp.uid(p_aid)) INTO j; END IF;
  IF j IS NULL THEN RAISE EXCEPTION 'cps: no row % in %', p_aid, p_q; END IF;
  SELECT string_agg(quote_ident(attname), ',' ORDER BY attnum) INTO cols FROM pg_attribute WHERE attrelid = p_q::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';
  RETURN format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_q, cols, (j || p_over)::text);
END $f$;
-- intent fixture row: p_n id / token / txn ref seed, p_t tenant, p_o order seed, p_gw gateway, p_st status (every field the status needs to satisfy the CHECKs is added), p_x overrides
CREATE FUNCTION pg_temp.ib(p_n int, p_t uuid, p_o int, p_gw text, p_st text, p_x jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(p_n), 'tenant_id', p_t, 'order_id', pg_temp.uid(p_o),
      'branch_id', CASE WHEN p_t = pg_temp.ta() THEN pg_temp.id('00000000a101') ELSE pg_temp.id('00000000b101') END,
      'centre_id', CASE WHEN p_t = pg_temp.ta() THEN pg_temp.id('00000000a201') ELSE pg_temp.id('00000000b201') END,
      'gateway', p_gw, 'environment', 'uat', 'merchant_account_id', pg_temp.uid(CASE WHEN p_t = pg_temp.tb() THEN 6003 WHEN p_gw = 'khalti' THEN 6001 ELSE 6002 END),
      'status', p_st, 'amount_paisa', 2000, 'idempotency_key', 'eng:' || pg_temp.uid(p_n)::text, 'request_fingerprint', repeat('a', 64),
      'return_url', 'https://syn.example/r', 'cancel_url', 'https://syn.example/c', 'callback_token_sha256', pg_temp.tok(p_n), 'created_actor_type', 'system')
    || CASE WHEN p_st = 'created' THEN '{}'::jsonb ELSE jsonb_build_object('gateway_txn_ref', CASE WHEN p_gw = 'esewa' THEN pg_temp.uid(p_n)::text ELSE 'pidx-' || p_n END) END
    || CASE WHEN p_st IN ('settled', 'refunded', 'partially_refunded') THEN jsonb_build_object('settled_at', now(), 'ledger_entry_id', pg_temp.uid(p_n + 900000), 'verified_amount_paisa', 2000,
         'verification_method', CASE WHEN p_gw = 'esewa' THEN 'esewa_status_check' ELSE 'khalti_lookup' END) ELSE '{}'::jsonb END
    || CASE p_st WHEN 'refunded' THEN jsonb_build_object('refunded_paisa', 2000) WHEN 'partially_refunded' THEN jsonb_build_object('refunded_paisa', 500) ELSE '{}'::jsonb END
    || CASE WHEN p_st = 'held_for_review' THEN jsonb_build_object('hold_reason', 'amount_mismatch') ELSE '{}'::jsonb END
    || CASE WHEN p_st IN ('failed', 'expired') THEN jsonb_build_object('failure_reason', 'gateway_cancelled') ELSE '{}'::jsonb END
    || p_x $$;
-- refund fixture row
CREATE FUNCTION pg_temp.rb(p_n int, p_t uuid, p_i int, p_o int, p_gw text, p_mode text, p_st text, p_x jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(p_n), 'tenant_id', p_t, 'intent_id', pg_temp.uid(p_i), 'order_id', pg_temp.uid(p_o),
      'centre_id', CASE WHEN p_t = pg_temp.ta() THEN pg_temp.id('00000000a201') ELSE pg_temp.id('00000000b201') END,
      'gateway', p_gw, 'mode', p_mode, 'status', p_st, 'amount_paisa', 1000, 'reason_code', 'test_cancelled', 'idempotency_key', 'refund:' || pg_temp.uid(p_n)::text,
      'requested_by_membership_id', CASE WHEN p_t = pg_temp.ta() THEN pg_temp.m('a500') ELSE pg_temp.m('b500') END, 'requested_at', now())
    || CASE WHEN p_st NOT IN ('pending_approval', 'rejected') THEN jsonb_build_object('approved_by_membership_id', pg_temp.m('a500'), 'approved_at', now()) ELSE '{}'::jsonb END
    || CASE WHEN p_st = 'held_for_review' THEN jsonb_build_object('held_reason', 'refund_not_visible') ELSE '{}'::jsonb END
    || CASE WHEN p_st = 'completed' THEN jsonb_build_object('completed_at', now(), 'ledger_entry_id', pg_temp.uid(p_n + 900000)) ELSE '{}'::jsonb END
    || CASE WHEN p_st = 'failed' THEN jsonb_build_object('failure_reason', 'refund_rejected_by_provider') ELSE '{}'::jsonb END
    || p_x $$;
-- tt: the 11 tenant tables with one tenant A row id each (settings: 0 = by tenant_id); tg: the G table; ts: tables with a lims_app UPDATE grant; ta_: the 3 class-A tables
CREATE TEMP TABLE tt(q, aid) AS VALUES ('payments.settings',0),('payments.merchant_accounts',6001),('payments.intents',6101),('payments.intent_transitions',6201),('payments.gateway_calls',6211),('payments.callbacks',6221),('payments.refunds',6301),
  ('payments.reconciliation_runs',6401),('payments.reconciliation_findings',6501),('payments.static_qr_reconciliations',6601),('payments.cs_reasons',7501);
CREATE TEMP TABLE tg(q) AS VALUES ('payments.g_cs_reasons');
CREATE TEMP TABLE ts(q) AS VALUES ('payments.settings'),('payments.merchant_accounts'),('payments.intents'),('payments.refunds'),('payments.reconciliation_runs'),('payments.reconciliation_findings'),('payments.static_qr_reconciliations'),('payments.cs_reasons');
CREATE TEMP TABLE ta_(q) AS VALUES ('payments.intent_transitions'),('payments.gateway_calls'),('payments.callbacks');

-- ===================================================================================================================================== fixtures (superuser, replica block)
-- C15 check 8: tenant A: settings, merchants 6001 (khalti) / 6002 (esewa), intents 6101 created, 6102 settled esewa, 6103 initiated, 6104 held_for_review, 6105 failed esewa, 6106 settled khalti, 6108 settled khalti (31 days old); orders 2301-2304, 2306-2309;
-- refunds 6301 pending_approval (on 6102), 6302 requested (on 6106); runs 6401 completed / 6402 running; finding 6501; static_qr 6601 (centre a201) / 6602 (all centres); cs_reasons 7501; logs 6201 / 6211 / 6221.
-- tenant B: settings, merchant 6003, intent 6107 created (order 2305), refund 6304, run 6403 running, finding 6502, static_qr 6603, cs_reasons 7502, logs 6202 / 6212 / 6222.
SET LOCAL session_replication_role = replica;
SELECT pg_temp.ins('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'patient_code', 'P-' || r.n, 'full_name', 'Test Patient ' || r.n, 'name_search', 'test patient ' || r.n, 'sex', 'female', 'registered_centre_id', pg_temp.id(r.c)))
  FROM (VALUES (2201, pg_temp.ta(), '00000000a201'), (2202, pg_temp.tb(), '00000000b201')) r(n, t, c);
SELECT pg_temp.ins('frontdesk.orders', jsonb_build_object('id', pg_temp.uid(o.n), 'tenant_id', o.t, 'branch_id', pg_temp.id(o.br), 'centre_id', pg_temp.id(o.c), 'patient_id', pg_temp.uid(o.p), 'registration_no', 'R-' || o.n, 'status', 'registered', 'visit_type', 'opd', 'billing_mode', 'cash',
    'priority', 'routine', 'collection_mode', 'walk_in', 'source', 'front_desk', 'is_first_order_of_patient', true, 'catalog_revision', 1, 'registered_at', now()))
  FROM (VALUES (2301, pg_temp.ta(), '00000000a101', '00000000a201', 2201), (2302, pg_temp.ta(), '00000000a101', '00000000a201', 2201), (2303, pg_temp.ta(), '00000000a101', '00000000a201', 2201), (2304, pg_temp.ta(), '00000000a101', '00000000a201', 2201),
    (2305, pg_temp.tb(), '00000000b101', '00000000b201', 2202), (2306, pg_temp.ta(), '00000000a101', '00000000a201', 2201), (2307, pg_temp.ta(), '00000000a101', '00000000a201', 2201), (2308, pg_temp.ta(), '00000000a101', '00000000a201', 2201),
    (2309, pg_temp.ta(), '00000000a101', '00000000a201', 2201)) o(n, t, br, c, p);
SELECT pg_temp.ins('payments.settings', jsonb_build_object('tenant_id', t)) FROM (VALUES (pg_temp.ta()), (pg_temp.tb())) v(t);
SELECT pg_temp.ins('payments.merchant_accounts', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'gateway', r.g, 'environment', 'uat'))
  FROM (VALUES (6001, pg_temp.ta(), 'khalti'), (6002, pg_temp.ta(), 'esewa'), (6003, pg_temp.tb(), 'khalti')) r(n, t, g);
SELECT pg_temp.ins('payments.intents', i) FROM (VALUES
  (pg_temp.ib(6101, pg_temp.ta(), 2301, 'khalti', 'created')), (pg_temp.ib(6102, pg_temp.ta(), 2302, 'esewa', 'settled')), (pg_temp.ib(6103, pg_temp.ta(), 2303, 'khalti', 'initiated')), (pg_temp.ib(6104, pg_temp.ta(), 2304, 'khalti', 'held_for_review')),
  (pg_temp.ib(6105, pg_temp.ta(), 2306, 'esewa', 'failed')), (pg_temp.ib(6106, pg_temp.ta(), 2307, 'khalti', 'settled')), (pg_temp.ib(6107, pg_temp.tb(), 2305, 'khalti', 'created')),
  (pg_temp.ib(6108, pg_temp.ta(), 2308, 'khalti', 'settled', jsonb_build_object('created_at', now() - interval '31 days')))) v(i);
SELECT pg_temp.ins('payments.intent_transitions', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'intent_id', pg_temp.uid(r.i), 'to_status', 'created', 'cause', 'create', 'actor_type', 'system'))
  FROM (VALUES (6201, pg_temp.ta(), 6101), (6202, pg_temp.tb(), 6107)) r(n, t, i);
SELECT pg_temp.ins('payments.refunds', rr) FROM (VALUES
  (pg_temp.rb(6301, pg_temp.ta(), 6102, 2302, 'esewa', 'manual', 'pending_approval')), (pg_temp.rb(6302, pg_temp.ta(), 6106, 2307, 'khalti', 'api', 'requested')), (pg_temp.rb(6304, pg_temp.tb(), 6107, 2305, 'khalti', 'manual', 'pending_approval'))) v(rr);
SELECT pg_temp.ins('payments.gateway_calls', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'intent_id', pg_temp.uid(r.i), 'merchant_account_id', pg_temp.uid(r.mu), 'gateway', 'khalti', 'operation', 'khalti_initiate', 'outcome', 'answer', 'duration_ms', 12))
  FROM (VALUES (6211, pg_temp.ta(), 6101, 6001), (6212, pg_temp.tb(), 6107, 6003)) r(n, t, i, mu);
SELECT pg_temp.ins('payments.callbacks', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'intent_id', pg_temp.uid(r.i), 'gateway', 'khalti', 'kind', 'khalti_return', 'outcome_code', 'ok'))
  FROM (VALUES (6221, pg_temp.ta(), 6103), (6222, pg_temp.tb(), 6107)) r(n, t, i);
SELECT pg_temp.ins('payments.reconciliation_runs', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'business_date', current_date - r.d, 'trigger', 'cron', 'status', r.st, 'started_at', now()) || r.x)
  FROM (VALUES (6401, pg_temp.ta(), 1, 'completed', jsonb_build_object('finished_at', now())), (6402, pg_temp.ta(), 0, 'running', '{}'::jsonb), (6403, pg_temp.tb(), 0, 'running', '{}'::jsonb)) r(n, t, d, st, x);
SELECT pg_temp.ins('payments.reconciliation_findings', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'run_id', pg_temp.uid(r.ru), 'intent_id', pg_temp.uid(r.i), 'kind', 'still_held', 'severity', 'warning'))
  FROM (VALUES (6501, pg_temp.ta(), 6401, 6104), (6502, pg_temp.tb(), 6403, 6107)) r(n, t, ru, i);
SELECT pg_temp.ins('payments.static_qr_reconciliations', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'business_date', current_date - 3, 'system_entries', 1, 'system_total_paisa', 1000, 'statement_total_paisa', 1000,
    'statement_reference', 'S-' || r.n, 'status', 'matched', 'reconciled_by', pg_temp.sys()) || r.x)
  FROM (VALUES (6601, pg_temp.ta(), jsonb_build_object('centre_id', pg_temp.id('00000000a201'))), (6602, pg_temp.ta(), '{}'::jsonb), (6603, pg_temp.tb(), jsonb_build_object('centre_id', pg_temp.id('00000000b201')))) r(n, t, x);
SELECT pg_temp.ins('payments.cs_reasons', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'set_name', 'hold_reasons', 'code', 'amount_mismatch', 'display', 'Amount mismatch (tenant label)'))
  FROM (VALUES (7501, pg_temp.ta()), (7502, pg_temp.tb())) r(n, t);
SET LOCAL session_replication_role = origin;      -- back to normal: triggers and FKs are live for every assertion below

SELECT is((SELECT count(*)::int FROM payments.intents), 8, 'C15 check 8: 8 intent fixtures (7 tenant A, 1 tenant B)');
SELECT is((SELECT count(*)::int FROM payments.refunds), 3, 'C15 check 8: 3 refund fixtures');
SELECT is((SELECT count(*)::int FROM payments.g_cs_reasons), 55, 'C15 check 8: 55 global coded-set rows seeded (§5)');

-- ===================================================================================================================================== read-only checks first
-- C15 test 1: tenant isolation (AC-0B-3.1 / 3.2 / 3.3 / 3.5; §10 test 1) - reads
SELECT is(pg_temp.sa('SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || pg_temp.q(pg_temp.tb()), 'n'), 'n=0', 'C15 test 1 / AC-0B-3.1: tenant A system actor sees 0 tenant B rows of ' || q) FROM tt;
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || pg_temp.q(pg_temp.tb()), 'n'), 'n=0', 'C15 test 1 / AC-0B-3.1: tenant A staff user sees 0 tenant B rows of ' || q) FROM tt;
SELECT is(pg_temp.sb('SELECT 1 FROM ' || q || ' WHERE tenant_id = ' || pg_temp.q(pg_temp.ta()), 'n'), 'n=0', 'C15 test 1 / AC-0B-3.1: tenant B system actor sees 0 tenant A rows of ' || q) FROM tt;
SELECT is(pg_temp.sa('SELECT 1 FROM ' || q, 'n') ~ '^n=[1-9]', true, 'C15 test 1: tenant A system actor sees its own rows of ' || q) FROM tt;
SELECT is(pg_temp.sb('SELECT 1 FROM ' || q, 'n') ~ '^n=[1-9]', true, 'C15 test 1: tenant B system actor sees its own rows of ' || q) FROM tt;
SELECT is(pg_temp.sa('SELECT 1 FROM payments.intents', 'n'), 'n=7', 'C15 test 1: tenant A sees exactly its 7 intents');
SELECT is(pg_temp.sb('SELECT 1 FROM payments.intents', 'n'), 'n=1', 'C15 test 1: tenant B sees exactly its intent');
SELECT is(pg_temp.sa('SELECT 1 FROM payments.merchant_accounts', 'n'), 'n=2', 'C15 test 1: tenant A sees exactly its 2 merchant accounts');
SELECT is(pg_temp.sb('SELECT 1 FROM payments.refunds', 'n'), 'n=1', 'C15 test 1: tenant B sees exactly its refund');
SELECT is(pg_temp.sa('SELECT 1 FROM payments.g_cs_reasons', 'n'), 'n=55', 'C15 test 1 / AC-0B-3.5: the global coded set is readable by every tenant (55 rows)');
SELECT is(pg_temp.sb('SELECT 1 FROM payments.g_cs_reasons', 'n'), 'n=55', 'C15 test 1 / AC-0B-3.5: tenant B reads the global coded set');
-- AC-0B-3.4: payments policies carry no centre clause (§3), so a centre-restricted staff user sees the same tenant rows as a hub user (centre authorisation is the API's assertRole)
SELECT is(pg_temp.ua(pg_temp.m('a50a'), 'SELECT 1 FROM ' || q, 'n'), pg_temp.ua(pg_temp.m('a500'), 'SELECT 1 FROM ' || q, 'n'), 'C15 test 1 / AC-0B-3.4 (tenant scope by design, §3): centre-restricted staff sees what hub staff sees of ' || q) FROM tt;

-- C15 test 1 (no DELETE privilege; AC-0B-4.2)
SELECT is(has_table_privilege('lims_app', q, 'DELETE'), false, 'C15 test 1 / AC-0B-4.2: lims_app has no DELETE on ' || q) FROM (SELECT q FROM tt UNION ALL SELECT q FROM tg) x(q);
SELECT matches(pg_temp.sa('DELETE FROM ' || q), '^E42501\|', 'C15 test 1 / AC-0B-4.2: DELETE by the system actor is refused on ' || q) FROM (SELECT q FROM tt UNION ALL SELECT q FROM tg) x(q);
SELECT matches(pg_temp.ua(pg_temp.m('a500'), 'DELETE FROM ' || q), '^E42501\|', 'C15 test 1 / AC-0B-4.2: DELETE by a staff user is refused on ' || q) FROM tt;
SELECT matches(pg_temp.sa('UPDATE ' || q || ' SET created_by = created_by'), '^E42501\|', 'C15 test 1 / AC-0B-4.1 / 4.3: no UPDATE grant on the append-only class-A table ' || q) FROM ta_;
SELECT matches(pg_temp.sa('INSERT INTO payments.g_cs_reasons (id, set_name, code, display) VALUES (' || pg_temp.u(9999) || ', ''hold_reasons'', ''x_test'', ''X'')'), '^E42501\|', 'C15 test 1: the global coded set is not writable by lims_app');
SELECT matches(pg_temp.sa('UPDATE payments.g_cs_reasons SET is_active = false'), '^E42501\|', 'C15 test 1: the global coded set is not updatable by lims_app');

-- C15 test 2 (reads): staff-actor guard (AC-0B-3.6, 08 A17 P-16): partner, portal, patient (and device) claims of the same tenant read 0 rows of every payments tenant table; user and system see their rows
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'C15 test 2 / AC-0B-3.6: ' || k.t || ' actor sees 0 rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('partner'),('portal'),('patient'),('device')) k(t);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'SELECT 1 FROM ' || tt.q, 'n') ~ '^n=[1-9]', true, 'C15 test 2: ' || k.t || ' actor sees its rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('user'),('system')) k(t);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'UPDATE payments.merchant_accounts SET updated_by = updated_by'), 'n=0', 'C15 test 2 / AC-0B-3.6: a ' || k.t || ' actor updates 0 merchant accounts') FROM (VALUES ('partner'),('portal'),('patient'),('device')) k(t);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'SELECT 1 FROM ' || tg.q, 'n'), 'n=55', 'C15 test 2 / AC-0B-3.5: global coded set stays readable for a ' || k.t || ' claim (no tenant data)') FROM tg CROSS JOIN (VALUES ('partner'),('portal'),('patient')) k(t);
-- AC-0B-3.7: no claims / empty claims fail closed
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C15 test 2 / AC-0B-3.7: no claims -> lims_api sees 0 rows of ' || q) FROM tt;
SELECT is(pg_temp.x('lims_api', '{}'::jsonb, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C15 test 2 / AC-0B-3.7: empty claims -> 0 rows of ' || q) FROM tt;

-- C15 test 11 (A12.7 a): the DEFINER lookup returns exactly the live intent of the presented hash; old token, 31-byte input, 33-byte input, NULL and an unknown hash return nothing; lims_app cannot execute it
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT tenant_id::text || ''|'' || intent_id::text FROM app.payments_resolve_callback_token(sha256(convert_to(''syn-token-6103'', ''UTF8'')))', 's'), pg_temp.ta()::text || '|' || pg_temp.uid(6103)::text, 'C15 test 11 / A12.7 (a): the live token of intent 6103 resolves to exactly (tenant A, intent 6103), no tenant claims needed');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM app.payments_resolve_callback_token(sha256(convert_to(''syn-token-6103'', ''UTF8'')))', 'n'), 'n=1', 'C15 test 11: exactly one row');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT tenant_id::text || ''|'' || intent_id::text FROM app.payments_resolve_callback_token(sha256(convert_to(''syn-token-6107'', ''UTF8'')))', 's'), pg_temp.tb()::text || '|' || pg_temp.uid(6107)::text, 'C15 test 11: tenant B''s token resolves to tenant B''s intent');
SELECT is(pg_temp.x('lims_api', pg_temp.cl(pg_temp.ta(), 'system'), 'SELECT 1 FROM app.payments_resolve_callback_token(sha256(convert_to(''syn-token-6107'', ''UTF8'')))', 'n'), 'n=1', 'C15 test 11: the lookup is pre-tenant: it also resolves a token of another tenant (the callback route has no tenant claims; the API then sets the tenant context)');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM app.payments_resolve_callback_token(sha256(convert_to(''syn-token-6108'', ''UTF8'')))', 'n'), 'n=0', 'C15 test 11 / A12.7 (a): a token older than 30 days returns nothing');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM app.payments_resolve_callback_token(substring(sha256(convert_to(''syn-token-6103'', ''UTF8'')) from 1 for 31))', 'n'), 'n=0', 'C15 test 11 / A12.7 (a): a 31-byte input returns nothing');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM app.payments_resolve_callback_token(sha256(convert_to(''syn-token-6103'', ''UTF8'')) || ''\x00''::bytea)', 'n'), 'n=0', 'C15 test 11: a 33-byte input returns nothing');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM app.payments_resolve_callback_token(NULL::bytea)', 'n'), 'n=0', 'C15 test 11 / A12.7 (a): NULL returns nothing');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM app.payments_resolve_callback_token(sha256(convert_to(''syn-token-unknown'', ''UTF8'')))', 'n'), 'n=0', 'C15 test 11 / A12.7 (a): the hash of an unknown token returns nothing');
SELECT matches(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), 'SELECT 1 FROM app.payments_resolve_callback_token(sha256(convert_to(''syn-token-6103'', ''UTF8'')))', 'n'), '^E42501\|', 'C15 test 11 / P-41 (d): lims_app has no EXECUTE on the callback lookup (only lims_api)');
-- C15 test 12 (A12.7 b): a lims_api session that sets the pre-tenant GUC to a live hash itself and selects from payments.intents without tenant claims sees 0 rows (the owner policy is TO lims_owner only)
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM payments.intents', 'n', 'SELECT set_config(''app.pre_payments_callback_token_sha256'', encode(sha256(convert_to(''syn-token-6103'', ''UTF8'')), ''hex''), true)'), 'n=0', 'C15 test 12 / A12.7 (b): lims_api setting the GUC itself sees 0 intents');
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM payments.intents', 'n', 'SELECT set_config(''app.pre_payments_callback_token_sha256'', encode(sha256(convert_to(''syn-token-6103'', ''UTF8'')), ''hex''), true)'), 'n=0', 'C15 test 12 / A12.7 (b): lims_app setting the GUC itself sees 0 intents');
SELECT is(pg_temp.x('lims_api', pg_temp.cl(pg_temp.tb(), 'system'), 'SELECT 1 FROM payments.intents WHERE id = ' || pg_temp.u(6103), 'n', 'SELECT set_config(''app.pre_payments_callback_token_sha256'', encode(sha256(convert_to(''syn-token-6103'', ''UTF8'')), ''hex''), true)'), 'n=0', 'C15 test 12: tenant B claims plus tenant A''s token GUC still see 0 rows of tenant A''s intent');
-- C15 test 13 (A12.7 c): after the call the GUC is '' in the caller's transaction (also after a call that matched nothing)
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT coalesce(current_setting(''app.pre_payments_callback_token_sha256'', true), ''<null>'')', 's', 'SELECT count(*) FROM app.payments_resolve_callback_token(sha256(convert_to(''syn-token-6103'', ''UTF8'')))'), '', 'C15 test 13 / A12.7 (c): GUC reset to the empty string after a matching call');
SELECT is(pg_temp.x('lims_api', NULL, 'SELECT coalesce(current_setting(''app.pre_payments_callback_token_sha256'', true), ''<null>'')', 's', 'SELECT count(*) FROM app.payments_resolve_callback_token(sha256(convert_to(''syn-token-unknown'', ''UTF8'')))'), '', 'C15 test 13 / A12.7 (c): GUC reset to the empty string after a non-matching call');

-- ===================================================================================================================================== failing statements (no state change)
-- C15 test 1 (writes; AC-0B-3.2 / 3.3): INSERT with tenant B's tenant_id fails the policy; UPDATE of B rows affects 0 rows
SELECT matches(pg_temp.sa(pg_temp.cps(q, aid, jsonb_build_object('id', pg_temp.uid(5000 + aid), 'tenant_id', pg_temp.tb()))), '^E42501\|', 'C15 test 1 / AC-0B-3.2: tenant A claims cannot INSERT a tenant B row into ' || q) FROM tt;
SELECT is(pg_temp.sa('UPDATE ' || q || ' SET updated_by = updated_by WHERE tenant_id = ' || pg_temp.q(pg_temp.tb())), 'n=0', 'C15 test 1 / AC-0B-3.3: tenant A updates 0 tenant B rows of ' || q) FROM ts;
-- C15 test 2 (writes): every INSERT by a non-staff actor fails the policy (P-16)
SELECT matches(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), pg_temp.cps(tt.q, tt.aid, jsonb_build_object('id', pg_temp.uid(5200 + tt.aid))), 'w'), '^E42501\|', 'C15 test 2 / AC-0B-3.6: a ' || k.t || ' actor cannot INSERT into ' || tt.q)
  FROM tt CROSS JOIN (VALUES ('partner'),('portal'),('patient'),('device')) k(t);
-- C15 test 3: immutability of the non-listed intent / refund / finding / static_qr columns (AC-0B-4.1): app.enforce_mutable_columns raises P0001 immutable_row
SELECT is(pg_temp.sa('UPDATE payments.intents SET ' || c.c || ' = ' || c.v || ' WHERE id = ' || pg_temp.u(6101)), 'EP0001|immutable_row', 'C15 test 3 / AC-0B-4.1: intents.' || c.c || ' is immutable after insert')
  FROM (VALUES ('order_id', pg_temp.u(2399)), ('amount_paisa', 'amount_paisa + 1'), ('gateway', '''esewa'''), ('environment', '''production'''), ('merchant_account_id', pg_temp.u(6002)), ('idempotency_key', '''eng:changed'''), ('request_fingerprint', quote_literal(repeat('b', 64))),
    ('return_url', '''https://other.example/r'''), ('cancel_url', '''https://other.example/c'''), ('callback_token_sha256', 'sha256(''x''::bytea)'), ('created_actor_type', '''user'''), ('branch_id', pg_temp.u(2398)), ('centre_id', pg_temp.u(2397)),
    ('created_by', pg_temp.u(2396)), ('created_at', 'now() + interval ''1 day''')) c(c, v);
SELECT is(pg_temp.sa('UPDATE payments.refunds SET ' || c.c || ' = ' || c.v || ' WHERE id = ' || pg_temp.u(6301)), 'EP0001|immutable_row', 'C15 test 3 / AC-0B-4.1: refunds.' || c.c || ' is immutable after insert')
  FROM (VALUES ('amount_paisa', 'amount_paisa + 1'), ('intent_id', pg_temp.u(6106)), ('order_id', pg_temp.u(2399)), ('centre_id', pg_temp.u(2397)), ('gateway', '''khalti'''), ('mode', '''api'''), ('idempotency_key', '''refund:changed'''),
    ('reason_code', '''overpayment'''), ('reason_text', '''changed'''), ('requested_by_membership_id', pg_temp.u(2395)), ('requested_at', 'now() + interval ''1 day'''), ('created_by', pg_temp.u(2396))) c(c, v);
SELECT is(pg_temp.sa('UPDATE payments.reconciliation_findings SET ' || c.c || ' = ' || c.v || ' WHERE id = ' || pg_temp.u(6501)), 'EP0001|immutable_row', 'C15 test 3 / AC-0B-4.1: reconciliation_findings.' || c.c || ' is immutable after insert')
  FROM (VALUES ('kind', '''missed_settlement'''), ('severity', '''critical'''), ('intent_id', pg_temp.u(6101)), ('run_id', pg_temp.u(6402)), ('auto_action', '''held'''), ('our_status', '''settled''')) c(c, v);
SELECT is(pg_temp.sa('UPDATE payments.static_qr_reconciliations SET ' || c.c || ' = ' || c.v || ' WHERE id = ' || pg_temp.u(6601)), 'EP0001|immutable_row', 'C15 test 3 / AC-0B-4.1: static_qr_reconciliations.' || c.c || ' is immutable (worksheets are not edited)')
  FROM (VALUES ('statement_total_paisa', '1001'), ('system_total_paisa', '1001'), ('business_date', 'current_date'), ('statement_reference', '''changed'''), ('note', '''changed'''), ('reconciled_by', pg_temp.u(2396)), ('status', '''accepted_with_difference''')) c(c, v);
SELECT matches(pg_temp.sa('UPDATE payments.intents SET gateway_txn_ref = ''other-ref'' WHERE id = ' || pg_temp.u(6103)), '^EP0001\|immutable_row', 'C15 test 3 / §2.1 guard: gateway_txn_ref may change only from NULL');
-- C15 test 6: partial unique open-intent race (REQ-SEC-053) and the other uniques of §4
SELECT matches(pg_temp.sa(pg_temp.cps('payments.intents', 6101, jsonb_build_object('id', pg_temp.uid(5601), 'idempotency_key', 'eng:other', 'callback_token_sha256', pg_temp.tok(5601)))), '^E23505\|.*intents__tenant_id_order_id__open__p_uq', 'C15 test 6: a second OPEN intent for the same order fails (one open intent per order)');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.intents', 6106, jsonb_build_object('id', pg_temp.uid(5602), 'gateway_txn_ref', 'pidx-5602', 'callback_token_sha256', pg_temp.tok(5602)))), '^E23505\|.*intents__tenant_id_idempotency_key__uq', 'C15 test 6: the idempotency key is unique per tenant (replay)');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.intents', 6106, jsonb_build_object('id', pg_temp.uid(5603), 'idempotency_key', 'eng:5603', 'callback_token_sha256', pg_temp.tok(5603)))), '^E23505\|.*intents__tenant_id_gateway_txn__p_uq', 'C15 test 6: (tenant, gateway, gateway_txn_ref) is unique (04 P6)');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.intents', 6106, jsonb_build_object('id', pg_temp.uid(5604), 'idempotency_key', 'eng:5604', 'gateway_txn_ref', 'pidx-5604'))), '^E23505\|.*intents__callback_token_sha256__uq', 'C15 test 6: the callback token hash is unique');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.refunds', 6301, jsonb_build_object('id', pg_temp.uid(5605), 'idempotency_key', 'refund:5605'))), '^E23505\|.*refunds__tenant_id_intent_inflight__p_uq', 'C15 test 6: one refund in flight per intent');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.refunds', 6301, jsonb_build_object('id', pg_temp.uid(5606), 'status', 'rejected'))), '^E23505\|.*refunds__tenant_id_idempotency_key__uq', 'C15 test 6: refund replay key is unique per tenant');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.reconciliation_runs', 6402, jsonb_build_object('id', pg_temp.uid(5607)))), '^E23505\|.*reconciliation_runs__tenant_id_running__p_uq', 'C15 test 6: one running reconciliation run per tenant');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.static_qr_reconciliations', 6601, jsonb_build_object('id', pg_temp.uid(5608)))), '^E23505\|.*static_qr__tenant_id_date_centre__p_uq', 'C15 test 6: one worksheet per (date, centre)');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.static_qr_reconciliations', 6602, jsonb_build_object('id', pg_temp.uid(5609)))), '^E23505\|.*static_qr__tenant_id_date_all__p_uq', 'C15 test 6: one all-centres worksheet per date');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.merchant_accounts', 6001, jsonb_build_object('id', pg_temp.uid(5610)))), '^E23505\|.*merchant_accounts__slot__uq', 'C15 test 6: one merchant account per (tenant, gateway, environment)');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.cs_reasons', 7501, jsonb_build_object('id', pg_temp.uid(5611)))), '^E23505\|.*cs_reasons__tenant_set_code__uq', 'C15 test 6: one tenant override per coded-set code');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.settings', 0)), '^E23505\|.*settings__pk', 'C15 test 6: one settings row per tenant (PK tenant_id)');
-- C15 test 7: callbacks__no_mobile__ck (Khalti "mobile" never stored) and the size caps
SELECT matches(pg_temp.sa(pg_temp.cps('payments.callbacks', 6221, jsonb_build_object('id', pg_temp.uid(5701), 'query_redacted', jsonb_build_object('pidx', 'x', 'mobile', '9800000000')))), '^E23514\|.*callbacks__no_mobile__ck', 'C15 test 7: a callback row whose query_redacted holds a "mobile" key is rejected');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.callbacks', 6221, jsonb_build_object('id', pg_temp.uid(5702), 'query_redacted', jsonb_build_object('pidx', repeat('x', 7000))))), '^E23514\|.*callbacks__size__ck', 'C15 test 7: query_redacted is capped at 6144 bytes');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.gateway_calls', 6211, jsonb_build_object('id', pg_temp.uid(5703), 'response_redacted', jsonb_build_object('k', repeat('x', 3000))))), '^E23514\|.*gateway_calls__size__ck', 'C15 test 7: response_redacted is capped at 2048 bytes');
-- C15 test 8: idempotency-key grammar rejections (08 A19 P-40)
SELECT matches(pg_temp.sa(pg_temp.cps('payments.intents', 6106, jsonb_build_object('id', pg_temp.uid(5800 + k.n), 'idempotency_key', k.v, 'gateway_txn_ref', 'pidx-58' || k.n, 'callback_token_sha256', pg_temp.tok(5800 + k.n)))), '^E23514\|.*intents__idem__ck', 'C15 test 8 / P-40: intents.idempotency_key ' || k.d || ' is rejected')
  FROM (VALUES (1, repeat('a', 201), '201 characters'), (2, '', 'empty'), (3, 'a b', 'with a space'), (4, 'a/b', 'with a slash')) k(n, v, d);
SELECT matches(pg_temp.sa(pg_temp.cps('payments.refunds', 6301, jsonb_build_object('id', pg_temp.uid(5850 + k.n), 'status', 'rejected', 'idempotency_key', k.v))), '^E23514\|.*refunds__idem__ck', 'C15 test 8 / P-40: refunds.idempotency_key ' || k.d || ' is rejected')
  FROM (VALUES (1, repeat('a', 201), '201 characters'), (2, '', 'empty'), (3, 'a b', 'with a space'), (4, 'a/b', 'with a slash')) k(n, v, d);
-- C15 test 9: refunds__held__ck
SELECT matches(pg_temp.sa(pg_temp.cps('payments.refunds', 6302, jsonb_build_object('id', pg_temp.uid(5901), 'intent_id', pg_temp.uid(6105), 'idempotency_key', 'refund:5901', 'status', 'held_for_review'))), '^E23514\|.*refunds__held__ck', 'C15 test 9: held_for_review without held_reason fails');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.refunds', 6302, jsonb_build_object('id', pg_temp.uid(5902), 'intent_id', pg_temp.uid(6105), 'idempotency_key', 'refund:5902', 'status', 'held_for_review', 'held_reason', 'bogus_reason'))), '^E23514\|.*refunds__held__ck', 'C15 test 9: an unknown held_reason fails');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.refunds', 6302, jsonb_build_object('id', pg_temp.uid(5903), 'intent_id', pg_temp.uid(6105), 'idempotency_key', 'refund:5903', 'held_reason', 'bogus_reason'))), '^E23514\|.*refunds__held__ck', 'C15 test 9: an unknown held_reason fails also on a non-held refund');
-- C15 test 10: gateway_calls FKs are composite (tenant_id, id): another tenant's refund or merchant account fails
SELECT matches(pg_temp.sa(pg_temp.cps('payments.gateway_calls', 6211, jsonb_build_object('id', pg_temp.uid(6001 + 10000), 'refund_id', pg_temp.uid(6304)))), '^E23503\|.*gateway_calls__refund__fk', 'C15 test 10 / AC-0B-3.5: a row with tenant B''s refund_id fails gateway_calls__refund__fk');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.gateway_calls', 6211, jsonb_build_object('id', pg_temp.uid(16002), 'merchant_account_id', pg_temp.uid(6003)))), '^E23503\|.*gateway_calls__merchant__fk', 'C15 test 10 / AC-0B-3.5: a row with tenant B''s merchant_account_id fails gateway_calls__merchant__fk');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.gateway_calls', 6211, jsonb_build_object('id', pg_temp.uid(16003), 'intent_id', pg_temp.uid(6107)))), '^E23503\|.*gateway_calls__intent__fk', 'C15 test 10 / AC-0B-3.5: a row with tenant B''s intent_id fails gateway_calls__intent__fk');
-- composite FKs of the other tables (AC-0B-3.5; C0 §9 rule 1 / 04 D8)
SELECT matches(pg_temp.sa(pg_temp.cps('payments.intents', 6106, jsonb_build_object('id', pg_temp.uid(6001 + 11000), 'idempotency_key', 'eng:16004', 'gateway_txn_ref', 'pidx-16004', 'callback_token_sha256', pg_temp.tok(16004), 'order_id', pg_temp.uid(2305)))), '^E23503\|.*intents__order__fk', 'C15 test 10 / AC-0B-3.5: an intent cannot reference tenant B''s order');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.intents', 6106, jsonb_build_object('id', pg_temp.uid(16005), 'idempotency_key', 'eng:16005', 'gateway_txn_ref', 'pidx-16005', 'callback_token_sha256', pg_temp.tok(16005), 'merchant_account_id', pg_temp.uid(6003)))), '^E23503\|.*intents__merchant__fk', 'C15 test 10 / AC-0B-3.5: an intent cannot reference tenant B''s merchant account');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.refunds', 6301, jsonb_build_object('id', pg_temp.uid(16006), 'status', 'rejected', 'idempotency_key', 'refund:16006', 'intent_id', pg_temp.uid(6107)))), '^E23503\|.*refunds__intent__fk', 'C15 test 10 / AC-0B-3.5: a refund cannot reference tenant B''s intent');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.reconciliation_findings', 6501, jsonb_build_object('id', pg_temp.uid(16007), 'run_id', pg_temp.uid(6403)))), '^E23503\|.*reconciliation_findings__run__fk', 'C15 test 10 / AC-0B-3.5: a finding cannot reference tenant B''s run');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.cs_reasons', 7501, jsonb_build_object('id', pg_temp.uid(16008), 'code', 'no_such_code'))), '^E23503\|.*cs_reasons__set__fk', 'C15 test 10: a tenant override must shadow an existing global code');
-- money / secret CHECKs (§6): amount, Khalti minimum, settled completeness, refund bound, Fonepay off (B8), secret shape
SELECT matches(pg_temp.sa(pg_temp.cps('payments.intents', 6106, jsonb_build_object('id', pg_temp.uid(16010), 'idempotency_key', 'eng:16010', 'gateway_txn_ref', 'pidx-16010', 'callback_token_sha256', pg_temp.tok(16010), 'amount_paisa', 0, 'verified_amount_paisa', 0))), '^E23514\|.*intents__amount__ck', 'C15 test 3: amount_paisa must be > 0');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.intents', 6106, jsonb_build_object('id', pg_temp.uid(16011), 'idempotency_key', 'eng:16011', 'gateway_txn_ref', 'pidx-16011', 'callback_token_sha256', pg_temp.tok(16011), 'amount_paisa', 999, 'verified_amount_paisa', 999))), '^E23514\|.*intents__khalti_min__ck', 'C15 test 3 / 04 P4: Khalti amounts below 1000 paisa are refused');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.intents', 6106, jsonb_build_object('id', pg_temp.uid(16012), 'idempotency_key', 'eng:16012', 'gateway_txn_ref', 'pidx-16012', 'callback_token_sha256', pg_temp.tok(16012), 'ledger_entry_id', NULL))), '^E23514\|.*intents__settled__ck', 'C15 test 3: a settled intent needs its ledger entry id');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.intents', 6106, jsonb_build_object('id', pg_temp.uid(16013), 'idempotency_key', 'eng:16013', 'gateway_txn_ref', 'pidx-16013', 'callback_token_sha256', pg_temp.tok(16013), 'refunded_paisa', 2001))), '^E23514\|.*intents__refunded__ck', 'C15 test 3: refunded_paisa may not exceed the amount');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.merchant_accounts', 6001, jsonb_build_object('id', pg_temp.uid(16014), 'gateway', 'fonepay', 'environment', 'production', 'is_enabled', true))), '^E23514\|.*(fonepay_off|enabled_complete)', 'C15 test 3 / B8: Fonepay can never be enabled');
SELECT matches(pg_temp.sa(pg_temp.cps('payments.merchant_accounts', 6001, jsonb_build_object('id', pg_temp.uid(16015), 'environment', 'production', 'secret_ciphertext', '\x01', 'secret_nonce', '\x0102'))), '^E23514\|.*merchant_accounts__secret_shape__ck', 'C15 test 3 / TRD §6.9: a secret needs a 12-byte nonce, 16-byte tag, kek id and fingerprint');

-- ===================================================================================================================================== state-changing statements (each mutation is listed)
-- C15 test 3 (allowed columns): the listed mutable columns can change (intents 6101 check_count; refunds 6302 last_checked_at; findings 6501 note; static_qr 6601 is_active)
SELECT is(pg_temp.sa('UPDATE payments.intents SET check_count = check_count + 1, last_checked_at = now(), last_gateway_status_raw = ''Pending'' WHERE id = ' || pg_temp.u(6101)), 'n=1', 'C15 test 3: a listed mutable intent column changes (check_count, last_checked_at, last_gateway_status_raw)');
SELECT is(pg_temp.sa('UPDATE payments.refunds SET last_checked_at = now(), unconfirmed_run_count = 1 WHERE id = ' || pg_temp.u(6302)), 'n=1', 'C15 test 3: a listed mutable refund column changes');
SELECT is(pg_temp.sa('UPDATE payments.reconciliation_findings SET note = ''Synthetic note'' WHERE id = ' || pg_temp.u(6501)), 'n=1', 'C15 test 3: a listed mutable finding column changes');
SELECT is(pg_temp.sa('UPDATE payments.static_qr_reconciliations SET is_active = false WHERE id = ' || pg_temp.u(6601)), 'n=1', 'C15 test 3: static_qr is_active changes (the only non-audit column)');
-- C15 test 3 (one-way fields, §2.1): gateway_txn_ref / gateway_payment_url / expires_at change only from NULL (intent 6103 initiated: txn ref set, url + expiry NULL)
SELECT is(pg_temp.sa('UPDATE payments.intents SET expires_at = now() + interval ''30 minutes'', gateway_payment_url = ''https://pay.example/p1'' WHERE id = ' || pg_temp.u(6103)), 'n=1', 'C15 test 3 / §2.1: expires_at and gateway_payment_url may be set once, from NULL');
SELECT is(pg_temp.sa('UPDATE payments.intents SET expires_at = now() + interval ''60 minutes'' WHERE id = ' || pg_temp.u(6103)), 'EP0001|immutable_row', 'C15 test 3 / §2.1: expires_at may not change once set');
SELECT is(pg_temp.sa('UPDATE payments.intents SET gateway_payment_url = ''https://pay.example/p2'' WHERE id = ' || pg_temp.u(6103)), 'EP0001|immutable_row', 'C15 test 3 / §2.1: gateway_payment_url may not change once set');
-- C15 test 6 (control): after the open intent leaves the open set (6101 created -> failed), a new open intent for the same order inserts
SELECT is(pg_temp.sa('UPDATE payments.intents SET status = ''failed'', failure_reason = ''abandoned'', gateway_txn_ref = ''pidx-6101'', closed_at = now() WHERE id = ' || pg_temp.u(6101)), 'n=1', 'C15 test 6: created -> failed (open set shrinks)');
SELECT is(pg_temp.sa(pg_temp.cps('payments.intents', 6101, jsonb_build_object('id', pg_temp.uid(5620), 'status', 'created', 'failure_reason', NULL, 'gateway_txn_ref', NULL, 'closed_at', NULL, 'idempotency_key', 'eng:5620', 'callback_token_sha256', pg_temp.tok(5620)))), 'n=1', 'C15 test 6: once the first intent is closed, a new open intent for the same order inserts (race control)');
-- C15 test 7 (control): a callback row without the mobile key inserts; the class-A tables accept INSERT
SELECT is(pg_temp.sa(pg_temp.cps('payments.callbacks', 6221, jsonb_build_object('id', pg_temp.uid(5710), 'query_redacted', jsonb_build_object('pidx', 'x', 'status', 'Completed')))), 'n=1', 'C15 test 7: a callback row with allowlisted keys inserts');
-- C15 test 8 (accepted keys): 'eng:0190...', 'refund:0190...', a 200-character key and a key with a dot (08 A19 P-40)
SELECT is(pg_temp.sa(pg_temp.cps('payments.intents', 6106, jsonb_build_object('id', pg_temp.uid(5810 + k.n), 'idempotency_key', k.v, 'gateway_txn_ref', 'pidx-581' || k.n, 'callback_token_sha256', pg_temp.tok(5810 + k.n)))), 'n=1', 'C15 test 8 / P-40: intents.idempotency_key ' || k.d || ' is accepted')
  FROM (VALUES (1, 'eng:0190c900-0000-7000-8000-000000000001', 'eng:<uuid>'), (2, 'refund:0190c900-0000-7000-8000-000000000002', 'refund:<uuid>'), (3, repeat('a', 200), 'of 200 characters'), (4, 'a.b', 'with a dot')) k(n, v, d);
SELECT is(pg_temp.sa(pg_temp.cps('payments.refunds', 6301, jsonb_build_object('id', pg_temp.uid(5860 + k.n), 'status', 'rejected', 'idempotency_key', k.v))), 'n=1', 'C15 test 8 / P-40: refunds.idempotency_key ' || k.d || ' is accepted')
  FROM (VALUES (1, 'refund:0190c900-0000-7000-8000-000000000001', 'refund:<uuid>'), (2, 'eng:0190c900-0000-7000-8000-000000000002', 'eng:<uuid>'), (3, repeat('a', 200), 'of 200 characters'), (4, 'a.b', 'with a dot')) k(n, v, d);
-- C15 test 9 (control): a valid held_for_review refund (known held_reason) inserts
SELECT is(pg_temp.sa(pg_temp.cps('payments.refunds', 6302, jsonb_build_object('id', pg_temp.uid(5910), 'intent_id', pg_temp.uid(6105), 'idempotency_key', 'refund:5910', 'status', 'held_for_review', 'held_reason', 'refund_not_visible'))), 'n=1', 'C15 test 9: held_for_review with a known held_reason inserts');
-- C15 test 10 (control): the same gateway_calls insert with tenant A's own refund inserts
SELECT is(pg_temp.sa(pg_temp.cps('payments.gateway_calls', 6211, jsonb_build_object('id', pg_temp.uid(16020), 'refund_id', pg_temp.uid(6301)))), 'n=1', 'C15 test 10: a gateway call with tenant A''s own refund_id inserts');

-- C15 test 14: audit (AC-0B-5.1 / 5.2 / 5.3; CR-C15-013): a merchant_accounts UPDATE writes an audit row without any secret_* value; a refunds.status UPDATE writes exactly one audit row
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'UPDATE payments.merchant_accounts SET secret_ciphertext = ''\x0102030405'', secret_nonce = decode(repeat(''00'', 12), ''hex''), secret_auth_tag = decode(repeat(''11'', 16), ''hex''), secret_kek_id = ''kek1'', secret_fingerprint = ''abcd1234'', secret_set_at = now(), secret_set_by = ' || pg_temp.q(pg_temp.m('a500')) || ', last_test_outcome = ''reachable_key_valid'', last_test_at = now() WHERE id = ' || pg_temp.u(6001)), 'n=1', 'C15 test 14 / AC-0B-5.1: an audited class M update succeeds (credential saved)');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'payments' AND table_name = 'merchant_accounts' AND row_id = pg_temp.uid(6001) AND action = 'UPDATE'), 1, 'C15 test 14 / AC-0B-5.1: the merchant_accounts update wrote one audit_log row');
SELECT is((SELECT changed_columns @> ARRAY['secret_fingerprint', 'last_test_outcome'] FROM audit.audit_log WHERE schema_name = 'payments' AND table_name = 'merchant_accounts' AND row_id = pg_temp.uid(6001)), true, 'C15 test 14 / AC-0B-5.2: the non-secret changed columns are recorded');
SELECT is((SELECT changed_columns && ARRAY['secret_ciphertext', 'secret_nonce', 'secret_auth_tag'] FROM audit.audit_log WHERE schema_name = 'payments' AND table_name = 'merchant_accounts' AND row_id = pg_temp.uid(6001)), false, 'C15 test 14 / CR-C15-013: changed_columns names no secret column');
SELECT is((SELECT (coalesce(old_values::text, '') || coalesce(new_values::text, '')) ~ '(secret_ciphertext|secret_nonce|secret_auth_tag|0102030405)' FROM audit.audit_log WHERE schema_name = 'payments' AND table_name = 'merchant_accounts' AND row_id = pg_temp.uid(6001)), false, 'C15 test 14 / CR-C15-013: old_values / new_values hold no secret_ciphertext, secret_nonce or secret_auth_tag value');
SELECT is(pg_temp.ua(pg_temp.m('a500'), 'UPDATE payments.refunds SET status = ''approved'', approved_by_membership_id = ' || pg_temp.q(pg_temp.m('a500')) || ', approved_at = now() WHERE id = ' || pg_temp.u(6301)), 'n=1', 'C15 test 14: refunds pending_approval -> approved succeeds (R1)');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'payments' AND table_name = 'refunds' AND row_id = pg_temp.uid(6301)), 1, 'C15 test 14 / AC-0B-5.1: an UPDATE of refunds.status writes exactly one audit.audit_log row');
SELECT is((SELECT changed_columns @> ARRAY['status'] FROM audit.audit_log WHERE schema_name = 'payments' AND table_name = 'refunds' AND row_id = pg_temp.uid(6301)), true, 'C15 test 14 / AC-0B-5.2: the changed column (status) is recorded');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'payments' AND table_name IN ('intent_transitions', 'gateway_calls', 'callbacks', 'g_cs_reasons')), 0, 'C15 test 14 / AC-0B-5.3: class A and G tables are not audited (the gateway_calls / callbacks inserts above left no audit row)');

-- ===================================================================================================================================== second fixture block: transition pairs (after every count assertion above)
-- intent pairs: 9 statuses -> 72 ordered pairs of distinct statuses, 18 allowed (02-TRD §4.1 = intents_transition_guard); one fixture row per pair in status "from" (own order, token, txn ref)
CREATE TEMP TABLE sts(s) AS VALUES ('created'),('initiated'),('pending'),('settled'),('failed'),('expired'),('held_for_review'),('refunded'),('partially_refunded');
CREATE TEMP TABLE ipair AS SELECT row_number() OVER (ORDER BY a.s, b.s)::int AS n, a.s AS f, b.s AS t,
  (a.s, b.s) IN (VALUES ('created','initiated'),('created','failed'),('initiated','pending'),('initiated','settled'),('initiated','failed'),('initiated','expired'),('initiated','held_for_review'),
    ('pending','settled'),('pending','failed'),('pending','expired'),('pending','held_for_review'),('held_for_review','settled'),('held_for_review','failed'),('failed','held_for_review'),('expired','held_for_review'),
    ('settled','partially_refunded'),('settled','refunded'),('partially_refunded','refunded')) AS ok
  FROM sts a CROSS JOIN sts b WHERE a.s <> b.s;
-- refund pairs: 7 statuses -> 42 ordered pairs, 8 allowed (02-TRD §4.2 R1-R8 = refunds_transition_guard)
CREATE TEMP TABLE rsts(s) AS VALUES ('pending_approval'),('approved'),('rejected'),('requested'),('held_for_review'),('completed'),('failed');
CREATE TEMP TABLE rpair AS SELECT row_number() OVER (ORDER BY a.s, b.s)::int AS n, a.s AS f, b.s AS t,
  (a.s, b.s) IN (VALUES ('pending_approval','rejected'),('pending_approval','approved'),('approved','requested'),('requested','completed'),('requested','held_for_review'),('requested','failed'),('held_for_review','completed'),('held_for_review','failed')) AS ok
  FROM rsts a CROSS JOIN rsts b WHERE a.s <> b.s;
SELECT is((SELECT count(*)::int FROM ipair), 72, 'C15 test 4: 72 ordered intent status pairs'); SELECT is((SELECT count(*)::int FROM ipair WHERE ok), 18, 'C15 test 4: 18 allowed intent transitions');
SELECT is((SELECT count(*)::int FROM rpair), 42, 'C15 test 5: 42 ordered refund status pairs'); SELECT is((SELECT count(*)::int FROM rpair WHERE ok), 8, 'C15 test 5: 8 allowed refund transitions');
SET LOCAL session_replication_role = replica;
SELECT pg_temp.ins('payments.intents', pg_temp.ib(81000 + n, pg_temp.ta(), 82000 + n, 'khalti', f)) FROM ipair;
SELECT pg_temp.ins('payments.refunds', pg_temp.rb(83000 + n, pg_temp.ta(), 84000 + n, 82000 + n, 'khalti', 'manual', f)) FROM rpair;
SET LOCAL session_replication_role = origin;

-- C15 test 4: every allowed and every forbidden intent pair (AC-0B-4.1; §10 test 4): allowed -> one row updated; forbidden -> P0001 invalid_transition (the supporting columns of the target status are always set, so only the guard can fail)
SELECT is(pg_temp.sa('UPDATE payments.intents SET status = ' || quote_literal(t)
    || CASE WHEN f = 'created' THEN ', gateway_txn_ref = ''pidx-new-' || n || '''' ELSE '' END
    || CASE t WHEN 'settled' THEN ', settled_at = now(), ledger_entry_id = ' || pg_temp.u(900000 + n) || ', verified_amount_paisa = 2000, verification_method = ''khalti_lookup'''
              WHEN 'refunded' THEN ', refunded_paisa = 2000' WHEN 'partially_refunded' THEN ', refunded_paisa = 500'
              WHEN 'held_for_review' THEN ', hold_reason = ''amount_mismatch''' WHEN 'failed' THEN ', failure_reason = ''gateway_cancelled''' WHEN 'expired' THEN ', failure_reason = ''gateway_expired''' ELSE '' END
    || ' WHERE id = ' || pg_temp.u(81000 + n)), CASE WHEN ok THEN 'n=1' ELSE 'EP0001|invalid_transition' END,
  'C15 test 4 / AC-0B-4.1: intent ' || f || ' -> ' || t || CASE WHEN ok THEN ' is allowed' ELSE ' is forbidden (invalid_transition)' END) FROM ipair ORDER BY n;
-- C15 test 5: every allowed and every forbidden refund pair (R1-R8 + forbidden incl. held_for_review -> failed allowed, completed / failed / rejected terminal)
SELECT is(pg_temp.sa('UPDATE payments.refunds SET status = ' || quote_literal(t)
    || CASE t WHEN 'approved' THEN ', approved_by_membership_id = ' || pg_temp.q(pg_temp.m('a500')) || ', approved_at = now()'
              WHEN 'rejected' THEN ', rejected_by_membership_id = ' || pg_temp.q(pg_temp.m('a500')) || ', rejected_at = now(), reject_reason_code = ''not_eligible'''
              WHEN 'held_for_review' THEN ', held_reason = ''refund_not_visible''' WHEN 'completed' THEN ', completed_at = now(), ledger_entry_id = ' || pg_temp.u(910000 + n)
              WHEN 'failed' THEN ', failure_reason = ''refund_rejected_by_provider''' ELSE '' END
    || ' WHERE id = ' || pg_temp.u(83000 + n)), CASE WHEN ok THEN 'n=1' ELSE 'EP0001|invalid_transition' END,
  'C15 test 5 / AC-0B-4.1: refund ' || f || ' -> ' || t || CASE WHEN ok THEN ' is allowed' ELSE ' is forbidden (invalid_transition)' END) FROM rpair ORDER BY n;
SELECT is((SELECT count(*)::int FROM payments.intents i JOIN ipair p ON i.id = pg_temp.uid(81000 + p.n) WHERE i.status = p.t), 18, 'C15 test 4: exactly the 18 allowed pairs moved their row; the 54 forbidden rows keep their status');
SELECT is((SELECT count(*)::int FROM payments.refunds r JOIN rpair p ON r.id = pg_temp.uid(83000 + p.n) WHERE r.status = p.t), 8, 'C15 test 5: exactly the 8 allowed pairs moved their row; the 34 forbidden rows keep their status');

SELECT * FROM finish();
ROLLBACK;
