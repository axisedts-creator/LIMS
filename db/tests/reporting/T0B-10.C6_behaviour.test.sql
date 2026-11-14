-- T0B-10.C6 behaviour suite: tenant / centre isolation, non-staff actors (portal / partner / patient), portal-session policies, mutability triggers and guards (report_versions, portal_links, deliveries,
-- portal_payment_requests, report_template_versions), append-only grants, E-table purge policies, the four lims_reporting_lookup DEFINERs (qr verify, credential resolve, provider callback, link redeem),
-- GUC isolation (08 A12.7 / A21.4), conditional audit, published views (C6 05-SCHEMA §3, §4, §6.1, §6.2, §7; AC-0B-2.4, 3.1-3.5, 3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3).
-- The generated per-table probes (db/tests/isolation/reporting.<t>.test.sql) are the AC-0B-3.x proof for every table; this file proves what the generator cannot know.
-- Synthetic data only (seeds 010: tenant A 01a1a98a-...-a001, tenant B ...-b001; branches a101/b101; centres a201/a202/b201; memberships a500/b500). One rolled-back transaction.
-- RLS is never disabled: fixtures are inserted by the superuser test session (bypasses RLS) with the core system actor's claims set so app.tg_row_audit has an audit context;
-- every assertion runs as SET LOCAL ROLE lims_app (or lims_api / lims_reporting_lookup where the test says so).
-- Run from the repo root: pg_prove -d <db> db/tests/reporting/T0B-10.C6_behaviour.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser; needs the graphile_worker schema for the callback test, as T0B-05)
-- Markers: C6 check 11 fixtures/controls + non-staff actors + no claims, 12 tenant + centre isolation and cross-tenant FK, 13 portal-session policies + mutability guards + append-only + purge,
-- 14 lookup DEFINERs + GUC isolation + audit rows + published views.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c500-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
CREATE FUNCTION pg_temp.by(h text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '\x' || repeat(h, 32) $$;          -- 32-byte bytea literal (two hex digits repeated)
CREATE FUNCTION pg_temp.hx(h text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT decode(repeat(h, 32), 'hex') $$;
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
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'system', p_centre uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', pg_temp.sys(),
    'membership_id', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a500' ELSE '01a1a98a-ac40-7000-8000-00000000b500' END::uuid)
    || CASE WHEN p_centre IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('centre_id', p_centre) END $$;
CREATE FUNCTION pg_temp.pc(p_link uuid, p_report uuid, p_stage text DEFAULT 'session', p_purpose text DEFAULT 'report', p_tenant uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', 'portal', 'tenant_id', coalesce(p_tenant, pg_temp.ta()), 'sub', p_link, 'portal_stage', p_stage, 'portal_report_id', p_report, 'portal_link_purpose', p_purpose) $$;
CREATE FUNCTION pg_temp.a(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;      -- tenant A, all centres (system)
CREATE FUNCTION pg_temp.b(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.dev(p_centre uuid, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device', p_centre), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.por(p_link uuid, p_report uuid, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.pc(p_link, p_report), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.cpb(p_tbl regclass, p_where text, p_over jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE j jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE %s', p_tbl, p_where) INTO j;
  RETURN format('INSERT INTO %1$s SELECT * FROM jsonb_populate_record(NULL::%1$s, %2$L::jsonb)', p_tbl, (j || p_over)::text);
END $f$;
-- the GUC must be empty (or unset) after a DEFINER returned
CREATE FUNCTION pg_temp.guc_empty(p_name text) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting(p_name, true), '') = '' $$;

-- ===================================================================================================================================== fixtures (superuser, system claims)
-- C6 check 11: frontdesk parents (reports.order_id / patient_id are composite FKs into frontdesk)
SELECT pg_temp.ins('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(1), 'tenant_id', pg_temp.ta(), 'patient_code', 'P-0001', 'full_name', 'Test Patient 0001', 'name_search', 'test patient 0001', 'sex', 'female', 'registered_centre_id', pg_temp.id('00000000a201')));
SELECT pg_temp.ins('frontdesk.patients', jsonb_build_object('id', pg_temp.uid(2), 'tenant_id', pg_temp.tb(), 'patient_code', 'P-0001', 'full_name', 'Test Patient 0002', 'name_search', 'test patient 0002', 'sex', 'male', 'registered_centre_id', pg_temp.id('00000000b201')));
SELECT pg_temp.ins('frontdesk.orders', jsonb_build_object('id', pg_temp.uid(o.n), 'tenant_id', o.t, 'branch_id', o.br, 'centre_id', o.c, 'patient_id', o.p, 'registration_no', 'R-' || o.n, 'status', 'registered', 'visit_type', 'opd',
    'billing_mode', 'cash', 'priority', 'routine', 'collection_mode', 'walk_in', 'source', 'front_desk', 'is_first_order_of_patient', true, 'catalog_revision', 1, 'registered_at', now()))
  FROM (VALUES (11, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a201'), pg_temp.uid(1)), (12, pg_temp.ta(), pg_temp.id('00000000a101'), pg_temp.id('00000000a202'), pg_temp.uid(1)),
               (13, pg_temp.tb(), pg_temp.id('00000000b101'), pg_temp.id('00000000b201'), pg_temp.uid(2))) o(n, t, br, c, p);
-- global message template (synthetic code) for deliveries.template_code
INSERT INTO reporting.g_message_templates (code, purpose, channels, params, default_texts) VALUES ('reporting.zz_test', 'report_ready', ARRAY['sms'], '[]'::jsonb, '{"sms": {"body": "synthetic"}}'::jsonb);
INSERT INTO reporting.g_cs_reasons (set_name, code, display) VALUES ('token_revoke_reasons', 'zz_issued_in_error', 'Synthetic global reason');
-- templates: A (published v1) and B
SELECT pg_temp.ins('reporting.report_templates', jsonb_build_object('id', pg_temp.uid(301), 'tenant_id', pg_temp.ta(), 'family', 'laboratory', 'name', 'Default (SYNTHETIC)', 'is_default', true));
SELECT pg_temp.ins('reporting.report_template_versions', jsonb_build_object('id', pg_temp.uid(302), 'tenant_id', pg_temp.ta(), 'template_id', pg_temp.uid(301), 'version_no', 1, 'status', 'published',
  'config', '{}'::jsonb, 'config_sha256', repeat('a', 64), 'published_at', now()));
SELECT pg_temp.ins('reporting.report_templates', jsonb_build_object('id', pg_temp.uid(303), 'tenant_id', pg_temp.tb(), 'family', 'laboratory', 'name', 'Default B (SYNTHETIC)', 'is_default', true));
SELECT pg_temp.ins('reporting.report_template_versions', jsonb_build_object('id', pg_temp.uid(304), 'tenant_id', pg_temp.tb(), 'template_id', pg_temp.uid(303), 'version_no', 1, 'status', 'published',
  'config', '{}'::jsonb, 'config_sha256', repeat('a', 64), 'published_at', now()));
SELECT pg_temp.ins('reporting.settings', jsonb_build_object('id', pg_temp.uid(305), 'tenant_id', pg_temp.ta()));
SELECT pg_temp.ins('reporting.settings', jsonb_build_object('id', pg_temp.uid(306), 'tenant_id', pg_temp.tb()));
SELECT pg_temp.ins('reporting.channel_accounts', jsonb_build_object('id', pg_temp.uid(371), 'tenant_id', pg_temp.ta(), 'channel', 'sms', 'provider_kind', 'recording', 'secret_ref', 'zz/secret-ref', 'callback_token_sha256', pg_temp.by('44')));
SELECT pg_temp.ins('reporting.channel_accounts', jsonb_build_object('id', pg_temp.uid(372), 'tenant_id', pg_temp.tb(), 'channel', 'sms', 'provider_kind', 'recording', 'secret_ref', 'zz/secret-ref-b', 'callback_token_sha256', pg_temp.by('55')));
-- reports: R1 (A, centre a201, order 11), R2 (A, centre a202, order 12), RB (B)
SELECT pg_temp.ins('reporting.reports', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'branch_id', r.br, 'order_id', pg_temp.uid(r.o), 'patient_id', pg_temp.uid(r.p), 'partner_id', pg_temp.uid(70), 'family', 'laboratory',
    'order_source', 'front_desk', 'registered_at', now() - interval '5 hours', 'registration_no', 'R-' || r.o, 'centre_code', 'ZZ' || r.n, 'patient_display_name', 'Test Patient'))
  FROM (VALUES (311, pg_temp.ta(), pg_temp.id('00000000a201'), pg_temp.id('00000000a101'), 11, 1), (312, pg_temp.ta(), pg_temp.id('00000000a202'), pg_temp.id('00000000a101'), 12, 1),
               (313, pg_temp.tb(), pg_temp.id('00000000b201'), pg_temp.id('00000000b101'), 13, 2)) r(n, t, c, br, o, p);
-- report versions: V1 released (R1 v1), V2 rendering (R1 v2), V3 rendered (R2 v1), VB released (RB v1)
SELECT pg_temp.ins('reporting.report_versions', jsonb_build_object('id', pg_temp.uid(v.n), 'tenant_id', v.t, 'centre_id', v.c, 'report_id', pg_temp.uid(v.r), 'order_id', pg_temp.uid(v.o), 'patient_id', pg_temp.uid(v.p),
    'partner_id', pg_temp.uid(70), 'version_no', v.vno, 'status', v.st, 'report_kind', 'final', 'completeness', 'complete', 'order_item_ids', jsonb_build_array(pg_temp.uid(21)),
    'content_fingerprint', repeat('c', 64), 'content_snapshot', '{}'::jsonb, 'content_sha256', repeat('d', 64), 'template_version_id', v.tv, 'reported_at', now()) || v.x)
  FROM (VALUES
    (321, pg_temp.ta(), pg_temp.id('00000000a201'), 311, 11, 1, 1, 'released', pg_temp.uid(302),
      jsonb_build_object('pdf_object_path', pg_temp.ta()::text || '/' || to_char(now() AT TIME ZONE 'UTC', 'YYYY/MM') || '/' || pg_temp.uid(311)::text || '-v1.pdf', 'pdf_sha256', repeat('b', 64), 'pdf_bytes', 100, 'page_count', 1,
        'released_at', now(), 'release_basis', 'paid_in_full', 'release_mode', 'manual', 'audiences', jsonb_build_array('patient'))),
    (322, pg_temp.ta(), pg_temp.id('00000000a201'), 311, 11, 1, 2, 'rendering', pg_temp.uid(302), '{}'::jsonb),
    (323, pg_temp.ta(), pg_temp.id('00000000a202'), 312, 12, 1, 1, 'rendered', pg_temp.uid(302),
      jsonb_build_object('pdf_object_path', pg_temp.ta()::text || '/' || to_char(now() AT TIME ZONE 'UTC', 'YYYY/MM') || '/' || pg_temp.uid(312)::text || '-v1.pdf', 'pdf_sha256', repeat('b', 64), 'pdf_bytes', 100, 'page_count', 1)),
    (324, pg_temp.tb(), pg_temp.id('00000000b201'), 313, 13, 2, 1, 'released', pg_temp.uid(304),
      jsonb_build_object('pdf_object_path', pg_temp.tb()::text || '/' || to_char(now() AT TIME ZONE 'UTC', 'YYYY/MM') || '/' || pg_temp.uid(313)::text || '-v1.pdf', 'pdf_sha256', repeat('b', 64), 'pdf_bytes', 100, 'page_count', 1,
        'released_at', now(), 'release_basis', 'zero_balance', 'release_mode', 'auto', 'audiences', jsonb_build_array('patient')))
  ) v(n, t, c, r, o, p, vno, st, tv, x);
SELECT pg_temp.ins('reporting.qr_tokens', jsonb_build_object('id', pg_temp.uid(331), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'report_id', pg_temp.uid(311), 'report_version_id', pg_temp.uid(321),
  'token_sha256', pg_temp.by('ab'), 'lab_name_snapshot', 'Synthetic Lab', 'patient_display_snapshot', 'T.P.', 'panel_names_snapshot', jsonb_build_array('CBC'), 'issued_at', now()));
-- portal links: L1 (R1, redeem + resolve tests), L3 (R2, portal-actor update tests), L4 (R2, staff guard tests), LB (RB)
SELECT pg_temp.ins('reporting.portal_links', jsonb_build_object('id', pg_temp.uid(l.n), 'tenant_id', l.t, 'centre_id', l.c, 'report_id', pg_temp.uid(l.r), 'bound_version_no', 1, 'channel', 'sms', 'recipient_kind', 'patient',
    'patient_display_snapshot', 'T.P.', 'token_sha256', pg_temp.by(l.h), 'destination_sha256', pg_temp.by('22'), 'expires_at', now() + interval '1 day'))
  FROM (VALUES (341, pg_temp.ta(), pg_temp.id('00000000a201'), 311, '11'), (343, pg_temp.ta(), pg_temp.id('00000000a202'), 312, '12'), (344, pg_temp.ta(), pg_temp.id('00000000a202'), 312, '13'),
               (345, pg_temp.tb(), pg_temp.id('00000000b201'), 313, '14')) l(n, t, c, r, h);
SELECT pg_temp.ins('reporting.portal_sessions', jsonb_build_object('id', pg_temp.uid(351), 'tenant_id', pg_temp.ta(), 'link_id', pg_temp.uid(341), 'report_id', pg_temp.uid(311), 'token_sha256', pg_temp.by('33'),
  'last_seen_at', now(), 'idle_expires_at', now() + interval '30 minutes', 'absolute_expires_at', now() + interval '1 hour'));
SELECT pg_temp.ins('reporting.otp_challenges', jsonb_build_object('id', pg_temp.uid(391), 'tenant_id', pg_temp.ta(), 'link_id', pg_temp.uid(341), 'channel', 'sms', 'expires_at', now() + interval '5 minutes'));
-- deliveries: D1 (A, centre a201, sms, secrets in params), D2 (A, no centre, print), D4 (A, no centre, phone_otp), DB (B)
SELECT pg_temp.ins('reporting.deliveries', jsonb_build_object('id', pg_temp.uid(d.n), 'tenant_id', d.t, 'channel', d.ch, 'purpose', d.pu, 'recipient_kind', d.rk, 'idempotency_key', 'k' || d.n, 'status', d.st) || d.x)
  FROM (VALUES
    (361, pg_temp.ta(), 'sms', 'report_ready', 'patient', 'queued', jsonb_build_object('centre_id', pg_temp.id('00000000a201'), 'template_code', 'reporting.zz_test', 'queued_at', now(), 'params', jsonb_build_object('url', 'https://x.example/t', 'otp_code', '123456', 'lab_name', 'Synthetic Lab'))),
    (362, pg_temp.ta(), 'print', 'report_ready', 'patient', 'sent', jsonb_build_object('sent_at', now())),
    (364, pg_temp.ta(), 'sms', 'otp', 'phone_otp', 'queued', jsonb_build_object('template_code', 'reporting.zz_test', 'queued_at', now(), 'destination_e164', '+9779800000001')),
    (363, pg_temp.tb(), 'sms', 'report_ready', 'patient', 'queued', jsonb_build_object('centre_id', pg_temp.id('00000000b201'), 'template_code', 'reporting.zz_test', 'queued_at', now()))
  ) d(n, t, ch, pu, rk, st, x);
SELECT pg_temp.ins('reporting.portal_payment_requests', jsonb_build_object('id', pg_temp.uid(381), 'tenant_id', pg_temp.ta(), 'link_id', pg_temp.uid(341), 'report_id', pg_temp.uid(311), 'order_id', pg_temp.uid(11), 'gateway', 'esewa',
  'expires_at', now() + interval '90 days'));
SELECT pg_temp.ins('reporting.portal_payment_requests', jsonb_build_object('id', pg_temp.uid(382), 'tenant_id', pg_temp.ta(), 'link_id', pg_temp.uid(343), 'report_id', pg_temp.uid(312), 'order_id', pg_temp.uid(12), 'gateway', 'khalti',
  'status', 'completed', 'intent_id', pg_temp.uid(900), 'amount_paisa', 1000, 'completed_at', now(), 'expires_at', now() + interval '90 days'));
SELECT pg_temp.ins('reporting.print_jobs', jsonb_build_object('id', pg_temp.uid(392), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.id('00000000a201'), 'kind', 'single', 'report_version_ids', jsonb_build_array(pg_temp.uid(321)),
  'variant', 'letterhead', 'state', 'ready', 'expires_at', now() - interval '1 hour'));
CREATE TEMP TABLE tt(q) AS VALUES ('reporting.reports'),('reporting.report_versions'),('reporting.qr_tokens'),('reporting.portal_links'),('reporting.portal_sessions'),('reporting.otp_challenges'),('reporting.deliveries'),
  ('reporting.portal_payment_requests'),('reporting.print_jobs'),('reporting.channel_accounts'),('reporting.report_templates'),('reporting.report_template_versions'),('reporting.settings');
-- positive controls: an isolation test on empty data proves nothing
SELECT is(pg_temp.a('SELECT 1 FROM reporting.reports', 'n'), 'n=2', 'C6 check 11: control: tenant A (system) sees its 2 reports');
SELECT is(pg_temp.a('SELECT 1 FROM reporting.report_versions', 'n'), 'n=3', 'C6 check 11: control: tenant A sees its 3 report versions');
SELECT is(pg_temp.a('SELECT 1 FROM reporting.deliveries', 'n'), 'n=3', 'C6 check 11: control: tenant A sees its 3 deliveries (incl. the two without a centre)');
SELECT is(pg_temp.a('SELECT 1 FROM reporting.portal_links', 'n'), 'n=3', 'C6 check 11: control: tenant A sees its 3 portal links');
SELECT is(pg_temp.b('SELECT 1 FROM reporting.reports', 'n'), 'n=1', 'C6 check 11: control: tenant B sees its 1 report');
SELECT is(pg_temp.a('SELECT 1 FROM ' || tt.q, 'n') <> 'n=0', true, 'C6 check 11: control: tenant A sees rows of ' || tt.q) FROM tt;

-- ===================================================================================================================================== C6 check 11: non-staff actors + no claims (AC-0B-3.7; CR-C13-011, 08 R3, review fix #34)
-- T0B-10.C6 ruling item 5: these helpers read Wave-2 tables (C0 05-SCHEMA:551-577, bodies compiled late per C0:400); stub them inside the test transaction (rolled back), as the spec's own check did (C6 05-SCHEMA:1209).
CREATE OR REPLACE FUNCTION app.current_partner_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION app.engagement_patient_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT '{}'::uuid[] $$;
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t), 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'C6 check 11: ' || k.t || ' (no actor link) sees 0 rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('partner'),('patient')) k(t);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal'), 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'C6 check 11: portal actor without session claims sees 0 rows of ' || tt.q) FROM tt;
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'AC-0B-3.7: no claims -> 0 rows of ' || tt.q) FROM tt;
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), $$ SELECT 1 FROM reporting.v_pub_report_release UNION ALL SELECT 1 FROM reporting.v_pub_order_report_tat UNION ALL SELECT 1 FROM reporting.v_pub_delivery_daily $$, 'n'), 'n=0',
  'C6 check 11: patient actor sees 0 rows through the published views (security_invoker)');
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM reporting.v_pub_report_release', 'n'), 'n=0', 'AC-0B-3.7: no claims -> published view empty');
SELECT is(pg_temp.x('lims_app', pg_temp.pc(pg_temp.uid(341), pg_temp.uid(311), 'otp'), 'SELECT 1 FROM reporting.reports', 'n'), 'n=0', 'C6 check 11: portal stage <> session sees no report');

