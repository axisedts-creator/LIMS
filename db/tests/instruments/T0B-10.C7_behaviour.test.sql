-- T0B-10.C7 behaviour suite: tenant / centre isolation incl. device actors, composite-FK centre binding, secret_sha256 column privilege, the device-credential resolver, agent-state snapshot and archive purge
-- DEFINERs (FORCE RLS on, never disabled; 08 A10.5), GUC isolation (08 A12.1 / A12.2 / A12.7), mutable-column and transition triggers, append-only grants, audit exclusion of the secret, published views
-- (C7 05-SCHEMA §1.1, §4, §5, §6, §8 items 1-12; AC-0B-2.4, 3.1-3.5, 3.7, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3).
-- The generated per-table probes (db/tests/isolation/instruments.<t>.test.sql) are the AC-0B-3.x proof for every table; this file proves what the generator cannot know.
-- Synthetic data only (seeds 010: tenant A 01a1a98a-...-a001, tenant B ...-b001; branches a101/b101; centres a201/a202/b201). One rolled-back transaction.
-- RLS is never disabled: fixtures are inserted by the superuser test session with the core system actor's claims set so app.tg_row_audit has an audit context;
-- every assertion runs as SET LOCAL ROLE lims_app / lims_api / lims_worker (pg_temp.x).
-- Run from the repo root: pg_prove -d <db> db/tests/instruments/T0B-10.C7_behaviour.test.sql   (pgTAP in schema `extensions`; migrations + seeds loaded; superuser)
-- Markers: C7 check 11 fixtures/controls + non-staff actors + no claims (item 12), 12 tenant isolation (item 1), 13 centre isolation + device actor + centre-bound FKs (items 2, 3, 11), 14 secret_sha256 column privilege + append-only grants (item 4),
-- 15 resolver (items 5, 9), 16 snapshot + GUC isolation + EXECUTE (items 9, 10), 17 purge (item 7), 18 mutability + transitions + audit + views (items 6, 8).
-- Order matters inside the transaction: read-only checks first, the purge next, state-changing UPDATEs (transitions) last.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c700-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
CREATE FUNCTION pg_temp.by(h text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '\x' || repeat(h, 32) $$;          -- 32-byte bytea literal (two hex digits repeated)
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
CREATE FUNCTION pg_temp.a(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;      -- tenant A, all centres (system)
CREATE FUNCTION pg_temp.b(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.dev(p_centre uuid, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device', p_centre), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.cpb(p_tbl regclass, p_where text, p_over jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE j jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(t) FROM %s t WHERE %s', p_tbl, p_where) INTO j;
  RETURN format('INSERT INTO %1$s SELECT * FROM jsonb_populate_record(NULL::%1$s, %2$L::jsonb)', p_tbl, (j || p_over)::text);
END $f$;
CREATE FUNCTION pg_temp.guc_empty(p_name text) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting(p_name, true), '') = '' $$;
-- resolver call as lims_api with NO claims (pre-tenant): 'kind:tenant:agent:centre' or '<none>'
CREATE FUNCTION pg_temp.rs(p_hash text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.x('lims_api', NULL, 'SELECT coalesce(string_agg(credential_kind || '':'' || tenant_id::text || '':'' || agent_id::text || '':'' || centre_id::text, '',''), ''<none>'') FROM app.instruments_resolve_device_credential('
    || CASE WHEN p_hash IS NULL THEN 'NULL::bytea' ELSE quote_literal(p_hash) || '::bytea' END || ')', 's') $$;

-- ===================================================================================================================================== fixtures (superuser, system claims)
-- C7 check 11: agents (A1 active a201, A2 pending a202, A3 revoked a201, A4 retired a201, B1 active b201; T5 pending / T6 active / T7 retired = transition fixtures)
SELECT pg_temp.ins('instruments.agents', jsonb_build_object('id', pg_temp.uid(a.n), 'tenant_id', a.t, 'centre_id', a.c, 'agent_code', a.code, 'display_name', 'Agent ' || a.code, 'status', a.st) || a.x)
  FROM (VALUES
    (401, pg_temp.ta(), pg_temp.id('00000000a201'), 'AG-A1', 'active', '{}'::jsonb),
    (402, pg_temp.ta(), pg_temp.id('00000000a202'), 'AG-A2', 'pending_enrolment', '{}'::jsonb),
    (404, pg_temp.ta(), pg_temp.id('00000000a201'), 'AG-A3', 'revoked', jsonb_build_object('revoked_at', now(), 'revoke_reason_code', 'device_lost_or_stolen')),
    (405, pg_temp.ta(), pg_temp.id('00000000a201'), 'AG-A4', 'retired', jsonb_build_object('retired_at', now())),
    (403, pg_temp.tb(), pg_temp.id('00000000b201'), 'AG-B1', 'active', '{}'::jsonb),
    (411, pg_temp.ta(), pg_temp.id('00000000a201'), 'AG-T5', 'pending_enrolment', '{}'::jsonb),
    (412, pg_temp.ta(), pg_temp.id('00000000a201'), 'AG-T6', 'active', '{}'::jsonb),
    (413, pg_temp.ta(), pg_temp.id('00000000a201'), 'AG-T7', 'retired', jsonb_build_object('retired_at', now()))
  ) a(n, t, c, code, st, x);
-- credentials: 431 A1 token active, 432 A2 code active, 433 A2 code expired, 434 A3 (revoked agent) token, 435 A3 code, 436 A1 token revoked, 437 B1 token; 438-440 transition fixtures on T6
SELECT pg_temp.ins('instruments.agent_credentials', jsonb_build_object('id', pg_temp.uid(c.n), 'tenant_id', c.t, 'centre_id', c.c, 'agent_id', pg_temp.uid(c.ag), 'kind', c.k, 'secret_sha256', pg_temp.by(c.h),
    'status', c.st, 'issued_by', pg_temp.sys()) || c.x)
  FROM (VALUES
    (431, pg_temp.ta(), pg_temp.id('00000000a201'), 401, 'device_token', 'a1', 'active', '{}'::jsonb),
    (432, pg_temp.ta(), pg_temp.id('00000000a202'), 402, 'enrolment_code', 'a2', 'active', jsonb_build_object('expires_at', now() + interval '1 day')),
    (433, pg_temp.ta(), pg_temp.id('00000000a202'), 402, 'enrolment_code', 'a3', 'active', jsonb_build_object('expires_at', now() - interval '1 hour')),
    (434, pg_temp.ta(), pg_temp.id('00000000a201'), 404, 'device_token', 'a4', 'active', '{}'::jsonb),
    (435, pg_temp.ta(), pg_temp.id('00000000a201'), 404, 'enrolment_code', 'a6', 'active', jsonb_build_object('expires_at', now() + interval '1 day')),
    (436, pg_temp.ta(), pg_temp.id('00000000a201'), 401, 'device_token', 'a7', 'revoked', jsonb_build_object('revoked_at', now())),
    (437, pg_temp.tb(), pg_temp.id('00000000b201'), 403, 'device_token', 'b1', 'active', '{}'::jsonb),
    (438, pg_temp.ta(), pg_temp.id('00000000a201'), 412, 'device_token', 'c1', 'active', '{}'::jsonb),
    (439, pg_temp.ta(), pg_temp.id('00000000a201'), 412, 'enrolment_code', 'c2', 'used', jsonb_build_object('expires_at', now() + interval '1 day', 'used_at', now())),
    (440, pg_temp.ta(), pg_temp.id('00000000a201'), 412, 'enrolment_code', 'c3', 'active', jsonb_build_object('expires_at', now() + interval '1 day'))
  ) c(n, t, c, ag, k, h, st, x);
SELECT pg_temp.ins('instruments.agent_status', jsonb_build_object('tenant_id', s.t, 'agent_id', pg_temp.uid(s.ag), 'centre_id', s.c, 'health_state', s.hs) || s.x)
  FROM (VALUES
    (pg_temp.ta(), 401, pg_temp.id('00000000a201'), 'online', jsonb_build_object('queue_depth', 7, 'clock_offset_ms', 4500, 'last_heartbeat_at', now(), 'agent_version', '0.1.0')),
    (pg_temp.ta(), 402, pg_temp.id('00000000a202'), 'offline', '{}'::jsonb),
    (pg_temp.ta(), 405, pg_temp.id('00000000a201'), 'offline', '{}'::jsonb),
    (pg_temp.tb(), 403, pg_temp.id('00000000b201'), 'offline', '{}'::jsonb)
  ) s(t, ag, c, hs, x);
SELECT pg_temp.ins('instruments.agent_health_transitions', jsonb_build_object('id', pg_temp.uid(h.n), 'tenant_id', h.t, 'centre_id', h.c, 'agent_id', pg_temp.uid(h.ag), 'health_version', h.hv, 'to_state', 'online',
    'changed_at', now(), 'queue_depth', 0, 'created_at', h.cr))
  FROM (VALUES (451, pg_temp.ta(), pg_temp.id('00000000a201'), 401, 1, now() - interval '450 days'), (452, pg_temp.ta(), pg_temp.id('00000000a201'), 401, 2, now()),
               (453, pg_temp.tb(), pg_temp.id('00000000b201'), 403, 1, now() - interval '450 days')) h(n, t, c, ag, hv, cr);
SELECT pg_temp.ins('instruments.agent_config_versions', jsonb_build_object('id', pg_temp.uid(g.n), 'tenant_id', g.t, 'centre_id', g.c, 'agent_id', pg_temp.uid(g.ag), 'config_version', 1, 'document', '{}'::jsonb,
    'canonical_sha256', repeat('a', 64), 'signature', 'synthetic-signature', 'key_id', 'k1', 'issued_at', now(), 'reason', 'agent_created'))
  FROM (VALUES (461, pg_temp.ta(), pg_temp.id('00000000a201'), 401), (462, pg_temp.tb(), pg_temp.id('00000000b201'), 403)) g(n, t, c, ag);
-- commands: 471 A completed (old), 472 A queued, 473 A (a202) queued, 474 A completed (recent), 475 B completed (old)
SELECT pg_temp.ins('instruments.agent_commands', jsonb_build_object('id', pg_temp.uid(k.n), 'tenant_id', k.t, 'centre_id', k.c, 'agent_id', pg_temp.uid(k.ag), 'kind', k.kd, 'state', k.st, 'requested_by', pg_temp.sys(),
    'expires_at', now() + interval '1 day', 'updated_at', k.up))
  FROM (VALUES (471, pg_temp.ta(), pg_temp.id('00000000a201'), 401, 'upload_logs', 'completed', now() - interval '100 days'), (472, pg_temp.ta(), pg_temp.id('00000000a201'), 401, 'refresh_config', 'queued', now()),
               (473, pg_temp.ta(), pg_temp.id('00000000a202'), 402, 'refresh_config', 'queued', now()), (474, pg_temp.ta(), pg_temp.id('00000000a201'), 401, 'restart_service', 'completed', now()),
               (475, pg_temp.tb(), pg_temp.id('00000000b201'), 403, 'upload_logs', 'completed', now() - interval '100 days')) k(n, t, c, ag, kd, st, up);
SELECT pg_temp.ins('instruments.agent_log_bundles', jsonb_build_object('id', pg_temp.uid(l.n), 'tenant_id', l.t, 'centre_id', l.c, 'agent_id', pg_temp.uid(l.ag), 'command_id', pg_temp.uid(l.cm), 'lines', jsonb_build_array('synthetic line'),
    'from_at_agent', now() - interval '41 days', 'to_at_agent', now() - interval '40 days', 'size_bytes', 14, 'created_at', now() - interval '40 days'))
  FROM (VALUES (481, pg_temp.ta(), pg_temp.id('00000000a201'), 401, 471), (482, pg_temp.tb(), pg_temp.id('00000000b201'), 403, 475)) l(n, t, c, ag, cm);
-- instruments: I1 live a201, I2 draft a202, IT1 draft / IT2 retired (transition fixtures), IB (B)
SELECT pg_temp.ins('instruments.instruments', jsonb_build_object('id', pg_temp.uid(i.n), 'tenant_id', i.t, 'centre_id', i.c, 'agent_id', pg_temp.uid(i.ag), 'instrument_code', i.code, 'display_name', 'Instrument ' || i.code,
    'vendor', 'Synthetic', 'model', 'SX-1', 'protocol', 'astm', 'driver_code', 'astm_generic_e1394', 'transport', jsonb_build_object('kind', 'tcp_client'), 'timezone', 'Asia/Kathmandu', 'state', i.st) || i.x)
  FROM (VALUES
    (421, pg_temp.ta(), pg_temp.id('00000000a201'), 401, 'IN-A1', 'live', jsonb_build_object('live_at', now(), 'go_live_checklist', jsonb_build_object('evidence_note', 'synthetic'))),
    (422, pg_temp.ta(), pg_temp.id('00000000a202'), 402, 'IN-A2', 'draft', '{}'::jsonb),
    (423, pg_temp.ta(), pg_temp.id('00000000a201'), 401, 'IN-T1', 'draft', '{}'::jsonb),
    (424, pg_temp.ta(), pg_temp.id('00000000a201'), 401, 'IN-T2', 'retired', jsonb_build_object('retired_at', now())),
    (425, pg_temp.tb(), pg_temp.id('00000000b201'), 403, 'IN-B1', 'draft', '{}'::jsonb)) i(n, t, c, ag, code, st, x);
SELECT pg_temp.ins('instruments.instrument_status', jsonb_build_object('tenant_id', s.t, 'instrument_id', pg_temp.uid(s.i), 'centre_id', s.c, 'agent_id', pg_temp.uid(s.ag)))
  FROM (VALUES (pg_temp.ta(), 421, pg_temp.id('00000000a201'), 401), (pg_temp.ta(), 422, pg_temp.id('00000000a202'), 402), (pg_temp.tb(), 425, pg_temp.id('00000000b201'), 403)) s(t, i, c, ag);
-- messages: 501 old plain (purged), 502 old + pending attachment (kept), 503 old + '#deleted' attachment (purged), 504 95 d, 505 89 d, 506 91 d, 507 recent (a201), 508 recent (a202), 509 B old
SELECT pg_temp.ins('instruments.messages', jsonb_build_object('id', pg_temp.uid(m.n), 'tenant_id', m.t, 'centre_id', m.c, 'instrument_id', pg_temp.uid(m.i), 'agent_id', pg_temp.uid(m.ag), 'agent_message_id', pg_temp.uid(m.n + 100),
    'protocol', 'astm', 'message_kind', 'data', 'message_key', 'key-' || m.n, 'message_key_kind', 'sha256', 'raw_bytes', '\x61626364', 'raw_sha256', repeat('a', 64), 'size_bytes', 4,
    'captured_at_agent', now(), 'agent_clock_offset_ms', 0, 'captured_at', now(), 'received_at', now() - m.age))
  FROM (VALUES
    (501, pg_temp.ta(), pg_temp.id('00000000a201'), 421, 401, interval '400 days'), (502, pg_temp.ta(), pg_temp.id('00000000a201'), 421, 401, interval '400 days'),
    (503, pg_temp.ta(), pg_temp.id('00000000a201'), 421, 401, interval '400 days'), (504, pg_temp.ta(), pg_temp.id('00000000a201'), 421, 401, interval '95 days'),
    (505, pg_temp.ta(), pg_temp.id('00000000a201'), 421, 401, interval '89 days'), (506, pg_temp.ta(), pg_temp.id('00000000a201'), 421, 401, interval '91 days'),
    (507, pg_temp.ta(), pg_temp.id('00000000a201'), 421, 401, interval '0 days'), (508, pg_temp.ta(), pg_temp.id('00000000a202'), 422, 402, interval '0 days'),
    (509, pg_temp.tb(), pg_temp.id('00000000b201'), 425, 403, interval '400 days')) m(n, t, c, i, ag, age);
-- runs (counters on 517 drive v_pub_message_daily: 3 patient + 1 qc + (1 unmapped + 1 skipped_no_barcode) = 2 unmatched, outcome quarantined)
SELECT pg_temp.ins('instruments.processing_runs', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'message_id', pg_temp.uid(r.m), 'run_no', 1, 'kind', 'live', 'driver_code', 'astm_generic_e1394',
    'driver_version', '0.1.0', 'outcome', r.o, 'actor_type', 'device') || r.x)
  FROM (VALUES
    (511, pg_temp.ta(), pg_temp.id('00000000a201'), 501, 'parsed', '{}'::jsonb), (514, pg_temp.ta(), pg_temp.id('00000000a201'), 504, 'parsed', '{}'::jsonb),
    (515, pg_temp.ta(), pg_temp.id('00000000a201'), 505, 'parsed', '{}'::jsonb), (516, pg_temp.ta(), pg_temp.id('00000000a201'), 506, 'parsed', '{}'::jsonb),
    (517, pg_temp.ta(), pg_temp.id('00000000a201'), 507, 'quarantined', jsonb_build_object('patient_records', 3, 'qc_records', 1, 'unmapped_records', 1, 'skipped_no_barcode_records', 1)),
    (518, pg_temp.ta(), pg_temp.id('00000000a202'), 508, 'parsed', '{}'::jsonb), (519, pg_temp.tb(), pg_temp.id('00000000b201'), 509, 'parsed', '{}'::jsonb)) r(n, t, c, m, o, x);
-- records: 521 on 501 (purged), 524 on 504 (purged: 95 d), 525 + derived 526 on 505 (kept: 89 d), 527 + derived 528 on 506 (purged in one statement, self FK), 529 on 507, 530 on B, 531 on 508 (a202)
SELECT pg_temp.ins('instruments.message_records', jsonb_build_object('id', pg_temp.uid(r.n), 'tenant_id', r.t, 'centre_id', r.c, 'message_id', pg_temp.uid(r.m), 'run_id', pg_temp.uid(r.run), 'instrument_id', pg_temp.uid(r.i),
    'record_seq', r.seq, 'record_class', 'patient', 'emit_status', 'emitted') || r.x)
  FROM (VALUES
    (521, pg_temp.ta(), pg_temp.id('00000000a201'), 501, 511, 421, 1, '{}'::jsonb), (524, pg_temp.ta(), pg_temp.id('00000000a201'), 504, 514, 421, 1, '{}'::jsonb),
    (525, pg_temp.ta(), pg_temp.id('00000000a201'), 505, 515, 421, 1, '{}'::jsonb), (526, pg_temp.ta(), pg_temp.id('00000000a201'), 505, 515, 421, 2, jsonb_build_object('source_record_id', pg_temp.uid(525))),
    (527, pg_temp.ta(), pg_temp.id('00000000a201'), 506, 516, 421, 1, '{}'::jsonb), (528, pg_temp.ta(), pg_temp.id('00000000a201'), 506, 516, 421, 2, jsonb_build_object('source_record_id', pg_temp.uid(527))),
    (529, pg_temp.ta(), pg_temp.id('00000000a201'), 507, 517, 421, 1, '{}'::jsonb), (530, pg_temp.tb(), pg_temp.id('00000000b201'), 509, 519, 425, 1, '{}'::jsonb),
    (531, pg_temp.ta(), pg_temp.id('00000000a202'), 508, 518, 422, 1, '{}'::jsonb)) r(n, t, c, m, run, i, seq, x);
-- duplicates: 541 -> 501 (purged with it), 542 old -> 504 (purged: > 90 d), 543 recent -> 504 (kept), 544 B old
SELECT pg_temp.ins('instruments.message_duplicates', jsonb_build_object('id', pg_temp.uid(d.n), 'tenant_id', d.t, 'centre_id', d.c, 'agent_id', pg_temp.uid(d.ag), 'instrument_id', pg_temp.uid(d.i), 'original_message_id', pg_temp.uid(d.m),
    'agent_message_id', pg_temp.uid(d.n + 100), 'reason', 'agent_message_id', 'received_at', now() - d.age, 'created_at', now() - d.age))
  FROM (VALUES (541, pg_temp.ta(), pg_temp.id('00000000a201'), 401, 421, 501, interval '0 days'), (542, pg_temp.ta(), pg_temp.id('00000000a201'), 401, 421, 504, interval '100 days'),
               (543, pg_temp.ta(), pg_temp.id('00000000a201'), 401, 421, 504, interval '0 days'), (544, pg_temp.tb(), pg_temp.id('00000000b201'), 403, 425, 509, interval '100 days')) d(n, t, c, ag, i, m, age);
SELECT pg_temp.ins('instruments.message_rejections', jsonb_build_object('id', pg_temp.uid(j.n), 'tenant_id', j.t, 'centre_id', j.c, 'agent_id', pg_temp.uid(j.ag), 'claimed_instrument_id', pg_temp.uid(999), 'agent_message_id', pg_temp.uid(j.n + 100),
    'reason_code', 'instruments.instrument_unknown', 'raw_sha256', repeat('b', 64), 'size_bytes', 4, 'received_at', now() - j.age, 'created_at', now() - j.age))
  FROM (VALUES (551, pg_temp.ta(), pg_temp.id('00000000a201'), 401, interval '100 days'), (552, pg_temp.ta(), pg_temp.id('00000000a201'), 401, interval '0 days'), (553, pg_temp.tb(), pg_temp.id('00000000b201'), 403, interval '100 days')) j(n, t, c, ag, age);
-- attachments: 561 pending on 502 (old, kept), 562 '#deleted' on 503 (old, purged), 563 clean on 507, 564 B on 509 (old)
SELECT pg_temp.ins('instruments.attachments', jsonb_build_object('id', pg_temp.uid(t.n), 'tenant_id', t.t, 'centre_id', t.c, 'message_id', pg_temp.uid(t.m), 'instrument_id', pg_temp.uid(t.i), 'bucket', 'instruments-attachments',
    'object_path', t.t::text || '/2026/11/' || t.n || '.pdf' || t.sfx, 'sha256', repeat('c', 64), 'mime_type', 'application/pdf', 'size_bytes', 100, 'original_file_name', 'synthetic.pdf', 'scan_state', t.st, 'created_at', now() - t.age))
  FROM (VALUES (561, pg_temp.ta(), pg_temp.id('00000000a201'), 502, 421, '', 'pending', interval '400 days'), (562, pg_temp.ta(), pg_temp.id('00000000a201'), 503, 421, '#deleted', 'clean', interval '400 days'),
               (563, pg_temp.ta(), pg_temp.id('00000000a201'), 507, 421, '', 'clean', interval '0 days'), (564, pg_temp.tb(), pg_temp.id('00000000b201'), 509, 425, '', 'pending', interval '400 days')) t(n, t, c, m, i, sfx, st, age);
SELECT pg_temp.ins('instruments.observed_codes', jsonb_build_object('tenant_id', o.t, 'instrument_id', pg_temp.uid(o.i), 'record_class', 'patient', 'instrument_analyte_code', o.code, 'centre_id', o.c, 'first_seen_at', now() - o.age,
    'last_seen_at', now() - o.age, 'last_mapping_status', 'mapped', 'last_mapping_checked_at', now()))
  FROM (VALUES (pg_temp.ta(), 421, pg_temp.id('00000000a201'), 'WBC', interval '450 days'), (pg_temp.ta(), 421, pg_temp.id('00000000a201'), 'RBC', interval '0 days'), (pg_temp.tb(), 425, pg_temp.id('00000000b201'), 'WBC', interval '450 days')) o(t, i, c, code, age);
SELECT pg_temp.ins('instruments.settings', jsonb_build_object('id', pg_temp.uid(s.n), 'tenant_id', s.t)) FROM (VALUES (601, pg_temp.ta()), (602, pg_temp.tb())) s(n, t);

CREATE TEMP TABLE tt(q) AS VALUES ('instruments.settings'),('instruments.agents'),('instruments.agent_credentials'),('instruments.agent_status'),('instruments.agent_health_transitions'),('instruments.agent_config_versions'),
  ('instruments.agent_commands'),('instruments.agent_log_bundles'),('instruments.instruments'),('instruments.instrument_status'),('instruments.messages'),('instruments.processing_runs'),('instruments.message_records'),
  ('instruments.message_duplicates'),('instruments.message_rejections'),('instruments.attachments'),('instruments.observed_codes');
CREATE TEMP TABLE ct(q) AS SELECT q FROM tt WHERE q <> 'instruments.settings';        -- the 16 centre-scoped tables
CREATE TEMP TABLE atb(q) AS VALUES ('instruments.agent_health_transitions'),('instruments.agent_config_versions'),('instruments.agent_log_bundles'),('instruments.messages'),('instruments.processing_runs'),
  ('instruments.message_records'),('instruments.message_duplicates'),('instruments.message_rejections');   -- A tables (SELECT, INSERT only)
-- positive controls: an isolation test on empty data proves nothing
SELECT is(pg_temp.a('SELECT 1 FROM ' || tt.q, 'n') <> 'n=0', true, 'C7 check 11: control: tenant A sees rows of ' || tt.q) FROM tt;
SELECT is(pg_temp.b('SELECT 1 FROM ' || tt.q, 'n') <> 'n=0', true, 'C7 check 11: control: tenant B sees rows of ' || tt.q) FROM tt;
SELECT is(pg_temp.a('SELECT 1 FROM instruments.agents', 'n'), 'n=7', 'C7 check 11: control: tenant A sees its 7 agents');
SELECT is(pg_temp.b('SELECT 1 FROM instruments.agents', 'n'), 'n=1', 'C7 check 11: control: tenant B sees its 1 agent');
SELECT is(pg_temp.a('SELECT 1 FROM instruments.messages', 'n'), 'n=8', 'C7 check 11: control: tenant A sees its 8 messages');

-- C7 check 11: no claims / non-staff actors (AC-0B-3.7; spec §8 item 12, review #15)
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'AC-0B-3.7: no claims -> 0 rows of ' || tt.q) FROM tt;
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM instruments.' || v, 'n'), 'n=0', 'AC-0B-3.7: no claims -> published view ' || v || ' empty') FROM unnest(ARRAY['v_pub_agent_status','v_pub_message_daily','v_pub_instrument_directory']) v;
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), t), 'SELECT 1 FROM instruments.settings', 'n'), 'n=0', 'C7 check 11 / AC-0B-3.7: ' || t || ' actor of the same tenant sees 0 settings rows (is_staff_or_system)') FROM unnest(ARRAY['partner','portal','patient']) t;
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), t), 'UPDATE instruments.settings SET default_backlog_threshold = 11', 'w'), 'n=0', 'C7 check 11 / AC-0B-3.7: ' || t || ' actor updates 0 settings rows') FROM unnest(ARRAY['partner','portal','patient']) t;
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), t), 'INSERT INTO instruments.settings (id, tenant_id, created_by, updated_by) VALUES (gen_random_uuid(), ' || quote_literal(pg_temp.ta()) || ', ' || quote_literal(pg_temp.sys()) || ', ' || quote_literal(pg_temp.sys()) || ')', 'w'),
  'E42501|%', 'C7 check 11 / AC-0B-3.7: ' || t || ' actor cannot write settings (RLS WITH CHECK, not a unique violation)') FROM unnest(ARRAY['partner','portal','patient']) t;
