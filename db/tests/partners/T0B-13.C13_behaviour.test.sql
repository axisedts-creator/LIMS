-- T0B-13.C13 behaviour suite: tenant isolation, partner-org scope, receiving-centre scope, non-staff / device / patient actors and fail-closed no-claims, DELETE rules, guard triggers (guard_manifest_update, guard_line_update,
-- guard_partner_columns, guard_partner_transitions, guard_partner_users, guard_report_seen, guard_access_slip_update, check_line_parent), composite partner-consistency FKs, CHECKs, the §8 DEFINER tests, audit
-- (C13 05-SCHEMA §1-§8; AC-0B-2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3; 07-SECURITY ST6, ST7, ST9, AB11, AB12).
-- The generated per-table probes (db/tests/isolation/partners.<t>.test.sql) are the AC-0B-3.x proof for every table; this file proves what the generator cannot know (D-103 guards, owner policies, redaction, slips, counters).
-- Synthetic data only (seeds 010: tenant A 01a1a98a-...-a001 with branches a101 / a102 and centres a201 / a202, tenant B ...-b001 with b101 / b201; partner memberships a50d (member) plus two created here).
-- One rolled-back transaction. RLS is never disabled. The replica session mode is used ONLY for the order_tracking fixture (its FK to frontdesk.orders needs a C4 order) and reset right after.
-- Every assertion runs as SET LOCAL ROLE lims_app / lims_worker with claims in request.jwt.claims. Run from the repo root: pg_prove -d <db> db/tests/partners/T0B-13.C13_behaviour.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers: C13 check 8 fixtures, 9 tenant isolation + partner scope (AC-0B-3.1/3.2/3.3/3.5), 10 receiving-centre scope (AC-0B-3.4), 11 non-staff actors + no claims (AC-0B-3.6/3.7), 12 DELETE / grant rules (AC-0B-4.1/4.2/4.3),
-- 13 guard triggers + composite FKs + CHECKs (AC-0B-4.1, 3.5), 14 audit + counters + slips (AC-0B-5.1/5.2/5.3, 6.1/6.2/6.3); DEFINER test 1..4 = 05-SCHEMA §8 "DEFINER tests".
-- Order matters inside the transaction: read-only checks first, state-changing statements last.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c900-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.u(n int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal(pg_temp.uid(n)::text) $$;
CREATE FUNCTION pg_temp.s(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-00000000' || s)::uuid $$;     -- seed ids: branch a101, centre a201, membership a50d, user a30c ...
CREATE FUNCTION pg_temp.q(x uuid) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT quote_literal(x::text) $$;
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);

CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r jsonb := p_row; a text; cols text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.sys()); END IF;
  END LOOP;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  -- LD-230 (2): audit_log__insert__owner_only needs tenant_id = the claims tenant; write each row under its own tenant (as db/seeds/010 does)
  IF r ? 'tenant_id' THEN
    PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', r ->> 'tenant_id', 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);
  END IF;
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
CREATE FUNCTION pg_temp.sa(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;                       -- tenant A system actor
CREATE FUNCTION pg_temp.sb(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;                       -- tenant B system actor
CREATE FUNCTION pg_temp.ua(p_mem text, p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'user', pg_temp.s(p_mem)), p_sql, p_mode) $$;   -- tenant A staff user (membership a500 all centres, a50a not)
CREATE FUNCTION pg_temp.pa(p_mem uuid, p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner', p_mem), p_sql, p_mode) $$;      -- tenant A partner actor
-- partner memberships: P1 member = seed a50d (partner_member), P1 admin = 1031, P2 admin = 1032, spare = 1033
CREATE FUNCTION pg_temp.mem(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT CASE n WHEN 1 THEN pg_temp.s('a50d') ELSE pg_temp.uid(1030 + n - 1) END $$;    -- mem(1) member P1, mem(2) admin P1, mem(3) admin P2, mem(4) spare
CREATE FUNCTION pg_temp.lsql(p_id int, p_man int, p_partner int, p_centre text, p_no int, p_ref text DEFAULT 'NULL') RETURNS text LANGUAGE sql AS $$
  SELECT 'INSERT INTO partners.manifest_lines (id, tenant_id, partner_id, manifest_id, receiving_centre_id, line_no, state, patient_full_name, patient_sex, patient_age_years, consent_attested, consent_text_version, orderable_ids, orderables_snapshot, priority, referrer_id, created_by, updated_by) VALUES ('
  || pg_temp.u(p_id) || ',' || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.u(p_partner) || ',' || pg_temp.u(p_man) || ',' || pg_temp.q(pg_temp.s(p_centre)) || ',' || p_no
  || ', ''draft'', ''Test Patient 0042'', ''female'', 34, true, ''partner-v1'', ARRAY[' || pg_temp.u(1101) || ']::uuid[], ''[]''::jsonb, ''routine'', ' || p_ref || ',' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')' $$;

-- ===================================================================================================================================== fixtures (superuser; FKs, CHECKs and triggers all live)
-- C13 check 8: tenant A: partners P1 (1001, centre a201 / branch a101), P2 (1002, centre a202 / a102); tenant B: PB (1003). P1 users: admin (mem 2), member (a50d, status invited); P2 admin (mem 3).
-- manifests 1041 draft(P1), 1042 submitted(P1), 1043 draft(P2), 1044 draft on_submit(P1), 1045 submitted(P1), B 1046; lines 1051 (draft, 1041), 1052 (submitted, old, 1042), 1053 (draft, 1043), 1054 (draft, 1044), B 1056.
INSERT INTO catalog.credit_parties (id, tenant_id, party_code, name, kind, created_by, updated_by) VALUES
  (pg_temp.uid(1011), pg_temp.ta(), 'SYN-PARTNER-X', 'Synthetic partner X', 'partner_lab', pg_temp.sys(), pg_temp.sys()), (pg_temp.uid(1012), pg_temp.ta(), 'SYN-PARTNER-Y', 'Synthetic partner Y', 'clinic', pg_temp.sys(), pg_temp.sys()),
  (pg_temp.uid(1013), pg_temp.tb(), 'SYN-PARTNER-B', 'Synthetic partner B', 'partner_lab', pg_temp.sys(), pg_temp.sys());
SELECT pg_temp.ins('core.memberships', jsonb_build_object('id', pg_temp.mem(m), 'tenant_id', pg_temp.ta(), 'user_id', pg_temp.s(u), 'actor_type', 'partner', 'all_centres', false, 'status', 'active', 'partner_role', 'partner_admin'))
  FROM (VALUES (2, 'a30c'), (3, 'a30a'), (4, 'a309')) v(m, u);
SELECT pg_temp.ins('partners.settings', jsonb_build_object('tenant_id', t)) FROM (VALUES (pg_temp.ta()), (pg_temp.tb())) v(t);
SELECT pg_temp.ins('partners.partners', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'partner_code', r.c, 'name', 'Synthetic partner', 'credit_party_id', pg_temp.uid(r.cp), 'receiving_branch_id', pg_temp.s(r.b),
  'receiving_centre_id', pg_temp.s(r.ce), 'conversion_mode', 'on_receipt'))
  FROM (VALUES (1001, pg_temp.ta(), 'SYN-PARTNER-X', 1011, 'a101', 'a201'), (1002, pg_temp.ta(), 'SYN-PARTNER-Y', 1012, 'a102', 'a202'), (1003, pg_temp.tb(), 'SYN-PARTNER-B', 1013, 'b101', 'b201')) r(n, t, c, cp, b, ce);
SELECT pg_temp.ins('partners.partner_users', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', pg_temp.ta(), 'partner_id', pg_temp.uid(r.p), 'membership_id', pg_temp.mem(r.m), 'partner_role', r.role, 'status', r.st,
  'display_name', 'Test User', 'email_masked', 'a***@p***.invalid', 'invited_by_actor_type', 'user'))
  FROM (VALUES (1021, 1001, 2, 'partner_admin', 'active'), (1022, 1001, 1, 'partner_member', 'invited'), (1023, 1002, 3, 'partner_admin', 'active')) r(n, p, m, role, st);
SELECT pg_temp.ins('partners.partner_referrers', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', pg_temp.ta(), 'partner_id', pg_temp.uid(r.p), 'display_name', 'Dr Synthetic', 'display_name_norm', 'dr synthetic ' || r.n))
  FROM (VALUES (1081, 1001), (1082, 1002)) r(n, p);
SELECT pg_temp.ins('partners.manifests', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'partner_id', pg_temp.uid(r.p), 'manifest_no', r.no, 'state', r.st, 'receiving_branch_id', pg_temp.s(r.b), 'receiving_centre_id', pg_temp.s(r.ce),
  'conversion_mode', r.cm) || CASE WHEN r.st = 'submitted' THEN jsonb_build_object('submitted_at', now()) ELSE '{}'::jsonb END)
  FROM (VALUES (1041, pg_temp.ta(), 1001, 'MF26000001', 'draft', 'a101', 'a201', 'on_receipt'), (1042, pg_temp.ta(), 1001, 'MF26000002', 'submitted', 'a101', 'a201', 'on_receipt'), (1043, pg_temp.ta(), 1002, 'MF26000001', 'draft', 'a102', 'a202', 'on_receipt'),
    (1044, pg_temp.ta(), 1001, 'MF26000003', 'draft', 'a101', 'a201', 'on_submit'), (1045, pg_temp.ta(), 1001, 'MF26000004', 'submitted', 'a101', 'a201', 'on_receipt'), (1046, pg_temp.tb(), 1003, 'MF26000001', 'draft', 'b101', 'b201', 'on_receipt')) r(n, t, p, no, st, b, ce, cm);
INSERT INTO partners.manifest_lines (id, tenant_id, partner_id, manifest_id, receiving_centre_id, line_no, state, patient_full_name, patient_sex, patient_age_years, consent_attested, consent_text_version, orderable_ids, orderables_snapshot, priority, created_at, created_by, updated_by) VALUES
  (pg_temp.uid(1051), pg_temp.ta(), pg_temp.uid(1001), pg_temp.uid(1041), pg_temp.s('a201'), 1, 'draft', 'Test Patient 0001', 'female', 30, true, 'partner-v1', ARRAY[pg_temp.uid(1101)], '[]', 'routine', now(), pg_temp.sys(), pg_temp.sys()),
  (pg_temp.uid(1052), pg_temp.ta(), pg_temp.uid(1001), pg_temp.uid(1042), pg_temp.s('a201'), 1, 'submitted', 'Test Patient 0002', 'male', 40, true, 'partner-v1', ARRAY[pg_temp.uid(1101)], '[{"orderable_id":"x"}]', 'routine', now() - interval '6 years', pg_temp.sys(), pg_temp.sys()),
  (pg_temp.uid(1053), pg_temp.ta(), pg_temp.uid(1002), pg_temp.uid(1043), pg_temp.s('a202'), 1, 'draft', 'Test Patient 0003', 'male', 50, true, 'partner-v1', ARRAY[pg_temp.uid(1101)], '[]', 'routine', now(), pg_temp.sys(), pg_temp.sys()),
  (pg_temp.uid(1054), pg_temp.ta(), pg_temp.uid(1001), pg_temp.uid(1044), pg_temp.s('a201'), 1, 'draft', 'Test Patient 0004', 'male', 60, true, 'partner-v1', ARRAY[pg_temp.uid(1101)], '[]', 'routine', now(), pg_temp.sys(), pg_temp.sys()),
  (pg_temp.uid(1056), pg_temp.tb(), pg_temp.uid(1003), pg_temp.uid(1046), pg_temp.s('b201'), 1, 'draft', 'Test Patient 0005', 'male', 20, true, 'partner-v1', ARRAY[pg_temp.uid(1101)], '[]', 'routine', now(), pg_temp.sys(), pg_temp.sys());
SELECT pg_temp.ins('partners.pickup_requests', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', pg_temp.ta(), 'partner_id', pg_temp.uid(r.p), 'receiving_centre_id', pg_temp.s(r.ce), 'state', 'requested',
  'window_start', now() + interval '1 day', 'window_end', now() + interval '2 days', 'packages_count', 1))
  FROM (VALUES (1091, 1001, 'a201'), (1092, 1002, 'a202'), (1093, 1001, 'a201')) r(n, p, ce);