-- ===================================================================================================================================== C6 check 12: tenant + centre isolation (AC-0B-3.1 .. 3.5)
-- C6 check 12: tenant + centre isolation, cross-tenant FK
SELECT is(pg_temp.a('SELECT 1 FROM ' || tt.q || ' WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 'n'), 'n=0', 'AC-0B-3.1: tenant A sees 0 tenant-B rows of ' || tt.q) FROM tt;
SELECT is(pg_temp.b('SELECT 1 FROM ' || tt.q || ' WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'AC-0B-3.1: tenant B sees 0 tenant-A rows of ' || tt.q) FROM tt;
SELECT alike(pg_temp.a(pg_temp.cpb('reporting.reports', 'id = ' || quote_literal(pg_temp.uid(313)), jsonb_build_object('id', pg_temp.uid(501), 'order_id', pg_temp.uid(13))), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert a report for B');
SELECT alike(pg_temp.a(pg_temp.cpb('reporting.deliveries', 'id = ' || quote_literal(pg_temp.uid(363)), jsonb_build_object('id', pg_temp.uid(502), 'idempotency_key', 'kx')), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert a delivery for B');
SELECT alike(pg_temp.a(pg_temp.cpb('reporting.channel_accounts', 'id = ' || quote_literal(pg_temp.uid(372)), jsonb_build_object('id', pg_temp.uid(503), 'channel', 'email')), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert a channel account for B');
SELECT is(pg_temp.a('UPDATE reporting.reports SET review_flag = ''released_item_removed'' WHERE id = ' || quote_literal(pg_temp.uid(313))), 'n=0', 'AC-0B-3.3: A updates 0 B reports');
SELECT is(pg_temp.a('UPDATE reporting.deliveries SET failure_code = ''x'' WHERE id = ' || quote_literal(pg_temp.uid(363))), 'n=0', 'AC-0B-3.3: A updates 0 B deliveries');
-- AC-0B-3.5: composite FK refuses a child pointing to the other tenant's parent
SELECT alike(pg_temp.a(pg_temp.cpb('reporting.report_versions', 'id = ' || quote_literal(pg_temp.uid(321)), jsonb_build_object('id', pg_temp.uid(504), 'report_id', pg_temp.uid(313), 'version_no', 9, 'status', 'rendering',
  'pdf_object_path', NULL, 'pdf_sha256', NULL, 'pdf_bytes', NULL, 'page_count', NULL, 'released_at', NULL, 'release_basis', NULL, 'release_mode', NULL, 'audiences', NULL)), 'w'), 'E23503|%', 'AC-0B-3.5: A version pointing at B''s report -> composite FK violation');
SELECT alike(pg_temp.a(pg_temp.cpb('reporting.portal_links', 'id = ' || quote_literal(pg_temp.uid(341)), jsonb_build_object('id', pg_temp.uid(505), 'report_id', pg_temp.uid(313), 'token_sha256', pg_temp.by('77'))), 'w'), 'E23503|%',
  'AC-0B-3.5: A portal link pointing at B''s report -> composite FK violation');
-- centre scope (AC-0B-3.4)
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM reporting.reports'), 'n=1', 'C6 check 12 / AC-0B-3.4: centre a201 actor sees R1 only');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM reporting.reports'), 'n=1', 'C6 check 12: centre a202 actor sees R2 only');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM reporting.reports WHERE id = ' || quote_literal(pg_temp.uid(311))), 'n=0', 'AC-0B-3.4: a202 actor does not see the a201 report');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM reporting.report_versions'), 'n=2', 'C6 check 12: a201 actor sees V1 + V2');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM reporting.report_versions'), 'n=1', 'C6 check 12: a202 actor sees V3');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM reporting.qr_tokens'), 'n=1', 'a201 actor sees the QR token of its centre');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM reporting.qr_tokens'), 'n=0', 'a202 actor sees no QR token of a201');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM reporting.deliveries'), 'n=1', 'C6 check 12: deliveries: a centre actor sees only deliveries of its centre (centre_id IS NOT NULL AND ...), never the NULL-centre ones');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM reporting.deliveries WHERE centre_id IS NULL'), 'n=0', 'C6 check 12: NULL-centre deliveries are system-only');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM reporting.print_jobs'), 'n=1', 'print_jobs follow centre_id');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM reporting.print_jobs'), 'n=0', 'print_jobs of a201 invisible at a202');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM reporting.settings'), 'n=1', 'tenant-scoped (T) tables are visible to a centre-scoped staff actor');
SELECT is(pg_temp.dev(pg_temp.id('00000000b201'), 'SELECT 1 FROM reporting.reports'), 'n=0', 'a tenant-A device claim for a B centre sees nothing');
SELECT alike(pg_temp.dev(pg_temp.id('00000000a201'), pg_temp.cpb('reporting.reports', 'id = ' || quote_literal(pg_temp.uid(312)), jsonb_build_object('id', pg_temp.uid(506), 'order_id', pg_temp.uid(11), 'family', 'narrative')), 'w'), 'E42501|%',
  'AC-0B-3.4: a201 actor cannot insert a report for centre a202');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'UPDATE reporting.reports SET review_flag = ''released_item_removed'' WHERE id = ' || quote_literal(pg_temp.uid(312)), 'w'), 'n=0', 'a201 actor updates 0 reports of a202');