SELECT is(pg_temp.a('SELECT 1 FROM instruments.settings', 'n'), 'n=1', 'C7 check 11: system actor reads own settings row');

-- C7 check 12: tenant isolation (spec §8 item 1; AC-0B-3.1 .. 3.3)
SELECT is(pg_temp.a('SELECT 1 FROM ' || tt.q || ' WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 'n'), 'n=0', 'AC-0B-3.1: tenant A sees 0 tenant-B rows of ' || tt.q) FROM tt;
SELECT is(pg_temp.b('SELECT 1 FROM ' || tt.q || ' WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'AC-0B-3.1: tenant B sees 0 tenant-A rows of ' || tt.q) FROM tt;
SELECT alike(pg_temp.a(pg_temp.cpb('instruments.agents', 'id = ' || quote_literal(pg_temp.uid(403)), jsonb_build_object('id', pg_temp.uid(701), 'agent_code', 'AG-X1')), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert an agent of tenant B');
SELECT alike(pg_temp.a(pg_temp.cpb('instruments.messages', 'id = ' || quote_literal(pg_temp.uid(509)), jsonb_build_object('id', pg_temp.uid(702), 'agent_message_id', pg_temp.uid(703), 'message_key', 'kx')), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert a message of tenant B');
SELECT alike(pg_temp.a(pg_temp.cpb('instruments.observed_codes', 'tenant_id = ' || quote_literal(pg_temp.tb()), jsonb_build_object('instrument_analyte_code', 'ZZZ')), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert an observed code of tenant B');
SELECT alike(pg_temp.a(pg_temp.cpb('instruments.settings', 'id = ' || quote_literal(pg_temp.uid(602)), jsonb_build_object('id', pg_temp.uid(704))), 'w'), 'E42501|%', 'AC-0B-3.2: A cannot insert a settings row of tenant B');
SELECT is(pg_temp.a('UPDATE instruments.agents SET display_name = ''x'' WHERE id = ' || quote_literal(pg_temp.uid(403))), 'n=0', 'AC-0B-3.3: A updates 0 B agents');
SELECT is(pg_temp.a('UPDATE instruments.instruments SET display_name = ''x'' WHERE id = ' || quote_literal(pg_temp.uid(425))), 'n=0', 'AC-0B-3.3: A updates 0 B instruments');
SELECT is(pg_temp.a('UPDATE instruments.agent_commands SET result_code = ''x'' WHERE id = ' || quote_literal(pg_temp.uid(475))), 'n=0', 'AC-0B-3.3: A updates 0 B commands');
SELECT is(pg_temp.a('UPDATE instruments.settings SET default_backlog_threshold = 12 WHERE id = ' || quote_literal(pg_temp.uid(602))), 'n=0', 'AC-0B-3.3: A updates 0 B settings');
SELECT alike(pg_temp.a(pg_temp.cpb('instruments.instruments', 'id = ' || quote_literal(pg_temp.uid(421)), jsonb_build_object('id', pg_temp.uid(705), 'instrument_code', 'IN-X1', 'agent_id', pg_temp.uid(403), 'state', 'draft', 'live_at', NULL, 'go_live_checklist', NULL)), 'w'),
  'E23503|%', 'AC-0B-3.5: composite FK refuses an instrument pointing at the other tenant''s agent');
SELECT alike(pg_temp.a(pg_temp.cpb('instruments.agent_credentials', 'id = ' || quote_literal(pg_temp.uid(431)), jsonb_build_object('id', pg_temp.uid(706), 'agent_id', pg_temp.uid(403), 'secret_sha256', pg_temp.by('e1'))), 'w'),
  'E23503|%', 'AC-0B-3.5: composite FK refuses a credential pointing at the other tenant''s agent');

-- C7 check 13: centre isolation, device actor, centre-bound FKs (spec §8 items 2, 3, 11; AC-0B-3.4)
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM ' || ct.q || ' WHERE centre_id = ' || quote_literal(pg_temp.id('00000000a202'))), 'n=0', 'C7 check 13 / AC-0B-3.4: device a201 sees 0 a202 rows of ' || ct.q) FROM ct;
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM ' || ct.q || ' WHERE centre_id = ' || quote_literal(pg_temp.id('00000000a201'))), 'n=0', 'AC-0B-3.4: device a202 sees 0 a201 rows of ' || ct.q) FROM ct;
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM ' || ct.q) <> 'n=0', true, 'AC-0B-3.4: control: device a201 sees its own rows of ' || ct.q) FROM ct;
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM instruments.agents'), 'n=6', 'AC-0B-3.4: device a201 sees exactly the 6 a201 agents (A1, A3, A4, T5, T6, T7)');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM instruments.agents'), 'n=1', 'AC-0B-3.4: device a202 sees exactly agent A2');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM instruments.messages'), 'n=1', 'AC-0B-3.4: device a202 sees exactly message 508');
SELECT is(pg_temp.dev(pg_temp.id('00000000b201'), 'SELECT 1 FROM instruments.agents'), 'n=0', 'AC-0B-3.4: a tenant-A device with a tenant-B centre claim sees nothing');
SELECT unalike(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM ' || ct.q), 'E%', 'AC-0B-3.4 / A16.1: centre-scoped SELECT on ' || ct.q || ' raises no operator error (::uuid[] cast)') FROM ct;
-- device writes: own centre ok, other centre refused by RLS (spec §8 item 2), A2 instrument refused by the composite FK
SELECT alike(pg_temp.dev(pg_temp.id('00000000a201'), pg_temp.cpb('instruments.messages', 'id = ' || quote_literal(pg_temp.uid(508)), jsonb_build_object('id', pg_temp.uid(711), 'agent_message_id', pg_temp.uid(712), 'message_key', 'k711')), 'w'),
  'E42501|%', 'AC-0B-3.4: device a201 cannot insert a message with centre_id a202 (RLS)');
SELECT alike(pg_temp.dev(pg_temp.id('00000000a201'), pg_temp.cpb('instruments.messages', 'id = ' || quote_literal(pg_temp.uid(507)), jsonb_build_object('id', pg_temp.uid(713), 'agent_message_id', pg_temp.uid(714), 'message_key', 'k713', 'instrument_id', pg_temp.uid(422))), 'w'),
  'E23503|%', 'C7 check 13 / AC-0B-3.5: device a201 cannot insert a message with an a202 instrument (composite FK)');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), pg_temp.cpb('instruments.messages', 'id = ' || quote_literal(pg_temp.uid(507)), jsonb_build_object('id', pg_temp.uid(715), 'agent_message_id', pg_temp.uid(716), 'message_key', 'k715')), 'w'), 'n=1',
  'C7 check 13: control: device a201 can insert a message of its own centre/instrument/agent');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'UPDATE instruments.agents SET display_name = ''x'' WHERE id = ' || quote_literal(pg_temp.uid(402)), 'w'), 'n=0', 'AC-0B-3.3: device a201 updates 0 a202 agents');
-- centre-bound FKs (review #26): child centre must equal the message centre; records need an instrument of the same centre
SELECT alike(pg_temp.a(pg_temp.cpb('instruments.processing_runs', 'id = ' || quote_literal(pg_temp.uid(517)), jsonb_build_object('id', pg_temp.uid(721), 'message_id', pg_temp.uid(508), 'run_no', 2)), 'w'),
  'E23503|%', 'C7 check 13: processing_runs.centre_id must equal its message centre (a201 run on an a202 message)');
SELECT alike(pg_temp.a(pg_temp.cpb('instruments.message_duplicates', 'id = ' || quote_literal(pg_temp.uid(543)), jsonb_build_object('id', pg_temp.uid(722), 'agent_message_id', pg_temp.uid(723), 'centre_id', pg_temp.id('00000000a202'))), 'w'),
  'E23503|%', 'C7 check 13: message_duplicates.centre_id must equal the original message centre');
SELECT alike(pg_temp.a(pg_temp.cpb('instruments.attachments', 'id = ' || quote_literal(pg_temp.uid(563)), jsonb_build_object('id', pg_temp.uid(724), 'message_id', pg_temp.uid(508))), 'w'),
  'E23503|%', 'C7 check 13: attachments.centre_id must equal its message centre');
SELECT alike(pg_temp.a(pg_temp.cpb('instruments.message_records', 'id = ' || quote_literal(pg_temp.uid(529)), jsonb_build_object('id', pg_temp.uid(725), 'record_seq', 9, 'centre_id', pg_temp.id('00000000a202'))), 'w'),
  'E23503|%', 'C7 check 13: message_records.centre_id must equal its message centre');
SELECT alike(pg_temp.a(pg_temp.cpb('instruments.message_records', 'id = ' || quote_literal(pg_temp.uid(529)), jsonb_build_object('id', pg_temp.uid(726), 'record_seq', 10, 'instrument_id', pg_temp.uid(422))), 'w'),
  'E23503|%', 'C7 check 13: a message_records row whose instrument belongs to another centre fails');
SELECT alike(pg_temp.a(pg_temp.cpb('instruments.instrument_status', 'instrument_id = ' || quote_literal(pg_temp.uid(421)), jsonb_build_object('instrument_id', pg_temp.uid(423), 'centre_id', pg_temp.id('00000000a202'))), 'w'),
  'E23503|%', 'C7 check 13: instrument_status.centre_id must equal the instrument centre');

-- C7 check 14: secret_sha256 column privilege + append-only grants (spec §8 item 4; AC-0B-4.2 / 4.3)
SELECT alike(pg_temp.a('SELECT secret_sha256 FROM instruments.agent_credentials', 'n'), 'E42501|%', 'C7 check 14: lims_app cannot SELECT secret_sha256');
SELECT alike(pg_temp.a('SELECT * FROM instruments.agent_credentials', 'n'), 'E42501|%', 'C7 check 14: SELECT * on agent_credentials is refused (it includes secret_sha256)');
SELECT alike(pg_temp.a('SELECT 1 FROM instruments.agent_credentials WHERE secret_sha256 = ' || quote_literal(pg_temp.by('a1')) || '::bytea', 'n'), 'E42501|%', 'C7 check 14: lims_app cannot probe secret_sha256 in a WHERE clause either');
SELECT is(pg_temp.a('SELECT kind || status FROM instruments.agent_credentials WHERE id = ' || quote_literal(pg_temp.uid(431)), 's'), 'device_tokenactive', 'C7 check 14: control: the other columns are readable');
SELECT alike(pg_temp.a('UPDATE instruments.agent_credentials SET secret_sha256 = ' || quote_literal(pg_temp.by('ff')) || '::bytea WHERE id = ' || quote_literal(pg_temp.uid(431)), 'w'), 'E42501|%', 'C7 check 14: lims_app cannot UPDATE secret_sha256');
SELECT alike(pg_temp.a('DELETE FROM instruments.' || split_part(tt.q, '.', 2), 'w'), 'E42501|%', 'C7 check 14 / AC-0B-4.2: lims_app has no DELETE on ' || tt.q) FROM tt;
SELECT alike(pg_temp.a('UPDATE instruments.' || split_part(atb.q, '.', 2) || ' SET created_by = created_by', 'w'), 'E42501|%', 'C7 check 14 / AC-0B-4.3: no UPDATE grant on A table ' || atb.q) FROM atb;
SELECT alike(pg_temp.a('DELETE FROM instruments.' || t, 'w'), 'E42501|%', 'C7 check 14 / AC-0B-4.2: no DELETE on G table instruments.' || t) FROM unnest(ARRAY['g_drivers','g_agent_releases','g_cs_revoke_reasons','g_cs_reprocess_reasons']) t;
SELECT alike(pg_temp.a('INSERT INTO instruments.g_drivers (code, display_name, protocol, status, driver_version) VALUES (''zz_test'', ''x'', ''astm'', ''generic'', ''1'')', 'w'), 'E42501|%', 'C7 check 14: lims_app cannot write G tables');
SELECT is(pg_temp.a('SELECT 1 FROM instruments.g_drivers', 'n'), 'n=7', 'C7 check 14: lims_app reads the 7 seeded drivers (G tables are RLS-exempt; truth_h80e added by H80-T05, getein_metis by MET-T04)');
SELECT alike(pg_temp.a('INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_type) VALUES (gen_random_uuid(), ' || quote_literal(pg_temp.ta()) || ', ''instruments'', ''agents'', ''INSERT'', ''system'')', 'w'), 'E42501|%',
  'AC-0B-5.3: lims_app cannot insert audit rows directly');

-- C7 check 15: device-credential resolver (spec §8 items 5 and 9a, 9c; 08 A12.1)
SELECT is(pg_temp.rs(pg_temp.by('a1')), 'device_token:' || pg_temp.ta() || ':' || pg_temp.uid(401) || ':' || pg_temp.id('00000000a201'), 'C7 check 15: active device token of an active agent resolves (tenant, agent, centre, kind)');
SELECT is(pg_temp.rs(pg_temp.by('a2')), 'enrolment_code:' || pg_temp.ta() || ':' || pg_temp.uid(402) || ':' || pg_temp.id('00000000a202'), 'C7 check 15: unexpired enrolment code of a pending agent resolves');
SELECT is(pg_temp.rs(pg_temp.by('a3')), '<none>', 'C7 check 15: enrolment code past expires_at -> 0 rows');
SELECT is(pg_temp.rs(pg_temp.by('a4')), '<none>', 'C7 check 15: device token of a revoked agent -> 0 rows');
SELECT is(pg_temp.rs(pg_temp.by('a6')), 'enrolment_code:' || pg_temp.ta() || ':' || pg_temp.uid(404) || ':' || pg_temp.id('00000000a201'), 'C7 check 15: enrolment code of a revoked agent resolves (re-enrolment A5)');
SELECT is(pg_temp.rs(pg_temp.by('a7')), '<none>', 'C7 check 15: revoked credential -> 0 rows');
SELECT is(pg_temp.rs(pg_temp.by('b1')), 'device_token:' || pg_temp.tb() || ':' || pg_temp.uid(403) || ':' || pg_temp.id('00000000b201'), 'C7 check 15: tenant-B token resolves to tenant B (no tenant known beforehand)');
SELECT is(pg_temp.rs(pg_temp.by('99')), '<none>', 'C7 check 15: a random 32-byte value -> 0 rows');
SELECT is(pg_temp.rs('\x0102'), '<none>', 'C7 check 15: a value of the wrong length -> 0 rows');
SELECT is(pg_temp.rs(NULL), '<none>', 'C7 check 15: NULL -> 0 rows');
SELECT is(pg_temp.guc_empty('app.pre_device_secret_sha256'), true, 'C7 check 15 (spec §8 item 9c): app.pre_device_secret_sha256 is '''' after the resolver returned');
SELECT is(pg_temp.guc_empty('app.pre_device_agent_id'), true, 'C7 check 15 (spec §8 item 9c): app.pre_device_agent_id is '''' after the resolver returned');
SELECT is(pg_temp.rs(pg_temp.by('a1')) <> '<none>', true, 'C7 check 15: the resolver works again after a reset (GUC state does not leak)');
-- 9a/9b: the owner policies return nothing when the GUC is unset; a lims_app session that sets the GUCs itself gains nothing
SELECT is(pg_temp.x('lims_owner', NULL, 'SELECT 1 FROM instruments.agent_credentials', 'n'), 'n=0', 'C7 check 15 (item 5): owner policy returns nothing when app.pre_device_secret_sha256 is unset');
SELECT is(pg_temp.x('lims_owner', NULL, 'SELECT 1 FROM instruments.agents', 'n'), 'n=0', 'C7 check 15: owner policy on agents returns nothing when the GUCs are unset');
SELECT set_config('app.pre_device_secret_sha256', encode(decode(repeat('a1', 32), 'hex'), 'hex'), true), set_config('app.pre_device_agent_id', pg_temp.uid(401)::text, true);
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM instruments.agent_credentials', 'n'), 'n=0', 'C7 check 15 (item 9b): lims_app with no claims that sets app.pre_device_secret_sha256 itself sees 0 credential rows');
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM instruments.agents', 'n'), 'n=0', 'C7 check 15 (item 9b): lims_app with no claims that sets app.pre_device_agent_id itself sees 0 agent rows');
SELECT is(pg_temp.b('SELECT 1 FROM instruments.agent_credentials WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'C7 check 15 (item 9b): tenant-B session with the A-secret GUC set still sees 0 tenant-A credentials');
SELECT is(pg_temp.b('SELECT 1 FROM instruments.agents WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'C7 check 15 (item 9b): tenant-B session with the A-agent GUC set still sees 0 tenant-A agents');
SELECT set_config('app.pre_device_secret_sha256', '', true), set_config('app.pre_device_agent_id', '', true);

-- C7 check 16: snapshot DEFINER, GUC isolation, EXECUTE privileges (spec §8 items 9, 10)
SELECT is(pg_temp.x('lims_worker', NULL, 'SELECT count(*) FROM app.instruments_agent_state_snapshot()', 's'), '3', 'C7 check 16: snapshot returns the 3 non-retired agents with a status row, across tenants, without tenant claims');
SELECT is(pg_temp.x('lims_worker', NULL, 'SELECT queue_depth || ''/'' || coalesce(silent_instrument_count, -1) || ''/'' || health_state FROM app.instruments_agent_state_snapshot() WHERE agent_id = ' || quote_literal(pg_temp.uid(401)), 's'), '7/0/online',
  'C7 check 16: snapshot columns (queue_depth, silent_instrument_count, health_state) for A1');
SELECT is(pg_temp.x('lims_worker', NULL, 'SELECT count(*) FROM app.instruments_agent_state_snapshot() WHERE agent_id = ' || quote_literal(pg_temp.uid(405)), 's'), '0', 'C7 check 16: retired agents are not in the snapshot');
SELECT is(pg_temp.guc_empty('app.maintenance'), true, 'C7 check 16 (item 9c): app.maintenance is '''' after the snapshot returned');
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), 'SELECT count(*) FROM app.instruments_agent_state_snapshot()', 's'), 'E42501|%', 'C7 check 16 (item 10): lims_app cannot execute the snapshot');
SELECT alike(pg_temp.x('lims_api', pg_temp.cl(pg_temp.ta()), 'SELECT count(*) FROM app.instruments_agent_state_snapshot()', 's'), 'E42501|%', 'C7 check 16 (item 10): lims_api cannot execute the snapshot');
SELECT alike(pg_temp.x('lims_worker', NULL, 'SELECT count(*) FROM app.instruments_resolve_device_credential(' || quote_literal(pg_temp.by('a1')) || '::bytea)', 's'), 'E42501|%', 'C7 check 16 (item 10): lims_worker cannot execute the resolver');
SELECT alike(pg_temp.x('lims_app', NULL, 'SELECT count(*) FROM app.instruments_resolve_device_credential(' || quote_literal(pg_temp.by('a1')) || '::bytea)', 's'), 'E42501|%', 'C7 check 16 (item 10): lims_app cannot execute the resolver');
SELECT set_config('app.maintenance', 'instruments_agent_state_snapshot', true);
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM instruments.agent_status', 'n'), 'n=0', 'C7 check 16 (item 9b): lims_app that sets app.maintenance = instruments_agent_state_snapshot itself sees 0 agent_status rows (no claims)');
SELECT is(pg_temp.b('SELECT 1 FROM instruments.agent_status WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'C7 check 16 (item 9b): ... and a tenant-B session sees 0 tenant-A agent_status rows');
SELECT is(pg_temp.b('SELECT 1 FROM instruments.agents WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'C7 check 16 (item 9b): ... and 0 tenant-A agents');
SELECT set_config('app.maintenance', 'purge_instruments_archive', true);
SELECT is(pg_temp.a('SELECT 1 FROM instruments.messages WHERE id = ' || quote_literal(pg_temp.uid(509)), 'n'), 'n=0', 'C7 check 16 (item 9b): tenant A with app.maintenance = purge_instruments_archive sees 0 tenant-B messages');
SELECT alike(pg_temp.a('DELETE FROM instruments.messages', 'w'), 'E42501|%', 'C7 check 16 (item 9b): lims_app that sets app.maintenance = purge_instruments_archive itself can delete nothing');
SELECT alike(pg_temp.x('lims_api', pg_temp.cl(pg_temp.ta()), 'SELECT * FROM app.purge_instruments_archive(366)', 'n'), 'E42501|%', 'C7 check 16 (item 10): lims_api cannot execute the purge');
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), 'SELECT * FROM app.purge_instruments_archive(366)', 'n'), 'E42501|%', 'C7 check 16 (item 10): lims_app cannot execute the purge');
SELECT set_config('app.maintenance', '', true);

-- C7 check 17: archive purge (spec §8 item 7; FORCE RLS on, never disabled; 08 A10.5, A13 P-6 / D-42)
CREATE TEMP TABLE bcnt AS SELECT (SELECT count(*) FROM instruments.messages WHERE tenant_id = pg_temp.tb()) AS msg, (SELECT count(*) FROM instruments.processing_runs WHERE tenant_id = pg_temp.tb()) AS run,
  (SELECT count(*) FROM instruments.message_records WHERE tenant_id = pg_temp.tb()) AS rec, (SELECT count(*) FROM instruments.message_duplicates WHERE tenant_id = pg_temp.tb()) AS dup,
  (SELECT count(*) FROM instruments.message_rejections WHERE tenant_id = pg_temp.tb()) AS rej, (SELECT count(*) FROM instruments.attachments WHERE tenant_id = pg_temp.tb()) AS att,
  (SELECT count(*) FROM instruments.agent_log_bundles WHERE tenant_id = pg_temp.tb()) AS bun, (SELECT count(*) FROM instruments.agent_commands WHERE tenant_id = pg_temp.tb()) AS cmd,
  (SELECT count(*) FROM instruments.agent_health_transitions WHERE tenant_id = pg_temp.tb()) AS hth, (SELECT count(*) FROM instruments.observed_codes WHERE tenant_id = pg_temp.tb()) AS obs;
CREATE TEMP TABLE mc0 AS SELECT count(*) AS n FROM instruments.messages;
SELECT is(pg_temp.x('lims_worker', pg_temp.cl(pg_temp.ta()), 'SELECT count(*) FROM app.purge_instruments_archive(364)', 's') LIKE 'EP0001|%', true, 'C7 check 17: p_raw_retention_days = 364 raises (365-day floor, 04 I8)');
SELECT is(pg_temp.x('lims_worker', pg_temp.cl(pg_temp.ta()), 'SELECT count(*) FROM app.purge_instruments_archive(NULL)', 's') LIKE 'EP0001|%', true, 'C7 check 17: p_raw_retention_days = NULL raises');
SELECT is(pg_temp.x('lims_worker', NULL, 'SELECT count(*) FROM app.purge_instruments_archive(366)', 's') LIKE 'EP0001|%', true, 'C7 check 17: a call without tenant claims raises (one tenant per call)');
SELECT is((SELECT count(*)::int FROM instruments.messages), (SELECT n::int FROM mc0), 'C7 check 17: the three refused calls deleted nothing');
CREATE TEMP TABLE pr AS SELECT pg_temp.x('lims_worker', pg_temp.cl(pg_temp.ta()), 'SELECT jsonb_object_agg(table_name, deleted)::text FROM app.purge_instruments_archive(366)', 's')::jsonb AS j;
SELECT is((SELECT (j->>t)::int > 0 FROM pr), true, 'C7 check 17: under tenant-A system claims purge_instruments_archive(366) deleted rows from ' || t) FROM unnest(ARRAY['message_records','attachments','message_duplicates','processing_runs','messages',
  'message_rejections','agent_log_bundles','agent_commands','agent_health_transitions','observed_codes']) t;
SELECT is(pg_temp.guc_empty('app.maintenance'), true, 'C7 check 17 (item 9c): app.maintenance is '''' after the purge returned');
SELECT is((SELECT count(*)::int FROM instruments.messages WHERE id IN (SELECT pg_temp.uid(n) FROM unnest(ARRAY[501, 503]) n)), 0, 'C7 check 17: expired messages 501 and 503 are purged');
SELECT is((SELECT count(*)::int FROM instruments.messages WHERE id = pg_temp.uid(502)) + (SELECT count(*)::int FROM instruments.attachments WHERE id = pg_temp.uid(561)), 2, 'C7 check 17: expired message 502 and its attachment row are kept until the object path is marked #deleted');
SELECT is((SELECT count(*)::int FROM instruments.attachments WHERE id = pg_temp.uid(562)), 0, 'C7 check 17: the attachment row whose path is marked #deleted is purged (and its message with it)');
SELECT is((SELECT count(*)::int FROM instruments.messages WHERE id IN (SELECT pg_temp.uid(n) FROM unnest(ARRAY[504, 505, 506, 507, 508]) n)), 5, 'C7 check 17: younger messages (<= 95 d) are kept');
SELECT is((SELECT count(*)::int FROM instruments.message_records WHERE id IN (SELECT pg_temp.uid(n) FROM unnest(ARRAY[524, 527, 528]) n)), 0, 'C7 check 17 (review #4): records of the 95-day and 91-day messages are purged, source + derived together, without an FK error');
SELECT is((SELECT count(*)::int FROM instruments.message_records WHERE id IN (SELECT pg_temp.uid(n) FROM unnest(ARRAY[525, 526, 529, 531]) n)), 4, 'C7 check 17 (review #4): records of the 89-day message (incl. the re-match-derived one) and of recent messages are kept');
SELECT is((SELECT count(*)::int FROM instruments.processing_runs WHERE id = pg_temp.uid(511)), 0, 'C7 check 17: the run of a purged message is purged');
SELECT is((SELECT count(*)::int FROM instruments.message_duplicates WHERE id IN (SELECT pg_temp.uid(n) FROM unnest(ARRAY[541, 542]) n)), 0, 'C7 check 17: duplicates of a purged message and duplicates older than 90 d are purged');
SELECT is((SELECT count(*)::int FROM instruments.message_duplicates WHERE id = pg_temp.uid(543)) + (SELECT count(*)::int FROM instruments.message_rejections WHERE id = pg_temp.uid(552)), 2, 'C7 check 17: recent duplicate and rejection are kept');
SELECT is((SELECT count(*)::int FROM instruments.message_rejections WHERE id = pg_temp.uid(551)) + (SELECT count(*)::int FROM instruments.agent_log_bundles WHERE id = pg_temp.uid(481)) + (SELECT count(*)::int FROM instruments.agent_commands WHERE id = pg_temp.uid(471))
  + (SELECT count(*)::int FROM instruments.agent_health_transitions WHERE id = pg_temp.uid(451)) + (SELECT count(*)::int FROM instruments.observed_codes WHERE instrument_analyte_code = 'WBC' AND tenant_id = pg_temp.ta()), 0,
  'C7 check 17: old rejection, log bundle (30 d), completed command (90 d, after its bundle), health transition (400 d) and unseen observed code (400 d) are purged');
SELECT is((SELECT count(*)::int FROM instruments.agent_commands WHERE id IN (SELECT pg_temp.uid(n) FROM unnest(ARRAY[472, 473, 474]) n)) + (SELECT count(*)::int FROM instruments.agent_health_transitions WHERE id = pg_temp.uid(452))
  + (SELECT count(*)::int FROM instruments.observed_codes WHERE instrument_analyte_code = 'RBC' AND tenant_id = pg_temp.ta()), 5, 'C7 check 17: queued / recent commands, recent transition and recent observed code are kept');
SELECT is((SELECT row(msg, run, rec, dup, rej, att, bun, cmd, hth, obs)::text FROM bcnt),
  (SELECT row((SELECT count(*) FROM instruments.messages WHERE tenant_id = pg_temp.tb()), (SELECT count(*) FROM instruments.processing_runs WHERE tenant_id = pg_temp.tb()), (SELECT count(*) FROM instruments.message_records WHERE tenant_id = pg_temp.tb()),
    (SELECT count(*) FROM instruments.message_duplicates WHERE tenant_id = pg_temp.tb()), (SELECT count(*) FROM instruments.message_rejections WHERE tenant_id = pg_temp.tb()), (SELECT count(*) FROM instruments.attachments WHERE tenant_id = pg_temp.tb()),
    (SELECT count(*) FROM instruments.agent_log_bundles WHERE tenant_id = pg_temp.tb()), (SELECT count(*) FROM instruments.agent_commands WHERE tenant_id = pg_temp.tb()), (SELECT count(*) FROM instruments.agent_health_transitions WHERE tenant_id = pg_temp.tb()),
    (SELECT count(*) FROM instruments.observed_codes WHERE tenant_id = pg_temp.tb()))::text), 'C7 check 17: tenant-B rows of the same age are untouched (one tenant per call)');
SELECT is((SELECT msg + run + rec + dup + rej + att + bun + cmd + hth + obs FROM bcnt) > 0, true, 'C7 check 17: control: tenant B had purge-eligible rows');
SELECT is(pg_temp.x('lims_worker', pg_temp.cl(pg_temp.tb()), 'SELECT jsonb_object_agg(table_name, deleted)::text FROM app.purge_instruments_archive(366)', 's')::jsonb ? 'messages', true, 'C7 check 17: the same function purges tenant B under tenant-B claims');
SELECT is((SELECT count(*)::int FROM instruments.message_records WHERE tenant_id = pg_temp.tb()) + (SELECT count(*)::int FROM instruments.message_duplicates WHERE tenant_id = pg_temp.tb()), 0, 'C7 check 17: tenant-B expired records and duplicates are purged by the tenant-B call');
SELECT is((SELECT count(*)::int FROM instruments.messages WHERE id = pg_temp.uid(509)) + (SELECT count(*)::int FROM instruments.attachments WHERE id = pg_temp.uid(564)), 2, 'C7 check 17: tenant-B message with a live attachment object is kept');

-- C7 check 18: mutability, transitions, audit, views (spec §8 items 6, 8; AC-0B-4.1, 5.1, 5.2)
-- mutable-column lists (§2.2, §2.6, §2.15, §4)
SELECT alike(pg_temp.a('UPDATE instruments.agent_credentials SET kind = ''enrolment_code'' WHERE id = ' || quote_literal(pg_temp.uid(431))), 'EP0001|immutable_row%', 'C7 check 18 / AC-0B-4.1: agent_credentials.kind is frozen');
SELECT alike(pg_temp.a('UPDATE instruments.agent_credentials SET expires_at = now() WHERE id = ' || quote_literal(pg_temp.uid(431))), 'EP0001|immutable_row%', 'AC-0B-4.1: agent_credentials.expires_at is frozen');
SELECT alike(pg_temp.a('UPDATE instruments.attachments SET size_bytes = 5 WHERE id = ' || quote_literal(pg_temp.uid(563))), 'EP0001|immutable_row%', 'AC-0B-4.1: attachments.size_bytes is frozen');
SELECT alike(pg_temp.a('UPDATE instruments.attachments SET mime_type = ''image/png'' WHERE id = ' || quote_literal(pg_temp.uid(563))), 'EP0001|immutable_row%', 'AC-0B-4.1: attachments.mime_type is frozen');
SELECT is(pg_temp.a('UPDATE instruments.attachments SET sha256 = repeat(''d'', 64) WHERE id = ' || quote_literal(pg_temp.uid(563))), 'n=1', 'AC-0B-4.1: attachments.sha256 is mutable (PDF sanitisation)');
SELECT alike(pg_temp.a('UPDATE instruments.agent_commands SET kind = ''restart_service'' WHERE id = ' || quote_literal(pg_temp.uid(472))), 'EP0001|immutable_row%', 'AC-0B-4.1: agent_commands.kind is frozen');
SELECT alike(pg_temp.a('UPDATE instruments.agents SET agent_code = ''AG-ZZ'' WHERE id = ' || quote_literal(pg_temp.uid(401))), 'EP0001|immutable_row%', 'AC-0B-4.1: agents.agent_code is frozen');
SELECT alike(pg_temp.a('UPDATE instruments.agents SET centre_id = ' || quote_literal(pg_temp.id('00000000a202')) || ' WHERE id = ' || quote_literal(pg_temp.uid(401))), 'EP0001|immutable_row%', 'AC-0B-4.1: agents.centre_id is frozen');
SELECT is(pg_temp.a('UPDATE instruments.agents SET display_name = ''Renamed'', backlog_threshold = 100 WHERE id = ' || quote_literal(pg_temp.uid(401))), 'n=1', 'AC-0B-4.1: agents.display_name / backlog_threshold are mutable');
SELECT alike(pg_temp.a('UPDATE instruments.instruments SET instrument_code = ''IN-ZZ'' WHERE id = ' || quote_literal(pg_temp.uid(421))), 'EP0001|immutable_row%', 'AC-0B-4.1: instruments.instrument_code is frozen');
SELECT alike(pg_temp.a('UPDATE instruments.instruments SET protocol = ''hl7v2'' WHERE id = ' || quote_literal(pg_temp.uid(421))), 'EP0001|immutable_row%', 'AC-0B-4.1: instruments.protocol is frozen');
SELECT alike(pg_temp.a('UPDATE instruments.instruments SET agent_id = ' || quote_literal(pg_temp.uid(412)) || ' WHERE id = ' || quote_literal(pg_temp.uid(421))), 'EP0001|immutable_row%', 'AC-0B-4.1: instruments.agent_id is frozen');
SELECT is(pg_temp.a('UPDATE instruments.instruments SET display_name = ''Renamed'', model = ''SX-2'' WHERE id = ' || quote_literal(pg_temp.uid(421))), 'n=1', 'AC-0B-4.1: instruments.display_name / model are mutable');
-- forbidden transitions raise P0001 invalid_transition (03-APP-FLOW §2); allowed ones pass (spec §8 item 6)
SELECT alike(pg_temp.a('UPDATE instruments.agents SET status = ''active'' WHERE id = ' || quote_literal(pg_temp.uid(413))), 'EP0001|%invalid_transition%', 'C7 check 18: agent retired -> active is forbidden');
SELECT alike(pg_temp.a('UPDATE instruments.agents SET status = ''pending_enrolment'' WHERE id = ' || quote_literal(pg_temp.uid(412))), 'EP0001|%invalid_transition%', 'C7 check 18: agent active -> pending_enrolment is forbidden');
SELECT alike(pg_temp.a('UPDATE instruments.agents SET status = ''revoked'' WHERE id = ' || quote_literal(pg_temp.uid(413))), 'EP0001|%invalid_transition%', 'C7 check 18: agent retired -> revoked is forbidden (E15 on retired)');
SELECT is(pg_temp.a('UPDATE instruments.agents SET status = ''active'', enrolled_at = now() WHERE id = ' || quote_literal(pg_temp.uid(411))), 'n=1', 'C7 check 18: agent pending_enrolment -> active is allowed (A2)');
SELECT is(pg_temp.a('UPDATE instruments.agents SET status = ''revoked'', revoked_at = now(), revoke_reason_code = ''other'' WHERE id = ' || quote_literal(pg_temp.uid(412))), 'n=1', 'C7 check 18: agent active -> revoked is allowed (A4)');
SELECT is(pg_temp.a('UPDATE instruments.agents SET status = ''retired'', retired_at = now() WHERE id = ' || quote_literal(pg_temp.uid(412))), 'n=1', 'C7 check 18: agent revoked -> retired is allowed (A6)');
SELECT alike(pg_temp.a('UPDATE instruments.instruments SET state = ''live'', live_at = now(), go_live_checklist = ''{}'' WHERE id = ' || quote_literal(pg_temp.uid(423))), 'EP0001|%invalid_transition%', 'C7 check 18: instrument draft -> live is forbidden (needs commissioning)');
SELECT alike(pg_temp.a('UPDATE instruments.instruments SET state = ''draft'' WHERE id = ' || quote_literal(pg_temp.uid(421))), 'EP0001|%invalid_transition%', 'C7 check 18: instrument live -> draft is forbidden');
SELECT alike(pg_temp.a('UPDATE instruments.instruments SET state = ''live'', live_at = now(), go_live_checklist = ''{}'' WHERE id = ' || quote_literal(pg_temp.uid(424))), 'EP0001|%invalid_transition%', 'C7 check 18: instrument retired -> live is forbidden');
SELECT is(pg_temp.a('UPDATE instruments.instruments SET state = ''commissioning'', commissioned_at = now() WHERE id = ' || quote_literal(pg_temp.uid(423))), 'n=1', 'C7 check 18: instrument draft -> commissioning is allowed (I2)');
SELECT is(pg_temp.a('UPDATE instruments.instruments SET state = ''suspended'', suspended_at = now() WHERE id = ' || quote_literal(pg_temp.uid(421))), 'n=1', 'C7 check 18: instrument live -> suspended is allowed (I4)');
SELECT is(pg_temp.a('UPDATE instruments.instruments SET state = ''retired'', retired_at = now() WHERE id = ' || quote_literal(pg_temp.uid(421))), 'n=1', 'C7 check 18: instrument suspended -> retired is allowed (I6)');
SELECT alike(pg_temp.a('UPDATE instruments.agent_credentials SET status = ''active'' WHERE id = ' || quote_literal(pg_temp.uid(439))), 'EP0001|%invalid_transition%', 'C7 check 18: credential used -> active is forbidden (terminal)');
SELECT alike(pg_temp.a('UPDATE instruments.agent_credentials SET status = ''active'' WHERE id = ' || quote_literal(pg_temp.uid(436))), 'EP0001|%invalid_transition%', 'C7 check 18: credential revoked -> active is forbidden (terminal)');
SELECT is(pg_temp.a('UPDATE instruments.agent_credentials SET status = ''used'', used_at = now() WHERE id = ' || quote_literal(pg_temp.uid(440))), 'n=1', 'C7 check 18: credential enrolment code active -> used is allowed');
SELECT is(pg_temp.a('UPDATE instruments.agent_credentials SET status = ''revoked'', revoked_at = now(), revoke_reason_code = ''other'' WHERE id = ' || quote_literal(pg_temp.uid(438))), 'n=1', 'C7 check 18: credential active -> revoked is allowed');
SELECT alike(pg_temp.a('UPDATE instruments.agent_commands SET state = ''queued'' WHERE id = ' || quote_literal(pg_temp.uid(474))), 'EP0001|%invalid_transition%', 'C7 check 18: command completed -> queued is forbidden');
SELECT is(pg_temp.a('UPDATE instruments.agent_commands SET state = ''delivered'', delivered_at = now() WHERE id = ' || quote_literal(pg_temp.uid(472))), 'n=1', 'C7 check 18: command queued -> delivered is allowed');
SELECT is(pg_temp.a('UPDATE instruments.agent_commands SET state = ''completed'', completed_at = now(), result_code = ''ok'' WHERE id = ' || quote_literal(pg_temp.uid(472))), 'n=1', 'C7 check 18: command delivered -> completed is allowed');
SELECT is(pg_temp.a('UPDATE instruments.agent_commands SET state = ''expired'' WHERE id = ' || quote_literal(pg_temp.uid(473))), 'n=1', 'C7 check 18: command queued -> expired is allowed');
SELECT alike(pg_temp.a('UPDATE instruments.attachments SET scan_state = ''pending'' WHERE id = ' || quote_literal(pg_temp.uid(563))), 'EP0001|%invalid_transition%', 'C7 check 18: attachment clean -> pending is forbidden (terminal)');
SELECT is(pg_temp.a('UPDATE instruments.attachments SET scan_state = ''quarantined'', scanned_at = now() WHERE id = ' || quote_literal(pg_temp.uid(561))), 'n=1', 'C7 check 18: attachment pending -> quarantined is allowed');
SELECT alike(pg_temp.a('UPDATE instruments.attachments SET scan_state = ''clean'' WHERE id = ' || quote_literal(pg_temp.uid(561))), 'EP0001|%invalid_transition%', 'C7 check 18: attachment quarantined -> clean is forbidden (terminal)');
-- audit (AC-0B-5.1, 5.2): the secret never reaches audit_log; UPDATE rows carry only the changed columns
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'instruments' AND table_name = 'agent_credentials') > 0, true, 'C7 check 18 / AC-0B-5.1: agent_credentials writes are audited');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'instruments' AND table_name = 'agent_credentials' AND (coalesce(new_values, '{}'::jsonb) ? 'secret_sha256' OR coalesce(old_values, '{}'::jsonb) ? 'secret_sha256' OR 'secret_sha256' = ANY (changed_columns))), 0,
  'C7 check 18 / AC-0B-5.1: no audit_log row holds secret_sha256 (excluded-column trigger argument)');
SELECT is((SELECT changed_columns FROM audit.audit_log WHERE schema_name = 'instruments' AND table_name = 'agent_credentials' AND action = 'UPDATE' AND row_id = pg_temp.uid(440) ORDER BY occurred_at DESC LIMIT 1) @> ARRAY['status','used_at'], true,
  'C7 check 18 / AC-0B-5.2: the credential UPDATE audit row lists the changed columns (status, used_at)');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'instruments' AND table_name IN ('agent_status','instrument_status','messages','processing_runs','message_records','message_duplicates','message_rejections','agent_health_transitions','agent_config_versions','agent_log_bundles','observed_codes')), 0,
  'C7 check 18 / AC-0B-5.1: E and A tables write no audit rows');
-- published views are security_invoker and centre-filtered (spec §8 item 8)
SELECT is(pg_temp.a('SELECT 1 FROM instruments.v_pub_agent_status', 'n'), 'n=2', 'C7 check 18: v_pub_agent_status shows the 2 non-retired agents with status of tenant A (system) - A4 retired hidden');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM instruments.v_pub_agent_status'), 'n=1', 'C7 check 18 / AC-0B-3.4: device a201 sees only A1 in v_pub_agent_status');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM instruments.v_pub_agent_status WHERE centre_id = ' || quote_literal(pg_temp.id('00000000a201'))), 'n=0', 'C7 check 18: a202 reader sees no a201 row of v_pub_agent_status');
SELECT is(pg_temp.a('SELECT state || ''/'' || queue_depth || ''/'' || clock_offset_seconds || ''/'' || agent_version FROM instruments.v_pub_agent_status WHERE agent_id = ' || quote_literal(pg_temp.uid(401)), 's'), 'online/7/4/0.1.0',
  'C7 check 18: v_pub_agent_status maps health_state -> state and clock_offset_ms -> seconds (4500 ms -> 4)');
SELECT is(pg_temp.b('SELECT 1 FROM instruments.v_pub_agent_status', 'n'), 'n=1', 'C7 check 18: tenant B sees only its own agent in the view');
SELECT is(pg_temp.dev(pg_temp.id('00000000a201'), 'SELECT 1 FROM instruments.v_pub_message_daily WHERE centre_id = ' || quote_literal(pg_temp.id('00000000a202'))), 'n=0', 'C7 check 18: a201 reader sees no a202 row of v_pub_message_daily');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM instruments.v_pub_message_daily'), 'n=1', 'C7 check 18: a202 reader sees its one daily row');
SELECT is(pg_temp.a('SELECT messages || ''/'' || patient_records || ''/'' || qc_records || ''/'' || unmatched || ''/'' || quarantined FROM instruments.v_pub_message_daily WHERE instrument_id = ' || quote_literal(pg_temp.uid(421))
  || ' AND business_date = (now() AT TIME ZONE ''Asia/Kathmandu'')::date', 's'), '2/3/1/2/1', 'C7 check 18: v_pub_message_daily counters come from the latest processing run (unmatched = unmapped + skipped_no_barcode); 2 messages today: 507 with its run, 715 from the device test without a run');
SELECT is(pg_temp.dev(pg_temp.id('00000000a202'), 'SELECT 1 FROM instruments.v_pub_instrument_directory'), 'n=1', 'C7 check 18: a202 reader sees only instrument IN-A2 in v_pub_instrument_directory');
SELECT is(pg_temp.b('SELECT 1 FROM instruments.v_pub_instrument_directory WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'C7 check 18: tenant B sees 0 tenant-A directory rows');

SELECT * FROM finish();
ROLLBACK;