SELECT pg_temp.ins('partners.price_list_items', jsonb_build_object('tenant_id', pg_temp.ta(), 'partner_id', pg_temp.uid(r.p), 'orderable_id', pg_temp.uid(1101), 'kind', 'test', 'code', 'CBC', 'name', 'Complete blood count', 'unit_price_paisa', 15000,
  'source', 'standard', 'price_list_id', pg_temp.uid(1102), 'price_list_version', 1, 'effective_from', now(), 'synced_at', now())) FROM (VALUES (1001), (1002)) r(p);
SET LOCAL session_replication_role = replica;
SELECT pg_temp.ins('partners.order_tracking', jsonb_build_object('tenant_id', pg_temp.ta(), 'order_id', pg_temp.uid(1061), 'partner_id', pg_temp.uid(1001), 'line_id', pg_temp.uid(1052), 'manifest_id', pg_temp.uid(1042), 'receiving_centre_id', pg_temp.s('a201'),
  'tracking_status', 'registered', 'registered_at', now(), 'last_event_at', now()));
SET LOCAL session_replication_role = origin;
SELECT pg_temp.ins('partners.order_reports', jsonb_build_object('tenant_id', pg_temp.ta(), 'report_id', pg_temp.uid(1071), 'version_no', 1, 'order_id', pg_temp.uid(1061), 'partner_id', pg_temp.uid(1001), 'receiving_centre_id', pg_temp.s('a201'),
  'kind', 'final', 'released_at', now(), 'panel_names', ARRAY['CBC']));