SELECT unalike(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM ' || tt.q), 'E%', 'AC-0B-3.4 / A16.1: centre-scoped SELECT on ' || tt.q || ' raises no operator error') FROM tt;

-- ===================================================================================================================================== C6 check 13: portal-session policies (08 A21.1)
-- C6 check 13: portal-session policies, mutability guards, append-only, purge
SELECT is(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), 'SELECT 1 FROM reporting.reports'), 'n=1', 'C6 check 13: portal session of L1 sees its report');
SELECT is(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), 'SELECT 1 FROM reporting.reports WHERE id = ' || quote_literal(pg_temp.uid(312))), 'n=0', 'C6 check 13: portal session sees no other report');
SELECT is(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), 'SELECT 1 FROM reporting.report_versions'), 'n=1', 'C6 check 13: portal session sees only the released / superseded version (not the rendering V2)');
SELECT is(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), 'SELECT 1 FROM reporting.qr_tokens'), 'n=1', 'portal session sees the QR token of its report');
SELECT is(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), 'SELECT 1 FROM reporting.portal_links'), 'n=1', 'portal session sees its own link only');
SELECT is(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), 'SELECT 1 FROM reporting.otp_challenges'), 'n=1', 'portal session sees its own OTP challenge');
SELECT is(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), 'SELECT 1 FROM reporting.portal_sessions'), 'n=1', 'portal session sees its own session row');
SELECT is(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), 'SELECT 1 FROM reporting.portal_payment_requests'), 'n=1', 'portal session sees its own payment request');
SELECT is(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), 'SELECT 1 FROM reporting.settings'), 'n=1', 'portal session reads the tenant settings (portal_payment_gateways, A11.1)');
SELECT is(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), 'SELECT 1 FROM reporting.deliveries'), 'n=0', 'portal session sees no delivery');
SELECT is(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), 'SELECT 1 FROM reporting.channel_accounts'), 'n=0', 'portal session sees no channel account (secret references)');
SELECT is(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), 'SELECT 1 FROM reporting.print_jobs UNION ALL SELECT 1 FROM reporting.report_templates'), 'n=0', 'portal session sees no print job / template');
SELECT is(pg_temp.x('lims_app', pg_temp.pc(pg_temp.uid(341), pg_temp.uid(311), 'session', 'dues'), 'SELECT 1 FROM reporting.report_versions UNION ALL SELECT 1 FROM reporting.qr_tokens', 'n'), 'n=0',
  'C6 check 13 / A21.1: a dues-purpose session sees no report content (versions, QR tokens)');
SELECT is(pg_temp.x('lims_app', pg_temp.pc(pg_temp.uid(341), pg_temp.uid(311), 'session', 'dues'), 'SELECT 1 FROM reporting.reports', 'n'), 'n=1', 'a dues-purpose session still sees the report shell (dues page)');
SELECT is(pg_temp.x('lims_app', pg_temp.pc(pg_temp.uid(341), pg_temp.uid(311), 'session', 'report', pg_temp.tb()), 'SELECT 1 FROM reporting.reports', 'n'), 'n=0', 'a portal claim carrying tenant B with an A link sees nothing');
SELECT is(pg_temp.por(pg_temp.uid(345), pg_temp.uid(313), 'SELECT 1 FROM reporting.reports'), 'n=0', 'a tenant-A portal claim with a B link / report sees nothing');
SELECT alike(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), format($$ INSERT INTO reporting.portal_payment_requests (id, tenant_id, link_id, report_id, order_id, gateway, expires_at, created_by, updated_by)
  VALUES (%L, %L, %L, %L, %L, 'esewa', now() + interval '1 day', %L, %L) $$, pg_temp.uid(507), pg_temp.ta(), pg_temp.uid(341), pg_temp.uid(311), pg_temp.uid(12), pg_temp.sys(), pg_temp.sys()), 'w'), 'E42501|%',
  'C6 check 13: portal payment request for an order that is not the report''s order is refused by WITH CHECK');