SELECT pg_temp.ins('partners.download_counters', jsonb_build_object('tenant_id', pg_temp.ta(), 'partner_user_id', pg_temp.uid(1021), 'partner_id', pg_temp.uid(1001), 'day', d, 'count', 1, 'expires_at', e))
  FROM (VALUES (current_date - 40, now() - interval '10 days'), (current_date, now() + interval '30 days')) v(d, e);
SELECT is((SELECT count(*)::int FROM partners.partners), 3, 'C13 check 8: fixtures: 3 partners');
SELECT is((SELECT count(*)::int FROM partners.g_cs_reasons), 29, 'C13 check 8: seed: 29 coded-set rows');

-- ===================================================================================================================================== read-only checks
-- C13 check 9: tenant isolation (AC-0B-3.1, 3.2, 3.3, 3.5) and partner-org scope (PT)
SELECT is(pg_temp.sa('SELECT 1 FROM partners.partners', 'n'), 'n=2', 'C13 check 9 / AC-0B-3.1: tenant A system actor sees its 2 partners, not tenant B''s');
SELECT is(pg_temp.sb('SELECT 1 FROM partners.partners', 'n'), 'n=1', 'C13 check 9 / AC-0B-3.1: tenant B system actor sees only PB');
SELECT is(pg_temp.sa('SELECT 1 FROM partners.manifests', 'n'), 'n=5', 'C13 check 9 / AC-0B-3.2: tenant A manifests (5), none of tenant B');
SELECT is(pg_temp.sb('SELECT 1 FROM partners.manifest_lines', 'n'), 'n=1', 'C13 check 9 / AC-0B-3.2: tenant B lines (1)');
SELECT is(pg_temp.sb('INSERT INTO partners.settings (tenant_id, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')'), 'E42501|new row violates row-level security policy for table "settings"', 'C13 check 9 / AC-0B-3.3: no cross-tenant insert');
SELECT is(pg_temp.sb('UPDATE partners.manifests SET notes = ''x'' WHERE tenant_id = ' || pg_temp.q(pg_temp.ta())), 'n=0', 'C13 check 9 / AC-0B-3.3: no cross-tenant update');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'SELECT 1 FROM partners.partners', 'n'), 'n=1', 'C13 check 9 / PT: partner member sees only its own partner row');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'SELECT 1 FROM partners.manifests', 'n'), 'n=4', 'C13 check 9 / PT: partner P1 sees its 4 manifests (not P2''s)');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'SELECT 1 FROM partners.manifest_lines', 'n'), 'n=3', 'C13 check 9 / PT: partner P1 sees its 3 lines');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'SELECT 1 FROM partners.partner_users', 'n'), 'n=2', 'C13 check 9 / PT: partner P1 sees its 2 users, not P2''s admin (§8 DEFINER test 1: owner policies are TO lims_owner only)');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'SELECT 1 FROM partners.partner_users WHERE partner_id = ' || pg_temp.u(1002), 'n'), 'n=0', 'C13 check 9 / ST6: no partner_users row of another partner');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'SELECT 1 FROM partners.pickup_requests', 'n'), 'n=2', 'C13 check 9 / PT: partner P1 sees its 2 pickups');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'SELECT 1 FROM partners.price_list_items', 'n'), 'n=1', 'C13 check 9 / PT: partner P1 sees its price row only');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'SELECT 1 FROM partners.settings', 'n'), 'n=1', 'C13 check 9 / §8: partner reads the tenant settings row (consent statement)');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'SELECT 1 FROM partners.order_reports', 'n'), 'n=1', 'C13 check 9 / PT: partner sees its report row');
SELECT is(pg_temp.pa(pg_temp.mem(3), 'SELECT 1 FROM partners.order_reports', 'n'), 'n=0', 'C13 check 9 / PT: partner P2 sees no report of P1');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'SELECT 1 FROM partners.g_cs_reasons', 'n'), 'n=29', 'C13 check 9: the G table is readable (RLS-exempt)');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb(), 'partner', pg_temp.mem(1)), 'SELECT 1 FROM partners.partners', 'n'), 'n=0', 'C13 check 9 / ST6: a membership of another tenant gets no partner scope');

-- C13 check 10: receiving-centre scope (AC-0B-3.4): SC policies on manifests / lines / pickups; ST (tenant-wide) on master data
SELECT is(pg_temp.ua('a500', 'SELECT 1 FROM partners.manifests', 'n'), 'n=5', 'C13 check 10 / AC-0B-3.4: staff user with all centres (a500) sees all 5 tenant A manifests');
SELECT is(pg_temp.ua('a50a', 'SELECT 1 FROM partners.manifests', 'n'),
  'n=' || (SELECT count(*) FROM partners.manifests m WHERE m.tenant_id = pg_temp.ta() AND m.receiving_centre_id IN (SELECT centre_id FROM core.membership_centres WHERE membership_id = pg_temp.s('a50a'))),
  'C13 check 10 / AC-0B-3.4: staff user without all_centres sees only manifests of its centres (A16.1 cast)');