SELECT is(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), 'UPDATE reporting.portal_payment_requests SET failure_code = ''x'' WHERE id = ' || quote_literal(pg_temp.uid(381)), 'w'), 'n=0', 'the portal never updates payment requests');
SELECT is(pg_temp.por(pg_temp.uid(341), pg_temp.uid(311), 'DELETE FROM reporting.portal_payment_requests', 'w'), 'n=0', 'portal deletes 0 payment requests (no portal DELETE policy; purge is system only)');
-- portal actor on L3 (R2): only its own counters may change (review fix #35)
SELECT is(pg_temp.por(pg_temp.uid(343), pg_temp.uid(312), 'UPDATE reporting.portal_links SET use_count = use_count + 1, last_used_at = now(), version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(343)), 'w'), 'n=1',
  'C6 check 13: portal actor may bump use_count / last_used_at of its own link');
SELECT alike(pg_temp.por(pg_temp.uid(343), pg_temp.uid(312), 'UPDATE reporting.portal_links SET revoked_at = now() WHERE id = ' || quote_literal(pg_temp.uid(343)), 'w'), 'EP0001|immutable_row%', 'C6 check 13 / AC-0B-4.1: portal actor cannot revoke a link (portal guard)');
SELECT alike(pg_temp.por(pg_temp.uid(343), pg_temp.uid(312), 'UPDATE reporting.portal_links SET redeem_failures = 1 WHERE id = ' || quote_literal(pg_temp.uid(343)), 'w'), 'EP0001|immutable_row%', 'C6 check 13: portal actor cannot touch redeem_failures');
SELECT alike(pg_temp.por(pg_temp.uid(343), pg_temp.uid(312), 'UPDATE reporting.portal_links SET expires_at = now() + interval ''80 days'' WHERE id = ' || quote_literal(pg_temp.uid(343)), 'w'), 'EP0001|immutable_row%', 'C6 check 13: expires_at is not in the mutable list');
SELECT is(pg_temp.por(pg_temp.uid(343), pg_temp.uid(312), 'UPDATE reporting.portal_links SET use_count = use_count + 1 WHERE id = ' || quote_literal(pg_temp.uid(344)), 'w'), 'n=0', 'portal actor updates 0 rows of another link');
SELECT alike(pg_temp.por(pg_temp.uid(343), pg_temp.uid(312), 'DELETE FROM reporting.portal_links', 'w'), 'E42501|%', 'AC-0B-4.2: no DELETE on portal_links');

-- ===================================================================================================================================== C6 check 13: mutability (AC-0B-4.1; §3) — staff / system actor
SELECT alike(pg_temp.a('UPDATE reporting.report_versions SET content_sha256 = repeat(''e'', 64) WHERE id = ' || quote_literal(pg_temp.uid(322))), 'EP0001|immutable_row%', 'C6 check 13 / AC-0B-4.1: report_versions.content_sha256 frozen');
SELECT alike(pg_temp.a('UPDATE reporting.report_versions SET content_snapshot = ''{"x":1}'' WHERE id = ' || quote_literal(pg_temp.uid(322))), 'EP0001|immutable_row%', 'report_versions.content_snapshot frozen');
SELECT alike(pg_temp.a('UPDATE reporting.report_versions SET report_id = ' || quote_literal(pg_temp.uid(312)) || ' WHERE id = ' || quote_literal(pg_temp.uid(322))), 'EP0001|immutable_row%', 'report_versions.report_id frozen');
SELECT alike(pg_temp.a('UPDATE reporting.report_versions SET smart_summary_json = ''{}'', smart_summary_id = ' || quote_literal(pg_temp.uid(902)) || ', smart_summary_version = ''v1'' WHERE id = ' || quote_literal(pg_temp.uid(322))), 'EP0001|immutable_row%',
  'smart summary snapshot is set at insert only (not in the mutable-column list)');
SELECT alike(pg_temp.a('UPDATE reporting.report_versions SET status = ''released'', released_at = now(), release_basis = ''paid_in_full'', release_mode = ''manual'', audiences = ARRAY[''patient''] WHERE id = ' || quote_literal(pg_temp.uid(322))), 'EP0001|immutable_row%',
  'C6 check 13: status rendering -> released is not a legal transition (03-APP-FLOW §1.2)');
SELECT alike(pg_temp.a('UPDATE reporting.report_versions SET status = ''rendered'' WHERE id = ' || quote_literal(pg_temp.uid(322))), 'E23514|%report_versions__pdf_present__ck%', 'rendered without PDF fields -> CHECK report_versions__pdf_present__ck');
SELECT alike(pg_temp.a('UPDATE reporting.report_versions SET status = ''rendered'' WHERE id = ' || quote_literal(pg_temp.uid(321))), 'EP0001|immutable_row%', 'C6 check 13: released -> rendered is illegal');
SELECT alike(pg_temp.a('UPDATE reporting.report_versions SET pdf_sha256 = repeat(''f'', 64) WHERE id = ' || quote_literal(pg_temp.uid(323))), 'EP0001|immutable_row%', 'C6 check 13: PDF fields are write-once (NULL -> value only)');
SELECT alike(pg_temp.a('UPDATE reporting.report_versions SET page_count = 9 WHERE id = ' || quote_literal(pg_temp.uid(321))), 'EP0001|immutable_row%', 'page_count write-once on a released version');
SELECT is(pg_temp.a('UPDATE reporting.report_versions SET pdf_object_path = ' || quote_literal(pg_temp.ta()::text || '/' || to_char(now() AT TIME ZONE 'UTC', 'YYYY/MM') || '/' || pg_temp.uid(311)::text || '-v2.pdf')
  || ', pdf_sha256 = repeat(''b'', 64), pdf_bytes = 10, page_count = 1, status = ''rendered'', rendered_at = now(), version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(322))), 'n=1',
  'C6 check 13: rendering -> rendered with the PDF written once is allowed');
SELECT alike(pg_temp.a('UPDATE reporting.report_versions SET pdf_object_path = ''x/y.pdf'' WHERE id = ' || quote_literal(pg_temp.uid(322))), 'EP0001|immutable_row%', 'pdf_object_path cannot be rewritten once set');
SELECT alike(pg_temp.a('UPDATE reporting.report_versions SET status = ''released'', released_at = now(), release_basis = ''bogus'', release_mode = ''manual'', audiences = ARRAY[''patient''] WHERE id = ' || quote_literal(pg_temp.uid(322))), 'E23514|%report_versions__basis__ck%',
  'release_basis CHECK');
SELECT alike(pg_temp.a('DELETE FROM reporting.report_versions'), 'E42501|%', 'C6 check 13 / AC-0B-4.2: no DELETE on report_versions');
-- reports
SELECT alike(pg_temp.a('UPDATE reporting.reports SET registration_no = ''HACK'' WHERE id = ' || quote_literal(pg_temp.uid(311))), 'EP0001|immutable_row%', 'C6 check 13 / AC-0B-4.1: reports.registration_no frozen (snapshot)');
SELECT alike(pg_temp.a('UPDATE reporting.reports SET centre_id = ' || quote_literal(pg_temp.id('00000000a202')) || ' WHERE id = ' || quote_literal(pg_temp.uid(311))), 'EP0001|immutable_row%', 'reports.centre_id frozen (08 A13 D-36)');
SELECT alike(pg_temp.a('UPDATE reporting.reports SET order_id = ' || quote_literal(pg_temp.uid(12)) || ' WHERE id = ' || quote_literal(pg_temp.uid(311))), 'EP0001|immutable_row%', 'reports.order_id frozen');
-- report template versions
SELECT alike(pg_temp.a('UPDATE reporting.report_template_versions SET config = ''{"x":1}'' WHERE id = ' || quote_literal(pg_temp.uid(302))), 'EP0001|immutable_row%', 'C6 check 13: published template version is immutable (only status may change)');
SELECT is(pg_temp.a('UPDATE reporting.report_template_versions SET status = ''retired'', version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(302))), 'n=1', 'published -> retired is allowed');
-- qr_tokens
SELECT alike(pg_temp.a('UPDATE reporting.qr_tokens SET token_sha256 = decode(repeat(''cd'', 32), ''hex'') WHERE id = ' || quote_literal(pg_temp.uid(331))), 'EP0001|immutable_row%', 'C6 check 13: qr_tokens.token_sha256 frozen');
SELECT alike(pg_temp.a('UPDATE reporting.qr_tokens SET panel_names_snapshot = ARRAY[''X''] WHERE id = ' || quote_literal(pg_temp.uid(331))), 'EP0001|immutable_row%', 'qr_tokens snapshots frozen');
-- portal_links guard (staff) on L4
SELECT is(pg_temp.a('UPDATE reporting.portal_links SET redeem_failures = 2, version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(344))), 'n=1', 'C6 check 13: redeem_failures may increase');
SELECT alike(pg_temp.a('UPDATE reporting.portal_links SET redeem_failures = 1 WHERE id = ' || quote_literal(pg_temp.uid(344))), 'EP0001|immutable_row%', 'C6 check 13: redeem_failures never decreases');
SELECT alike(pg_temp.a('UPDATE reporting.portal_links SET redeem_failures = 6 WHERE id = ' || quote_literal(pg_temp.uid(344))), 'E23514|%portal_links__redeem_failures__ck%', 'redeem_failures CHECK 0..5');
SELECT is(pg_temp.a('UPDATE reporting.portal_links SET delivery_id = ' || quote_literal(pg_temp.uid(361)) || ', version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(344))), 'n=1', 'delivery_id NULL -> value allowed');
SELECT alike(pg_temp.a('UPDATE reporting.portal_links SET delivery_id = ' || quote_literal(pg_temp.uid(362)) || ' WHERE id = ' || quote_literal(pg_temp.uid(344))), 'EP0001|immutable_row%', 'delivery_id never changes once set');
SELECT is(pg_temp.a('UPDATE reporting.portal_links SET revoked_at = now(), revoked_by = ' || quote_literal(pg_temp.sys()) || ', revoke_reason_code = ''issued_in_error'', version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(344))), 'n=1',
  'C6 check 13: staff may revoke a link (NULL -> value)');
SELECT alike(pg_temp.a('UPDATE reporting.portal_links SET revoked_at = NULL WHERE id = ' || quote_literal(pg_temp.uid(344))), 'EP0001|immutable_row%', 'C6 check 13: revocation is one-way (revoked_at cannot be cleared)');
SELECT alike(pg_temp.a('UPDATE reporting.portal_links SET revoke_reason_code = ''other'' WHERE id = ' || quote_literal(pg_temp.uid(344))), 'EP0001|immutable_row%', 'revoke_reason_code frozen once revoked');
SELECT alike(pg_temp.a('UPDATE reporting.portal_links SET purpose = ''dues'' WHERE id = ' || quote_literal(pg_temp.uid(343))), 'EP0001|immutable_row%', 'portal_links.purpose is immutable (08 A21.1)');
-- deliveries scrub-only guard
SELECT alike(pg_temp.a('UPDATE reporting.deliveries SET channel = ''email'' WHERE id = ' || quote_literal(pg_temp.uid(361))), 'EP0001|immutable_row%', 'C6 check 13: deliveries.channel frozen');
SELECT alike(pg_temp.a('UPDATE reporting.deliveries SET params = params || ''{"extra":"v"}''::jsonb WHERE id = ' || quote_literal(pg_temp.uid(361))), 'EP0001|immutable_row%', 'C6 check 13: deliveries.params may only lose url / otp_code');
SELECT alike(pg_temp.a('UPDATE reporting.deliveries SET params = params - ''lab_name'' WHERE id = ' || quote_literal(pg_temp.uid(361))), 'EP0001|immutable_row%', 'params cannot lose other keys');
SELECT is(pg_temp.a('UPDATE reporting.deliveries SET params = params - ''url'' - ''otp_code'', status = ''sent'', sent_at = now(), version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(361))), 'n=1', 'C6 check 13: scrubbing url / otp_code is allowed');
SELECT is(pg_temp.a('SELECT params::text FROM reporting.deliveries WHERE id = ' || quote_literal(pg_temp.uid(361)), 's'), '{"lab_name": "Synthetic Lab"}', 'scrubbed params keep the non-secret keys');
SELECT alike(pg_temp.a('UPDATE reporting.deliveries SET destination_e164 = ''+9779800000002'' WHERE id = ' || quote_literal(pg_temp.uid(364))), 'EP0001|immutable_row%', 'destination_e164 may only go to NULL');
SELECT is(pg_temp.a('UPDATE reporting.deliveries SET destination_e164 = NULL, version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(364))), 'n=1', 'destination_e164 scrub to NULL allowed');
SELECT alike(pg_temp.a('DELETE FROM reporting.deliveries'), 'E42501|%', 'AC-0B-4.2: no DELETE on deliveries');
-- portal_payment_requests guard
SELECT alike(pg_temp.a('UPDATE reporting.portal_payment_requests SET status = ''completed'', completed_at = now() WHERE id = ' || quote_literal(pg_temp.uid(381))), 'EP0001|immutable_row%', 'C6 check 13: queued -> completed is not a legal transition');
SELECT alike(pg_temp.a('UPDATE reporting.portal_payment_requests SET status = ''ready'' WHERE id = ' || quote_literal(pg_temp.uid(381))), 'E23514|%portal_payment_requests__ready__ck%', 'ready needs intent_id and amount_paisa (CHECK)');
SELECT is(pg_temp.a('UPDATE reporting.portal_payment_requests SET status = ''ready'', intent_id = ' || quote_literal(pg_temp.uid(901)) || ', amount_paisa = 5000, action_json = ''{"url":"https://pay.example/x"}'', version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(381))), 'n=1',
  'queued -> ready with intent and amount');
SELECT alike(pg_temp.a('UPDATE reporting.portal_payment_requests SET amount_paisa = 6000 WHERE id = ' || quote_literal(pg_temp.uid(381))), 'EP0001|immutable_row%', 'amount_paisa never changes once set');
SELECT alike(pg_temp.a('UPDATE reporting.portal_payment_requests SET review = true WHERE id = ' || quote_literal(pg_temp.uid(381))), 'E23514|%portal_payment_requests__action__ck%', 'action_json only while ready and not under review (scrub rule)');
SELECT is(pg_temp.a('UPDATE reporting.portal_payment_requests SET review = true, action_json = NULL, version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(381))), 'n=1', 'held_for_review scrubs the gateway URL');
SELECT alike(pg_temp.a('UPDATE reporting.portal_payment_requests SET failure_code = ''x'' WHERE id = ' || quote_literal(pg_temp.uid(382))), 'EP0001|immutable_row%', 'C6 check 13: terminal (completed) payment request never changes');
SELECT is(pg_temp.a('SELECT 1 FROM reporting.portal_payment_requests', 'n'), 'n=2', 'system sees both payment requests');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM reporting.portal_payment_requests'), 'n=0', 'staff never read payment requests (CONV)');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM reporting.otp_challenges UNION ALL SELECT 1 FROM reporting.portal_sessions'), 'n=0', 'C6 check 13 / review fix #34: staff never read OTP challenges or portal sessions');
-- append-only + no DELETE (AC-0B-4.2 / 4.3)
SELECT alike(pg_temp.a('UPDATE reporting.delivery_attempts SET error_code = ''x'''), 'E42501|%', 'C6 check 13 / AC-0B-4.3: no UPDATE grant on delivery_attempts');
SELECT alike(pg_temp.a('DELETE FROM reporting.' || t), 'E42501|%', 'C6 check 13 / AC-0B-4.2: no DELETE grant on reporting.' || t)
  FROM unnest(ARRAY['reports','report_order_items','report_versions','qr_tokens','portal_links','deliveries','delivery_attempts','provider_events','input_files','narrative_reports','narrative_versions','settings','staff_assignments',
    'centre_contacts','referrer_preferences','channel_accounts','message_template_texts','report_templates','report_template_versions','narrative_templates','cs_reasons','g_message_templates','g_cs_reasons']) t;
SELECT alike(pg_temp.a('INSERT INTO reporting.g_cs_reasons (set_name, code, display) VALUES (''token_revoke_reasons'', ''zz_hack'', ''x'')'), 'E42501|%', 'lims_app cannot write global coded sets');
SELECT alike(pg_temp.a('UPDATE reporting.g_message_templates SET is_active = false'), 'E42501|%', 'lims_app cannot update the global message template registry');
SELECT is(pg_temp.a('SELECT 1 FROM reporting.g_message_templates WHERE code = ''reporting.zz_test''', 'n'), 'n=1', 'every tenant can read the global registry');
-- E-table purge policies (system, expired only)
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'DELETE FROM reporting.print_jobs', 'w'), 'n=0', 'C6 check 13: only the system actor purges print_jobs');
SELECT is(pg_temp.a('DELETE FROM reporting.otp_challenges', 'w'), 'n=0', 'unexpired OTP rows are not purged (expires_at < now() - 24 h)');
SELECT is(pg_temp.b('DELETE FROM reporting.print_jobs', 'w'), 'n=0', 'tenant B purge touches 0 rows of A');
SELECT is(pg_temp.a('DELETE FROM reporting.print_jobs', 'w'), 'n=1', 'C6 check 13: system purges the expired print job (purge_ephemeral)');

-- ===================================================================================================================================== C6 check 14: lookup DEFINERs, GUC isolation (A12.7, A21.4)
-- C6 check 14: lookup DEFINERs, GUC isolation, audit, views
-- reading as lims_app / lims_reporting_lookup without the function never reaches the token rows
SELECT is(pg_temp.x('lims_reporting_lookup', NULL, 'SELECT 1 FROM reporting.qr_tokens', 'n'), 'n=0', 'C6 check 14: the lookup role sees no QR token without a GUC');
SELECT is(pg_temp.x('lims_reporting_lookup', NULL, 'SELECT 1 FROM reporting.portal_links', 'n'), 'n=0', 'C6 check 14: the lookup role sees no portal link without a GUC');
SELECT is(pg_temp.x('lims_reporting_lookup', NULL, 'SELECT 1 FROM reporting.reports UNION ALL SELECT 1 FROM reporting.deliveries UNION ALL SELECT 1 FROM reporting.report_versions UNION ALL SELECT 1 FROM reporting.channel_accounts', 'n'), 'n=0',
  'the lookup role sees nothing else without a GUC');
-- A12.7: a lims_app session that sets the same GUC sees nothing (policies are TO lims_reporting_lookup only)
SELECT is(pg_temp.x('lims_app', NULL, format($$ SELECT 1 FROM (SELECT set_config('app.pre_qr_token_sha256', %L, true)) s, reporting.qr_tokens $$, repeat('ab', 32)), 'n'), 'n=0', 'C6 check 14 / A12.7: lims_app setting app.pre_qr_token_sha256 sees no QR token');
SELECT is(pg_temp.x('lims_app', NULL, format($$ SELECT 1 FROM (SELECT set_config('app.pre_portal_credential_sha256', %L, true)) s, reporting.portal_links $$, repeat('11', 32)), 'n'), 'n=0', 'A12.7: app.pre_portal_credential_sha256 gives lims_app nothing');
SELECT is(pg_temp.x('lims_app', NULL, format($$ SELECT 1 FROM (SELECT set_config('app.pre_portal_token_sha256', %L, true)) s, reporting.portal_links $$, repeat('11', 32)), 'n'), 'n=0', 'A12.7: app.pre_portal_token_sha256 gives lims_app nothing');
SELECT is(pg_temp.x('lims_app', NULL, format($$ SELECT 1 FROM (SELECT set_config('app.pre_callback_token_sha256', %L, true)) s, reporting.channel_accounts $$, repeat('44', 32)), 'n'), 'n=0', 'A12.7: app.pre_callback_token_sha256 gives lims_app nothing');
-- app.reporting_verify_qr
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT 1 FROM app.reporting_verify_qr(decode(%L, 'hex')) $$, repeat('ab', 32)), 'n'), 'n=1', 'C6 check 14: reporting_verify_qr returns the released version for a valid token (no claims, pre-tenant)');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT status || ':' || version_no || ':' || lab_name || ':' || patient_display FROM app.reporting_verify_qr(decode(%L, 'hex')) $$, repeat('ab', 32)), 's'), 'valid:1:Synthetic Lab:T.P.',
  'verify_qr returns exactly the snapshot columns and status valid');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT 1 FROM app.reporting_verify_qr(decode(%L, 'hex')) $$, repeat('ee', 32)), 'n'), 'n=0', 'verify_qr: unknown token -> 0 rows (identical to revoked)');
SELECT is(pg_temp.x('lims_api', NULL, $$ SELECT 1 FROM app.reporting_verify_qr(NULL) $$, 'n'), 'n=0', 'verify_qr: NULL token -> 0 rows');
SELECT is(pg_temp.x('lims_api', NULL, $$ SELECT 1 FROM app.reporting_verify_qr(decode('abab', 'hex')) $$, 'n'), 'n=0', 'verify_qr: a token that is not 32 bytes -> 0 rows');
SELECT ok(pg_temp.guc_empty('app.pre_qr_token_sha256'), 'C6 check 14 / A21.4: app.pre_qr_token_sha256 is empty after verify_qr returned');
SELECT alike(pg_temp.x('lims_app', NULL, format($$ SELECT 1 FROM app.reporting_verify_qr(decode(%L, 'hex')) $$, repeat('ab', 32)), 'n'), 'E42501|%', 'EXECUTE on reporting_verify_qr is not granted to lims_app');
SELECT alike(pg_temp.x('anon', NULL, format($$ SELECT 1 FROM app.reporting_verify_qr(decode(%L, 'hex')) $$, repeat('ab', 32)), 'n'), 'E42501|%', 'EXECUTE on reporting_verify_qr is not granted to anon') WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon');
-- app.reporting_resolve_portal_credential
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT stage || ':' || purpose FROM app.reporting_resolve_portal_credential('link', decode(%L, 'hex')) $$, repeat('11', 32)), 's'), 'link:report', 'C6 check 14: resolve link credential -> stage link, purpose report');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT stage || ':' || purpose FROM app.reporting_resolve_portal_credential('session', decode(%L, 'hex')) $$, repeat('33', 32)), 's'), 'session:report', 'resolve session credential -> stage session');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT 1 FROM app.reporting_resolve_portal_credential('session', decode(%L, 'hex')) $$, repeat('11', 32)), 'n'), 'n=0', 'a link token is not a session token');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT 1 FROM app.reporting_resolve_portal_credential('bogus', decode(%L, 'hex')) $$, repeat('11', 32)), 'n'), 'n=0', 'unknown credential kind -> 0 rows');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT 1 FROM app.reporting_resolve_portal_credential('link', decode(%L, 'hex')) $$, repeat('99', 32)), 'n'), 'n=0', 'unknown link token -> 0 rows');
SELECT ok(pg_temp.guc_empty('app.pre_portal_credential_sha256'), 'C6 check 14 / A21.4: app.pre_portal_credential_sha256 is empty after resolve returned');
-- app.reporting_redeem_link_for_app (D-30): correct phone -> row; wrong phone -> counter; 5 failures lock
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT patient_id::text || ':' || version_no FROM app.reporting_redeem_link_for_app(decode(%L, 'hex'), decode(%L, 'hex')) $$, repeat('11', 32), repeat('22', 32)), 's'),
  pg_temp.uid(1)::text || ':1', 'C6 check 14: redeem with the right phone hash returns patient + released version');
SELECT ok(pg_temp.guc_empty('app.pre_portal_token_sha256'), 'C6 check 14 / A21.4: app.pre_portal_token_sha256 is empty after redeem returned');
SELECT is((SELECT redeem_failures FROM reporting.portal_links WHERE id = pg_temp.uid(341)), 0::smallint, 'a successful redeem does not touch the counter');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT 1 FROM app.reporting_redeem_link_for_app(decode(%L, 'hex'), decode(%L, 'hex')) $$, repeat('11', 32), repeat('99', 32)), 'n'), 'n=0', 'redeem with a wrong phone hash -> 0 rows (identical to invalid)');
SELECT is((SELECT redeem_failures FROM reporting.portal_links WHERE id = pg_temp.uid(341)), 1::smallint, 'C6 check 14: the wrong phone increments redeem_failures (only that column)');
SELECT ok(pg_temp.guc_empty('app.pre_portal_token_sha256'), 'GUC empty after the wrong-phone return');
SELECT pg_temp.x('lims_api', NULL, format($$ SELECT 1 FROM app.reporting_redeem_link_for_app(decode(%L, 'hex'), decode(%L, 'hex')) $$, repeat('11', 32), repeat('99', 32)), 'n') FROM generate_series(1, 4);
SELECT is((SELECT redeem_failures FROM reporting.portal_links WHERE id = pg_temp.uid(341)), 5::smallint, 'five wrong attempts -> redeem_failures = 5');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT 1 FROM app.reporting_redeem_link_for_app(decode(%L, 'hex'), decode(%L, 'hex')) $$, repeat('11', 32), repeat('22', 32)), 'n'), 'n=0', 'C6 check 14: a locked link refuses even the right phone hash');
SELECT is((SELECT redeem_failures FROM reporting.portal_links WHERE id = pg_temp.uid(341)), 5::smallint, 'the counter stays at 5 (CHECK 0..5, no error)');
SELECT ok(pg_temp.guc_empty('app.pre_portal_token_sha256'), 'GUC empty after the locked return');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT 1 FROM app.reporting_redeem_link_for_app(decode(%L, 'hex'), decode(%L, 'hex')) $$, repeat('11', 32), repeat('2', 4)), 'n'), 'n=0', 'a phone hash that is not 32 bytes -> 0 rows');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'reporting' AND table_name = 'portal_links' AND row_id = pg_temp.uid(341) AND action = 'UPDATE'), 0,
  'C6 check 14 / §1 note: redeem-counter updates are not row-audited (conditional audit trigger)');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'reporting' AND table_name = 'portal_links' AND row_id = pg_temp.uid(341) AND action = 'INSERT'), 1, 'the link INSERT is audited (portal_links__audit_ins)');