SELECT is(pg_temp.ua('a50a', 'SELECT 1 FROM partners.partners', 'n'), 'n=2', 'C13 check 10: partner master data is tenant-wide for staff (ST)');
SELECT is(pg_temp.ua('a50a', 'SELECT 1 FROM partners.partner_referrers', 'n'), 'n=2', 'C13 check 10: referrers are tenant-wide for staff (ST)');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'user', NULL), 'SELECT 1 FROM partners.manifests', 'n'), 'n=0', 'C13 check 10 / support session: actor user without membership sees no SC row');

-- C13 check 11: non-staff actors and fail-closed (AC-0B-3.6, 3.7)
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device'), 'SELECT 1 FROM partners.partners', 'n'), 'n=0', 'C13 check 11 / AC-0B-3.6: device actor sees no partner (positive list excludes device)');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device'), 'SELECT 1 FROM partners.manifests', 'n'), 'n=0', 'C13 check 11 / AC-0B-3.6: device actor sees no manifest');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient', pg_temp.mem(1)), 'SELECT 1 FROM partners.partners', 'n'), 'n=0', 'C13 check 11 / AC-0B-3.6: patient actor sees no partner');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'user', pg_temp.mem(1)), 'SELECT app.current_partner_id()', 's'), '<null>', 'C13 check 11 / DEFINER test 1: staff actor with a partner membership id gets no partner scope');
SELECT matches(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM partners.partners', 'n'), '^(n=0|E)', 'C13 check 11 / AC-0B-3.7: no claims -> no rows (or an error), never data');
SELECT matches(pg_temp.x('lims_app', NULL, 'INSERT INTO partners.settings (tenant_id, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')', 'w'), '^E', 'C13 check 11 / AC-0B-3.7: no claims -> no insert');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'INSERT INTO partners.settings (tenant_id, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')'), 'E42501|new row violates row-level security policy for table "settings"', 'C13 check 11: partner never writes settings (§3.8)');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.partners SET name = ''x''', 'w'), 'n=0', 'C13 check 11: partner cannot update the partner master row (staff only)');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'INSERT INTO partners.order_tracking (tenant_id, order_id, partner_id, line_id, manifest_id, receiving_centre_id, tracking_status, registered_at, last_event_at, created_by, updated_by) VALUES ('
  || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.u(1062) || ',' || pg_temp.u(1001) || ',' || pg_temp.u(1052) || ',' || pg_temp.u(1042) || ',' || pg_temp.q(pg_temp.s('a201')) || ', ''registered'', now(), now(),' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')'),
  'E42501|new row violates row-level security policy for table "order_tracking"', 'C13 check 11: projections are written by the system actor only');
SELECT is(pg_temp.ua('a500', 'UPDATE partners.order_tracking SET report_count = 1', 'w'), 'n=0', 'C13 check 11: staff user cannot update a projection');

-- C13 check 12: grants / DELETE rules (AC-0B-4.1, 4.2, 4.3; §5)
SELECT matches(pg_temp.sa('DELETE FROM partners.manifests'), '^E42501', 'C13 check 12 / AC-0B-4.2: lims_app has no DELETE on manifests (none: discard = state)');
SELECT matches(pg_temp.sa('DELETE FROM partners.partners'), '^E42501', 'C13 check 12 / AC-0B-4.2: lims_app has no DELETE on partners (deactivate)');
SELECT matches(pg_temp.sa('DELETE FROM partners.access_slips'), '^E42501', 'C13 check 12 / AC-0B-4.2: lims_app has no DELETE on access_slips');
SELECT is(pg_temp.ua('a500', 'DELETE FROM partners.manifest_lines', 'w'), 'n=0', 'C13 check 12 / AC-0B-4.2: staff cannot delete lines (no staff DELETE policy)');
SELECT is(pg_temp.sa('DELETE FROM partners.manifest_lines', 'w'), 'n=0', 'C13 check 12 / AC-0B-4.2: even the system actor cannot delete lines');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'DELETE FROM partners.manifest_lines WHERE id = ' || pg_temp.u(1052), 'w'), 'n=0', 'C13 check 12: partner cannot delete a submitted line');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'DELETE FROM partners.manifest_lines WHERE id = ' || pg_temp.u(1053), 'w'), 'n=0', 'C13 check 12: partner cannot delete another partner''s draft line');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'DELETE FROM partners.price_list_items', 'w'), 'n=0', 'C13 check 12: partner cannot delete price rows (SY only)');
SELECT is(pg_temp.ua('a500', 'DELETE FROM partners.price_list_items', 'w'), 'n=0', 'C13 check 12: staff cannot delete price rows');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'DELETE FROM partners.download_counters', 'w'), 'n=0', 'C13 check 12 / P-18(c): partner deletes no counter');
SELECT is(pg_temp.ua('a500', 'DELETE FROM partners.download_counters', 'w'), 'n=0', 'C13 check 12 / DEFINER test 3: staff (user) claims delete 0 download_counters');
SELECT is(pg_temp.sa('DELETE FROM partners.download_counters', 'w'), 'n=1', 'C13 check 12 / DEFINER test 3: the system actor deletes only the expired counter');
SELECT is((SELECT count(*)::int FROM partners.download_counters), 1, 'C13 check 12 / DEFINER test 3: the unexpired counter survives');

-- ===================================================================================================================================== state-changing checks
-- C13 check 13: guard triggers (AC-0B-4.1; 05-SCHEMA §8; D-103; ST9, AB11, AB12)
-- manifests: lifecycle guard, terminal states, partner column + transition guards
SELECT is(pg_temp.sa('UPDATE partners.manifests SET notes = ''x'' WHERE id = ' || pg_temp.u(1042)), 'EP0001|immutable_row', 'C13 check 13 / AC-0B-4.1: a submitted manifest is immutable outside the lifecycle columns');
SELECT is(pg_temp.sa('UPDATE partners.manifests SET state = ''received'', received_at = now() WHERE id = ' || pg_temp.u(1042)), 'n=1', 'C13 check 13: submitted -> received (lifecycle columns) passes');
SELECT is(pg_temp.sa('UPDATE partners.manifests SET state = ''submitted'' WHERE id = ' || pg_temp.u(1042)), 'EP0001|immutable_row', 'C13 check 13: received is terminal');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.manifests SET notes = ''partner note'' WHERE id = ' || pg_temp.u(1041)), 'n=1', 'C13 check 13 / D-103: partner edits a draft manifest (allowed column)');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.manifests SET received_at = now() WHERE id = ' || pg_temp.u(1041)), 'EP0001|immutable_row', 'C13 check 13 / AB11: partner cannot write receipt facts');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.manifests SET in_transit_at = now() WHERE id = ' || pg_temp.u(1041)), 'EP0001|immutable_row', 'C13 check 13 / AB11: partner cannot write in_transit_at');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.manifests SET state = ''received'' WHERE id = ' || pg_temp.u(1041)), 'EP0001|immutable_row', 'C13 check 13 / AB12: partner cannot move a manifest to received (transition guard)');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.manifests SET state = ''withdrawn'', withdrawn_at = now(), withdraw_reason_code = ''entered_in_error'' WHERE id = ' || pg_temp.u(1045)), 'n=1', 'C13 check 13 / D-103: partner withdraws a submitted manifest');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.manifests SET notes = ''x'' WHERE id = ' || pg_temp.u(1043)), 'n=0', 'C13 check 13: partner cannot touch another partner''s manifest (RLS hides it)');
-- manifest_lines: lifecycle guard, partner columns, converting rule (§8 DEFINER test 4), parent check
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.manifest_lines SET priority = ''urgent'' WHERE id = ' || pg_temp.u(1051)), 'n=1', 'C13 check 13 / D-103: partner edits a draft line');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.manifest_lines SET order_id = ' || pg_temp.u(1061) || ' WHERE id = ' || pg_temp.u(1051)), 'EP0001|immutable_row', 'C13 check 13 / AB11: partner cannot link an order');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.manifest_lines SET patient_full_name = ''Changed'' WHERE id = ' || pg_temp.u(1052)), 'EP0001|immutable_row', 'C13 check 13 / AC-0B-4.1: a submitted line is immutable (patient block)');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.manifest_lines SET state = ''converting'', conversion_attempt = 1 WHERE id = ' || pg_temp.u(1051)), 'EP0001|immutable_row', 'C13 check 13 / AB12 / DEFINER test 4: draft -> converting is refused for an on_receipt manifest');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.manifest_lines SET state = ''converting'', conversion_attempt = 1 WHERE id = ' || pg_temp.u(1054)), 'n=1', 'C13 check 13 / DEFINER test 4: draft -> converting passes for an on_submit manifest');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.manifest_lines SET state = ''converting'' WHERE id = ' || pg_temp.u(1051)), 'EP0001|immutable_row', 'C13 check 13 / DEFINER test 4: converting without conversion_attempt 0 -> 1 is refused');
SELECT is(pg_temp.sa('UPDATE partners.manifest_lines SET manifest_id = ' || pg_temp.u(1041) || ' WHERE id = ' || pg_temp.u(1052)), 'EP0001|immutable_row', 'C13 check 13: a line never changes manifest');
SELECT is(pg_temp.sa(pg_temp.lsql(1057, 1041, 1001, 'a202', 2)), 'E23503|manifest_line_parent_mismatch', 'C13 check 13 / AC-0B-3.5: line centre must equal the manifest''s (check_line_parent)');
SELECT is(pg_temp.sa(pg_temp.lsql(1058, 1041, 1002, 'a201', 2)), 'E23503|manifest_line_parent_mismatch', 'C13 check 13 / AC-0B-3.5: line partner must equal the manifest''s');
SELECT matches(pg_temp.sa(pg_temp.lsql(1059, 1041, 1001, 'a201', 2, pg_temp.u(1082))), '^E23503', 'C13 check 13 / ST7: a referrer of another partner is rejected by the composite FK');
SELECT is(pg_temp.sa(pg_temp.lsql(1060, 1041, 1001, 'a201', 3, pg_temp.u(1081))), 'n=1', 'C13 check 13: a referrer of the same partner is accepted (MATCH SIMPLE: NULL referrer is also allowed)');
-- partner_users guard (D-103): own invited -> active flip, admin-only writes
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.partner_users SET status = ''active'', activated_at = now() WHERE id = ' || pg_temp.u(1022)), 'n=1', 'C13 check 13 / DEFINER test 4: own invited -> active flip passes');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.partner_users SET display_name = ''Other'' WHERE id = ' || pg_temp.u(1021)), 'EP0001|immutable_row', 'C13 check 13 / DEFINER test 4: a member cannot edit another user''s row (column allowlist)');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.partner_users SET status = ''deactivated'', deactivated_at = now() WHERE id = ' || pg_temp.u(1021)), 'EP0001|immutable_row', 'C13 check 13 / DEFINER test 4: a member cannot deactivate the admin');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'INSERT INTO partners.partner_users (id, tenant_id, partner_id, membership_id, partner_role, status, display_name, email_masked, invited_by_actor_type, created_by, updated_by) VALUES ('
  || pg_temp.u(1024) || ',' || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.u(1001) || ',' || pg_temp.q(pg_temp.mem(4)) || ', ''partner_member'', ''invited'', ''Test User'', ''a***@p***.invalid'', ''partner'',' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')'),
  'EP0001|immutable_row', 'C13 check 13 / DEFINER test 4: a member cannot invite (INSERT)');
SELECT is(pg_temp.pa(pg_temp.mem(2), 'UPDATE partners.partner_users SET partner_role = ''partner_admin'' WHERE id = ' || pg_temp.u(1022)), 'n=1', 'C13 check 13 / DEFINER test 4: an active partner_admin may change a role in its own org');
SELECT is(pg_temp.pa(pg_temp.mem(2), 'UPDATE partners.partner_users SET display_name = ''Other'' WHERE id = ' || pg_temp.u(1022)), 'EP0001|immutable_row', 'C13 check 13 / DEFINER test 4: even an admin is limited to the column allowlist');
-- referrers and pickups
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.partner_referrers SET display_name = ''Dr Renamed'' WHERE id = ' || pg_temp.u(1081)), 'n=1', 'C13 check 13 / D-103: partner edits its referrer');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.partner_referrers SET mapping_state = ''rejected'', mapping_reject_reason_code = ''other'' WHERE id = ' || pg_temp.u(1081)), 'EP0001|immutable_row', 'C13 check 13 / D-103: mapping columns are staff-only');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.pickup_requests SET assignee_text = ''rider'' WHERE id = ' || pg_temp.u(1091)), 'EP0001|immutable_row', 'C13 check 13 / D-103: scheduling columns are staff-only');
SELECT is(pg_temp.sa('INSERT INTO partners.pickup_request_manifests (tenant_id, pickup_request_id, manifest_id, partner_id, receiving_centre_id, created_by, updated_by) VALUES ('
  || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.u(1091) || ',' || pg_temp.u(1043) || ',' || pg_temp.u(1001) || ',' || pg_temp.q(pg_temp.s('a201')) || ',' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')'), 'E23503|insert or update on table "pickup_request_manifests" violates foreign key constraint "pickup_request_manifests__manifest__fk"', 'C13 check 13 / ST7: a pickup link can never join two partners');
SELECT is(pg_temp.sa('INSERT INTO partners.pickup_request_manifests (tenant_id, pickup_request_id, manifest_id, partner_id, receiving_centre_id, created_by, updated_by) VALUES ('
  || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.u(1091) || ',' || pg_temp.u(1041) || ',' || pg_temp.u(1001) || ',' || pg_temp.q(pg_temp.s('a201')) || ',' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')'), 'n=1', 'C13 check 13: a same-partner pickup link is accepted');
SELECT matches(pg_temp.sa('INSERT INTO partners.pickup_request_manifests (tenant_id, pickup_request_id, manifest_id, partner_id, receiving_centre_id, created_by, updated_by) VALUES ('
  || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.u(1093) || ',' || pg_temp.u(1041) || ',' || pg_temp.u(1001) || ',' || pg_temp.q(pg_temp.s('a201')) || ',' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')'), '^E23505', 'C13 check 13 / §3.6: one open pickup per manifest');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.pickup_requests SET state = ''cancelled'', cancel_reason_code = ''no_longer_needed'' WHERE id = ' || pg_temp.u(1093)), 'n=1', 'C13 check 13 / D-103: partner cancels a requested pickup');
-- order_reports mark-seen guard
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.order_reports SET kind = ''amended'' WHERE report_id = ' || pg_temp.u(1071)), 'EP0001|immutable_row', 'C13 check 13: partner may change only the mark-seen columns of a report');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.order_reports SET is_new = false, seen_at = now(), seen_by = ' || pg_temp.q(pg_temp.uid(1022)) || ' WHERE report_id = ' || pg_temp.u(1071)), 'n=1', 'C13 check 13: partner marks a report as seen');
SELECT is(pg_temp.ua('a500', 'UPDATE partners.order_reports SET is_new = true', 'w'), 'n=0', 'C13 check 13: staff users do not write projections');
SELECT is(pg_temp.pa(pg_temp.mem(3), 'UPDATE partners.order_reports SET is_new = true', 'w'), 'n=0', 'C13 check 13 / PT: another partner cannot mark a report');
SELECT matches(pg_temp.sa('INSERT INTO partners.order_reports (tenant_id, report_id, version_no, order_id, partner_id, receiving_centre_id, kind, released_at, created_by, updated_by) VALUES ('
  || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.u(1072) || ', 1,' || pg_temp.u(1061) || ',' || pg_temp.u(1002) || ',' || pg_temp.q(pg_temp.s('a201')) || ', ''final'', now(),' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')'), '^E23503', 'C13 check 13 / ST7: a report cannot name another partner than its order tracking row');
-- CHECK constraints
SELECT matches(pg_temp.sa('INSERT INTO partners.partners (id, tenant_id, partner_code, name, credit_party_id, receiving_branch_id, receiving_centre_id, conversion_mode, created_by, updated_by) VALUES ('
  || pg_temp.u(1004) || ',' || pg_temp.q(pg_temp.ta()) || ', ''bad code'', ''x'',' || pg_temp.u(1011) || ',' || pg_temp.q(pg_temp.s('a101')) || ',' || pg_temp.q(pg_temp.s('a201')) || ', ''on_receipt'',' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')'),
  '^E23514', 'C13 check 13: partner_code format CHECK');
SELECT matches(pg_temp.sa('INSERT INTO partners.partners (id, tenant_id, partner_code, name, credit_party_id, receiving_branch_id, receiving_centre_id, conversion_mode, contact_phone_e164, created_by, updated_by) VALUES ('
  || pg_temp.u(1004) || ',' || pg_temp.q(pg_temp.ta()) || ', ''OKCODE'', ''x'',' || pg_temp.u(1011) || ',' || pg_temp.q(pg_temp.s('a101')) || ',' || pg_temp.q(pg_temp.s('a201')) || ', ''on_receipt'', ''12345'',' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')'),
  '^E23514', 'C13 check 13 / A13 P-11: E.164 phone CHECK');
SELECT matches(pg_temp.sa('UPDATE partners.manifests SET manifest_no = ''MF1'' WHERE id = ' || pg_temp.u(1041)), '^E23514', 'C13 check 13: manifest_no format CHECK');
SELECT matches(pg_temp.sa('UPDATE partners.manifest_lines SET patient_birth_on = DATE ''2000-01-01'' WHERE id = ' || pg_temp.u(1051)), '^E23514', 'C13 check 13: exactly one of birth_on / age_years unless redacted');
SELECT matches(pg_temp.sa('UPDATE partners.manifest_lines SET orderable_ids = ''{}'' WHERE id = ' || pg_temp.u(1051)), '^E23514', 'C13 check 13: 1..30 orderables');
SELECT matches(pg_temp.sa('INSERT INTO partners.price_list_items (tenant_id, partner_id, orderable_id, kind, code, name, unit_price_paisa, source, price_list_id, price_list_version, effective_from, synced_at, created_by) VALUES ('
  || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.u(1001) || ',' || pg_temp.u(1103) || ', ''test'', ''X'', ''x'', -1, ''standard'',' || pg_temp.u(1102) || ', 1, now(), now(),' || pg_temp.q(pg_temp.sys()) || ')'), '^E23514', 'C13 check 13: price >= 0');
-- price list (SY delete) and manifest counters (partner insert / update)
SELECT is(pg_temp.pa(pg_temp.mem(1), 'INSERT INTO partners.manifest_counters (tenant_id, partner_id, yy, last_seq, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.u(1001) || ', 26, 1,' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')'), 'n=1', 'C13 check 13 / Shape A: partner creates its manifest counter');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'INSERT INTO partners.manifest_counters (tenant_id, partner_id, yy, last_seq, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.u(1002) || ', 26, 1,' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')'), 'E42501|new row violates row-level security policy for table "manifest_counters"', 'C13 check 13 / PT: partner cannot create another partner''s counter');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.manifest_counters SET last_seq = 2', 'w'), 'n=1', 'C13 check 13: partner bumps its counter');
SELECT is(pg_temp.sa('DELETE FROM partners.price_list_items', 'w'), 'n=2', 'C13 check 13 / SY: the system actor replaces price rows (delete-insert)');

-- C13 check 14: counters, access slips, audit (AC-0B-5.1, 5.2, 5.3, 6.1, 6.2, 6.3)
SELECT is(pg_temp.pa(pg_temp.mem(1), 'INSERT INTO partners.download_counters (tenant_id, partner_user_id, partner_id, day, count, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.u(1022) || ',' || pg_temp.u(1001) || ', current_date, 1,'
  || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')'), 'n=1', 'C13 check 14 / REQ-SEC-100: a partner user counts its own downloads');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'INSERT INTO partners.download_counters (tenant_id, partner_user_id, partner_id, day, count, created_by, updated_by) VALUES (' || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.u(1021) || ',' || pg_temp.u(1001) || ', current_date + 1, 1,'
  || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')'), 'E42501|new row violates row-level security policy for table "download_counters"', 'C13 check 14: a partner user cannot count for a colleague (own partner_user_id only)');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'SELECT 1 FROM partners.download_counters', 'n'), 'n=1', 'C13 check 14: a partner user reads only its own counters');
-- access slips (08 A2.1)
CREATE FUNCTION pg_temp.slip(p_id int, p_state text) RETURNS text LANGUAGE sql AS $$
  SELECT 'INSERT INTO partners.access_slips (id, tenant_id, partner_id, partner_user_id, report_id, version_no, order_id, state, created_by, updated_by) VALUES (' || pg_temp.u(p_id) || ',' || pg_temp.q(pg_temp.ta()) || ',' || pg_temp.u(1001) || ',' || pg_temp.u(1022)
  || ',' || pg_temp.u(1071) || ', 1,' || pg_temp.u(1061) || ',' || quote_literal(p_state) || ',' || pg_temp.q(pg_temp.sys()) || ',' || pg_temp.q(pg_temp.sys()) || ')' $$;
SELECT is(pg_temp.pa(pg_temp.mem(1), pg_temp.slip(1201, 'requested')), 'n=1', 'C13 check 14 / 08 A2.1: a partner inserts a slip request (state requested)');
SELECT matches(pg_temp.pa(pg_temp.mem(1), pg_temp.slip(1202, 'issued')), '^E(42501|23514)', 'C13 check 14 / 08 A2.1: a partner cannot insert an issued slip');
SELECT is(pg_temp.pa(pg_temp.mem(1), 'UPDATE partners.access_slips SET state = ''failed'', failure_code = ''x.y''', 'w'), 'n=0', 'C13 check 14 / 08 A2.1: no partner UPDATE of slips');
SELECT is(pg_temp.ua('a500', 'UPDATE partners.access_slips SET state = ''failed'', failure_code = ''x.y''', 'w'), 'n=0', 'C13 check 14: staff users do not update slips');
SELECT is(pg_temp.sa('UPDATE partners.access_slips SET state = ''expired'' WHERE id = ' || pg_temp.u(1201)), 'EP0001|immutable_row', 'C13 check 14: requested -> expired is not a transition (guard_access_slip_update)');
SELECT is(pg_temp.sa('UPDATE partners.access_slips SET partner_id = ' || pg_temp.u(1002) || ' WHERE id = ' || pg_temp.u(1201)), 'EP0001|immutable_row', 'C13 check 14: slip identity columns are frozen');
SELECT is(pg_temp.sa('UPDATE partners.access_slips SET state = ''issued'', link_id = ' || pg_temp.u(1203) || ', link_expires_at = now() + interval ''1 day'', file_path = ''a/access-slips/2026/11/x.pdf'', file_sha256 = repeat(''a'', 64), file_byte_size = 1000, issued_at = now() WHERE id = ' || pg_temp.u(1201)),
  'n=1', 'C13 check 14: the system actor moves requested -> issued');