-- app.reporting_ingest_provider_callback: LD-49 (b) (C6-T29) -- the DEFINER only validates the token and records the events; it returns the resolved tenant id (uuid) or NULL and never enqueues.
-- The C6 API handler enqueues reporting.apply_provider_events under withTenantScope(returned tenant, reporting system actor). NULL (not -1) is the reject value: a uuid column cannot hold -1.
SELECT is((SELECT pg_get_function_result(p.oid) FROM pg_proc p WHERE p.oid = 'app.reporting_ingest_provider_callback(text, bytea, jsonb)'::regprocedure), 'uuid', 'LD-49 (b): returns the tenant id (uuid)');
SELECT unlike((SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'app.reporting_ingest_provider_callback(text, bytea, jsonb)'::regprocedure), '%enqueue_job%', 'LD-49 (b): the DEFINER does not enqueue');
SELECT unlike((SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'app.reporting_ingest_provider_callback(text, bytea, jsonb)'::regprocedure), '%request.jwt%', 'LD-49 (b): the DEFINER never sets JWT claims');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT app.reporting_ingest_provider_callback('recording', decode(%L, 'hex'), %L::jsonb) $$, repeat('44', 32),
  jsonb_build_array(jsonb_build_object('id', pg_temp.uid(601), 'provider_message_id', 'pm-1', 'status_raw', 'ok', 'mapped_status', 'sent', 'occurred_at', now()))::text), 's'), pg_temp.ta()::text,
  'C6 check 14 / LD-49 (b): provider callback with a valid token stores the event and returns the TENANT ID');
SELECT is((SELECT count(*)::int FROM reporting.provider_events WHERE provider_message_id = 'pm-1' AND tenant_id = pg_temp.ta() AND channel_account_id = pg_temp.uid(371)), 1, 'the event is stored under the token''s tenant and channel account');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT app.reporting_ingest_provider_callback('recording', decode(%L, 'hex'), %L::jsonb) $$, repeat('44', 32),
  jsonb_build_array(jsonb_build_object('id', pg_temp.uid(602), 'provider_message_id', 'pm-1', 'status_raw', 'ok', 'mapped_status', 'sent'))::text), 's'), pg_temp.ta()::text, 'a duplicate event is accepted idempotently (ON CONFLICT DO NOTHING) and still returns the tenant id');
SELECT is((SELECT count(*)::int FROM reporting.provider_events WHERE provider_message_id = 'pm-1'), 1, 'the duplicate did not create a second row (provider_events__dedupe__uq)');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT app.reporting_ingest_provider_callback('recording', decode(%L, 'hex'), '[]'::jsonb) $$, repeat('99', 32)), 's'), '<null>', 'unknown callback token -> NULL');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT app.reporting_ingest_provider_callback('sms_sparrow', decode(%L, 'hex'), '[]'::jsonb) $$, repeat('44', 32)), 's'), '<null>', 'a token with the wrong provider_kind -> NULL');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT app.reporting_ingest_provider_callback('recording', decode(%L, 'hex'), '{}'::jsonb) $$, repeat('44', 32)), 's'), '<null>', 'a non-array payload -> NULL');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT app.reporting_ingest_provider_callback('recording', decode(%L, 'hex'), '[]'::jsonb) $$, repeat('4', 4)), 's'), '<null>', 'a token hash that is not 32 bytes -> NULL');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT app.reporting_ingest_provider_callback('recording', decode(%L, 'hex'), (SELECT jsonb_agg('{}'::jsonb) FROM generate_series(1, 101))) $$, repeat('44', 32)), 's'), '<null>', 'more than 100 events -> NULL (nothing stored)');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT app.reporting_ingest_provider_callback('recording', decode(%L, 'hex'), '[]'::jsonb) $$, repeat('44', 32)), 's'), pg_temp.ta()::text, 'a valid token with no events still returns the tenant id (the CB2 handshake uses this)');
SELECT ok(pg_temp.guc_empty('app.pre_callback_token_sha256') AND pg_temp.guc_empty('app.pre_callback_tenant_id') AND pg_temp.guc_empty('app.pre_callback_channel_account_id'), 'C6 check 14 / A21.4: all three callback GUCs are empty after return');
SELECT is((SELECT count(*)::int FROM reporting.provider_events WHERE tenant_id = pg_temp.tb()), 0, 'the callback of tenant A''s account wrote nothing for tenant B');
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), 'UPDATE reporting.provider_events SET mapped_status = ''failed''', 'w'), 'EP0001|immutable_row%', 'provider_events: only applied_at / delivery_id / ignored_reason may change (AC-0B-4.1)');
SELECT is(pg_temp.a('UPDATE reporting.provider_events SET applied_at = now(), delivery_id = ' || quote_literal(pg_temp.uid(361)), 'w'), 'n=1', 'provider_events apply columns are updatable');
-- audit rows (AC-0B-5.1 / 5.2) and the supersede / revoke lifecycle
SELECT is(pg_temp.a('UPDATE reporting.reports SET review_flag = ''released_item_removed'', version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(312))), 'n=1', 'C6 check 14: reports lifecycle update');
SELECT is((SELECT array_agg(c ORDER BY c) FROM audit.audit_log a, unnest(a.changed_columns) c WHERE a.schema_name = 'reporting' AND a.table_name = 'reports' AND a.row_id = pg_temp.uid(312) AND a.action = 'UPDATE'),
  ARRAY['review_flag'], 'C6 check 14 / AC-0B-5.2: changed_columns lists exactly the changed columns (version / updated_* excluded)');
SELECT is((SELECT array_agg(k ORDER BY k) FROM audit.audit_log a, jsonb_object_keys(a.old_values) k WHERE a.schema_name = 'reporting' AND a.table_name = 'reports' AND a.row_id = pg_temp.uid(312) AND a.action = 'UPDATE'),
  ARRAY['review_flag'], 'AC-0B-5.2: old_values contains only the changed columns');
SELECT cmp_ok((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'reporting' AND table_name = 'report_versions' AND row_id = pg_temp.uid(322)), '>=', 2, 'C6 check 14 / AC-0B-5.1: report_versions INSERT + UPDATE audited');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'reporting' AND table_name = 'portal_links' AND row_id = pg_temp.uid(344) AND action = 'UPDATE' AND 'revoked_at' = ANY (changed_columns)), 1, 'link revocation is audited');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'reporting' AND table_name IN ('delivery_attempts','otp_challenges','portal_sessions','portal_payment_requests','print_jobs','provider_events','g_cs_reasons','g_message_templates')), 0,
  'C6 check 14: E / A / G tables are not audited');
SELECT alike(pg_temp.a(format($$ INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_type) VALUES (%L, %L, 'x', 'y', 'INSERT', 'user') $$, pg_temp.uid(701), pg_temp.ta())), 'E42501|%', 'AC-0B-5.3: lims_app INSERT INTO audit.audit_log fails');
-- verify_qr after the lifecycle: superseded still verifies (as superseded), revoked does not
SELECT is(pg_temp.a('UPDATE reporting.report_versions SET status = ''superseded'', superseded_at = now(), superseded_by_version_no = 2, version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(321))), 'n=1', 'released -> superseded is allowed');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT status FROM app.reporting_verify_qr(decode(%L, 'hex')) $$, repeat('ab', 32)), 's'), 'superseded', 'C6 check 14: a superseded version verifies with status superseded');
SELECT is(pg_temp.a('UPDATE reporting.qr_tokens SET revoked_at = now(), revoked_by = ' || quote_literal(pg_temp.sys()) || ', revoke_reason_code = ''issued_in_error'', version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(331))), 'n=1', 'QR token revocation');
SELECT is(pg_temp.x('lims_api', NULL, format($$ SELECT 1 FROM app.reporting_verify_qr(decode(%L, 'hex')) $$, repeat('ab', 32)), 'n'), 'n=0', 'C6 check 14: a revoked QR token verifies as nothing');
-- published views (C6 §7)
SELECT is(pg_temp.a('SELECT 1 FROM reporting.v_pub_report_release', 'n'), 'n=1', 'C6 check 14: v_pub_report_release: tenant A sees its released / superseded version only (not rendering / rendered)');
SELECT is(pg_temp.b('SELECT 1 FROM reporting.v_pub_report_release', 'n'), 'n=1', 'v_pub_report_release: tenant B sees its own only');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM reporting.v_pub_report_release'), 'n=0', 'views follow the centre RLS (security_invoker)');
SELECT is(pg_temp.a($$ SELECT release_basis || ':' || report_kind FROM reporting.v_pub_report_release $$, 's'), 'paid_in_full:final', 'v_pub_report_release columns carry the release basis and kind');
SELECT pg_temp.a('UPDATE reporting.reports SET first_released_at = registered_at + interval ''1 hour'', final_released_at = registered_at + interval ''2 hours'', version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(311)));
SELECT is(pg_temp.a('UPDATE reporting.reports SET state = ''cancelled'', cancelled_at = now(), version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(312))), 'n=1', 'cancel R2');
SELECT is(pg_temp.a('SELECT 1 FROM reporting.v_pub_order_report_tat', 'n'), 'n=1', 'C6 check 14: v_pub_order_report_tat counts open reports only (R2 cancelled)');
SELECT is(pg_temp.a('SELECT total_tat_seconds::text FROM reporting.v_pub_order_report_tat', 's'), '7200', 'total_tat_seconds = final_released_at - registered_at (R1)');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM reporting.v_pub_order_report_tat'), 'n=0', 'v_pub_order_report_tat follows centre RLS');
SELECT is(pg_temp.a($$ SELECT queued::text FROM reporting.v_pub_delivery_daily WHERE channel = 'sms' AND purpose = 'report_ready' AND centre_id = '$$ || pg_temp.id('00000000a201') || $$' $$, 's'), '1', 'C6 check 14: v_pub_delivery_daily counts the queued sms delivery of centre a201');
SELECT is(pg_temp.a($$ SELECT sent::text FROM reporting.v_pub_delivery_daily WHERE channel = 'print' AND centre_id IS NULL $$, 's'), '1', 'v_pub_delivery_daily: non-report deliveries have centre_id NULL (CR-C8-005)');
SELECT is(pg_temp.a($$ SELECT 1 FROM reporting.v_pub_delivery_daily WHERE business_date = (now() AT TIME ZONE 'Asia/Kathmandu')::date $$, 'n'), 'n=3', 'business_date = creation date in Asia/Kathmandu (3 cohorts today)');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM reporting.v_pub_delivery_daily'), 'n=1', 'a centre actor sees only its centre''s delivery cohort');
SELECT is(pg_temp.b('SELECT 1 FROM reporting.v_pub_delivery_daily', 'n'), 'n=1', 'tenant B sees only its own delivery cohort');
SELECT alike(pg_temp.a('INSERT INTO reporting.v_pub_report_release (tenant_id) VALUES (gen_random_uuid())'), 'E42501|%', 'views are read-only for lims_app');

SELECT * FROM finish();
ROLLBACK;