SELECT is(pg_temp.sa('UPDATE partners.access_slips SET state = ''requested'', link_id = NULL, link_expires_at = NULL, file_path = NULL, file_sha256 = NULL, file_byte_size = NULL, issued_at = NULL WHERE id = ' || pg_temp.u(1201)), 'EP0001|immutable_row', 'C13 check 14: issued -> requested is refused');
-- DEFINER test 3: download_counters__delete__tenant (system + expired only; asserted in C13 check 12)
-- DEFINER test 4: guard_partner_columns / guard_partner_users (column allowlists, own invited -> active flip, on_submit converting; asserted in C13 check 13)
-- DEFINER test 2: partners.redact_lines (owner lims_owner, EXECUTE lims_worker, maintenance GUC)
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), 'DO $d$ BEGIN PERFORM set_config(''app.maintenance'', ''partners_redact_lines'', true); UPDATE partners.manifest_lines SET patient_full_name = ''X'' WHERE id = ' || pg_temp.u(1052) || '; END $d$', 'w'),
  'EP0001|immutable_row', 'C13 DEFINER test 2(b) / A12.7: a lims_app session that sets app.maintenance itself cannot write the redaction columns of a non-draft line');
SELECT is(pg_temp.x('lims_worker', pg_temp.cl(pg_temp.tb()), 'SELECT partners.redact_lines(' || pg_temp.q(pg_temp.ta()) || ', now())', 's'), 'E42501|redaction_scope', 'C13 DEFINER test 2(d): another tenant id -> 42501 redaction_scope');
SELECT is(pg_temp.x('lims_worker', pg_temp.cl(pg_temp.ta(), 'user', pg_temp.s('a500')), 'SELECT partners.redact_lines(' || pg_temp.q(pg_temp.ta()) || ', now())', 's'), 'E42501|redaction_scope', 'C13 DEFINER test 2(d): a non-system actor -> 42501 redaction_scope');
SELECT matches(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), 'SELECT partners.redact_lines(' || pg_temp.q(pg_temp.ta()) || ', now())', 's'), '^E42501', 'C13 DEFINER test 2: lims_app has no EXECUTE on redact_lines');
SELECT is(pg_temp.x('lims_worker', pg_temp.cl(pg_temp.ta()), 'SELECT partners.redact_lines(' || pg_temp.q(pg_temp.ta()) || ', now() - interval ''5 years'')', 's'), '1', 'C13 DEFINER test 2(a): redacts exactly the one line older than the cutoff (non-zero count)');
SELECT is((SELECT is_redacted AND patient_full_name IS NULL AND patient_sex IS NULL AND patient_age_years IS NULL AND orderables_snapshot = '[]'::jsonb AND redacted_at IS NOT NULL FROM partners.manifest_lines WHERE id = pg_temp.uid(1052)), true, 'C13 DEFINER test 2(a): the patient block is nulled, snapshot emptied');
SELECT is((SELECT count(*)::int FROM partners.manifest_lines WHERE tenant_id = pg_temp.ta() AND is_redacted), 1, 'C13 DEFINER test 2(a): recent lines stay untouched');
SELECT is((SELECT panel_names IS NULL FROM partners.order_reports WHERE report_id = pg_temp.uid(1071)), true, 'C13 DEFINER test 2(a): panel_names of the redacted line''s reports are nulled');
SELECT is(coalesce(current_setting('app.maintenance', true), ''), '', 'C13 DEFINER test 2(c): app.maintenance is empty after return');
-- DEFINER test 1: app.current_partner_id() truth table (last: it changes partner / user state)
SELECT is(pg_temp.pa(pg_temp.mem(1), 'SELECT app.current_partner_id()::text', 's'), pg_temp.uid(1001)::text, 'C13 DEFINER test 1: active partner + invited/active user -> the partner id');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'system', pg_temp.mem(1)), 'SELECT app.current_partner_id()', 's'), '<null>', 'C13 DEFINER test 1: system actor -> NULL');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device', pg_temp.mem(1)), 'SELECT app.current_partner_id()', 's'), '<null>', 'C13 DEFINER test 1: device actor -> NULL');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient', pg_temp.mem(1)), 'SELECT app.current_partner_id()', 's'), '<null>', 'C13 DEFINER test 1: patient actor -> NULL');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb(), 'partner', pg_temp.mem(1)), 'SELECT app.current_partner_id()', 's'), '<null>', 'C13 DEFINER test 1: a membership of another tenant -> NULL');
UPDATE partners.partner_users SET status = 'deactivated', deactivated_at = now(), deactivate_reason_code = 'left_organisation' WHERE id = pg_temp.uid(1022);
SELECT is(pg_temp.pa(pg_temp.mem(1), 'SELECT app.current_partner_id()', 's'), '<null>', 'C13 DEFINER test 1: deactivated user -> NULL');
UPDATE partners.partners SET status = 'suspended', suspended_at = now(), suspend_reason_code = 'credit_hold' WHERE id = pg_temp.uid(1002);
SELECT is(pg_temp.pa(pg_temp.mem(3), 'SELECT app.current_partner_id()', 's'), '<null>', 'C13 DEFINER test 1: suspended partner -> NULL');
SELECT is(pg_temp.pa(pg_temp.mem(3), 'SELECT 1 FROM partners.manifests', 'n'), 'n=0', 'C13 DEFINER test 1: a suspended partner''s users see nothing');
-- audit (AC-0B-5.1 / 5.2 / 5.3)
SELECT cmp_ok((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'partners' AND table_name = 'partners'), '>=', 3, 'C13 check 14 / AC-0B-5.1: the partner inserts are audited');
SELECT cmp_ok((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'partners' AND table_name = 'manifests'), '>=', 6, 'C13 check 14 / AC-0B-5.2: manifest inserts and the partner / system updates are audited');
SELECT cmp_ok((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'partners' AND table_name = 'access_slips'), '>=', 2, 'C13 check 14 / AC-0B-5.2: the slip insert and its transition are audited');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'partners' AND table_name IN ('order_tracking','order_reports','price_list_items')), 0, 'C13 check 14 / §6: projections are not audited');
SELECT matches(pg_temp.ua('a500', 'INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_type) VALUES (' || pg_temp.q(pg_temp.uid(1301)) || ',' || pg_temp.q(pg_temp.ta()) || ', ''partners'', ''partners'', ''insert'', ''user'')'), '^E42501', 'C13 check 14 / AC-0B-5.3: lims_app cannot write audit rows directly');
-- ownership + order (AC-0B-6.1 / 6.3)
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'partners'::regnamespace AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) <> 'lims_owner'), 0, 'C13 check 14 / AC-0B-6.3: every partners table is owned by lims_owner');
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'partners'::regnamespace AND pg_get_userbyid(p.proowner) <> 'lims_owner'), 0, 'C13 check 14 / AC-0B-6.3: every partners function is owned by lims_owner');
SELECT is((SELECT count(*)::int FROM pg_constraint c JOIN pg_class f ON f.oid = c.confrelid WHERE c.conrelid::regclass::text LIKE 'partners.%' AND c.contype = 'f' AND f.relnamespace::regnamespace::text IN ('billing','reporting','lab','identity','inventory')), 0, 'C13 check 14 / AC-0B-6.2: no FK into billing / reporting / lab / identity / inventory');

SELECT * FROM finish();
ROLLBACK;
