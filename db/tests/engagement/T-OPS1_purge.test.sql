-- C16.T-OPS1 live-DB assertions under FORCE RLS: 05-SCHEMA §6.6 test 5 (purge DEFINERs) + class-E retention deletes by the system actor (§5.3, §9; 08 A12.7, A17 P-18(c), A19 P-41/D-121).
-- Synthetic data only. One rolled-back transaction. RLS is never disabled for the assertions (rows are seeded with session_replication_role = replica, as the isolation probes do;
-- CHECK constraints still apply, so every seeded row is valid). Counts are read as the superuser (bypasses RLS) so they show the truth, not a policy-filtered view.
-- Run: pg_prove -d <migrated db with the engagement DDL> db/tests/engagement/T-OPS1_purge.test.sql   (superuser; pgTAP in schema `extensions`; run from the repo root)
-- Needs a live Postgres with C0 + C16 migrations; it is NOT part of .orchestra/notes/T-OPS1-verify.cmd (no database in the unit-test environment).
-- Fails now: engagement.purge_queue() / engagement.purge_payment_requests() and the class-E __delete__tenant policies do not exist in the migrated schema.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\ir ../fixtures/T0B-06_identity_standin.sql

CREATE FUNCTION pg_temp.id(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01950c16-0000-7000-8000-' || lpad(to_hex(k), 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.h(k int) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT sha256(convert_to('synthetic-ops1-' || k, 'UTF8')) $$;
-- claims of actor type p_type in tenant #p_tenant (1 = A, 2 = B)
CREATE FUNCTION pg_temp.cl(p_type text, p_tenant int) RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', pg_temp.id(p_tenant), 'sub', pg_temp.id(99))::text $$;
-- run p_sql as p_role with p_claims; optional p_pre first (the "attacker" setting a GUC itself). modes: v scalar text, n row count of a SELECT, w DML row count. Errors -> 'E<SQLSTATE>:<message>'.
CREATE FUNCTION pg_temp.x(p_role text, p_claims text, p_pre text, p_sql text, p_mode text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_pre IS NOT NULL THEN EXECUTE p_pre; END IF;
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSIF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := n::text;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := n::text; END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.worker(p_type text, p_tenant int, p_sql text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_worker', pg_temp.cl(p_type, p_tenant), NULL, p_sql, 'v') $$;
CREATE FUNCTION pg_temp.app(p_type text, p_tenant int, p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(p_type, p_tenant), NULL, p_sql, p_mode) $$;
-- superuser row counts (RLS bypassed): "tenant #t's rows of table tbl"
CREATE FUNCTION pg_temp.cnt(p_tbl text, p_tenant int) RETURNS text LANGUAGE plpgsql AS $$ DECLARE n bigint; BEGIN
  EXECUTE format('SELECT count(*) FROM engagement.%I WHERE tenant_id = %L', p_tbl, pg_temp.id(p_tenant)) INTO n; RETURN n::text; END $$;

-- ---------------------------------------------------------------- fixtures: the same rows for tenant A (t = 1) and tenant B (t = 2); k offsets keep ids/hashes unique per tenant
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id(1), 'to1_a', 'Lab A', 'Lab A', 'active', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), 'to1_b', 'Lab B', 'Lab B', 'active', pg_temp.id(99), pg_temp.id(99));
DO $seed$
DECLARE t int; o int; d date := (now() AT TIME ZONE 'Asia/Kathmandu')::date;
BEGIN
  FOR t IN 1..2 LOOP
    o := t * 1000;
    -- otp_challenges: 1 eligible (expired 30 h ago), 2 not yet (expired 23 h ago), 3 live
    INSERT INTO engagement.otp_challenges (id, tenant_id, token_sha256, phone_e164, phone_hmac, app_instance_id, app_platform, code_hmac, status, created_by, created_at, expires_at) VALUES
      (pg_temp.id(o+1), pg_temp.id(t), pg_temp.h(o+1), '+97798000000' || t, pg_temp.h(o+91), pg_temp.id(98), 'android', pg_temp.h(o+92), 'sent', pg_temp.id(99), now() - interval '30 hours 5 minutes', now() - interval '30 hours'),
      (pg_temp.id(o+2), pg_temp.id(t), pg_temp.h(o+2), '+97798000000' || t, pg_temp.h(o+91), pg_temp.id(98), 'android', pg_temp.h(o+92), 'sent', pg_temp.id(99), now() - interval '23 hours 5 minutes', now() - interval '23 hours'),
      (pg_temp.id(o+3), pg_temp.id(t), pg_temp.h(o+3), '+97798000000' || t, pg_temp.h(o+91), pg_temp.id(98), 'android', pg_temp.h(o+92), 'sent', pg_temp.id(99), now(), now() + interval '5 minutes');
    -- link_codes: 11 eligible + unreferenced, 12 eligible but REFERENCED by link 21, 13 not yet eligible (expired 89 d ago)
    INSERT INTO engagement.link_codes (id, tenant_id, patient_id, code_hmac, bound_phone_hmac, bound_phone_last2, relationship, consent_id, display_name_snapshot, issued_by_membership_id, status, created_by, created_at, expires_at, updated_by) VALUES
      (pg_temp.id(o+11), pg_temp.id(t), pg_temp.id(o+50), pg_temp.h(o+11), pg_temp.h(o+93), '00', 'self', pg_temp.id(o+51), 'Test Patient 0011', pg_temp.id(99), 'issued', pg_temp.id(99), now() - interval '91 days 1 hour', now() - interval '91 days', pg_temp.id(99)),
      (pg_temp.id(o+12), pg_temp.id(t), pg_temp.id(o+50), pg_temp.h(o+12), pg_temp.h(o+93), '00', 'self', pg_temp.id(o+51), 'Test Patient 0012', pg_temp.id(99), 'issued', pg_temp.id(99), now() - interval '91 days 1 hour', now() - interval '91 days', pg_temp.id(99)),
      (pg_temp.id(o+13), pg_temp.id(t), pg_temp.id(o+50), pg_temp.h(o+13), pg_temp.h(o+93), '00', 'self', pg_temp.id(o+51), 'Test Patient 0013', pg_temp.id(99), 'issued', pg_temp.id(99), now() - interval '89 days 1 hour', now() - interval '89 days', pg_temp.id(99));
    INSERT INTO engagement.account_patient_links (id, tenant_id, account_id, patient_id, relationship, method, link_code_id, display_name, status, created_by, updated_by) VALUES
      (pg_temp.id(o+21), pg_temp.id(t), pg_temp.id(o+52), pg_temp.id(o+50), 'self', 'link_code', pg_temp.id(o+12), 'Test Patient 0012', 'active', pg_temp.id(99), pg_temp.id(99));
    -- notifications: 1 expired, 2 live
    INSERT INTO engagement.notifications (id, tenant_id, account_id, kind, entity_seq, created_by, expires_at) VALUES
      (pg_temp.id(o+31), pg_temp.id(t), pg_temp.id(o+52), 'report_ready', 1, pg_temp.id(99), now() - interval '1 day'),
      (pg_temp.id(o+32), pg_temp.id(t), pg_temp.id(o+52), 'report_ready', 2, pg_temp.id(99), now() + interval '1 day');
    -- number_counters: expired rate key (eligible), live rate key, numbering key (expires_at NULL, always kept)
    INSERT INTO engagement.number_counters (tenant_id, counter_key, last_value, expires_at, created_by) VALUES
      (pg_temp.id(t), 'otp_day:20260101', 3, now() - interval '1 day', pg_temp.id(99)),
      (pg_temp.id(t), 'otp_day:20260102', 3, now() + interval '1 day', pg_temp.id(99)),
      (pg_temp.id(t), 'booking_no:26', 7, NULL, pg_temp.id(99));
    -- queue: tokens 41 (-400 d, transferred to 42), 42 (-400 d), 43 (-366 d), 44 (-365 d: the boundary, kept), 45 (today); counters: -400 d (eligible), today
    INSERT INTO engagement.queue_tokens (id, tenant_id, centre_id, queue_id, business_date, seq, token_label, status, transferred_to_token_id, issued_at, created_by, updated_by) VALUES
      (pg_temp.id(o+41), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+61), d - 400, 1, 'A-001', 'transferred', pg_temp.id(o+42), now() - interval '400 days', pg_temp.id(99), pg_temp.id(99)),
      (pg_temp.id(o+42), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+61), d - 400, 2, 'A-002', 'completed', NULL, now() - interval '400 days', pg_temp.id(99), pg_temp.id(99)),
      (pg_temp.id(o+43), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+61), d - 366, 1, 'A-001', 'completed', NULL, now() - interval '366 days', pg_temp.id(99), pg_temp.id(99)),
      (pg_temp.id(o+44), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+61), d - 365, 1, 'A-001', 'completed', NULL, now() - interval '365 days', pg_temp.id(99), pg_temp.id(99)),
      (pg_temp.id(o+45), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+61), d,       1, 'A-001', 'waiting',   NULL, now(), pg_temp.id(99), pg_temp.id(99));
    INSERT INTO engagement.queue_day_counters (tenant_id, queue_id, centre_id, business_date, last_seq, created_by) VALUES
      (pg_temp.id(t), pg_temp.id(o+61), pg_temp.id(o+60), d - 400, 2, pg_temp.id(99)),
      (pg_temp.id(t), pg_temp.id(o+61), pg_temp.id(o+60), d,       1, pg_temp.id(99));
    -- payment_requests: 71 completed -91 d (eligible), 72 expired -100 d (eligible), 73 failed -89 d (kept), 74 queued -200 d (non-terminal: kept)
    INSERT INTO engagement.payment_requests (id, tenant_id, account_id, order_id, patient_id, gateway, status, idempotency_key, created_by, updated_by, created_at, updated_at) VALUES
      (pg_temp.id(o+71), pg_temp.id(t), pg_temp.id(o+52), pg_temp.id(o+53), pg_temp.id(o+50), 'esewa', 'completed', 'ops1-' || o || '-71', pg_temp.id(99), pg_temp.id(99), now() - interval '92 days', now() - interval '91 days'),
      (pg_temp.id(o+72), pg_temp.id(t), pg_temp.id(o+52), pg_temp.id(o+53), pg_temp.id(o+50), 'khalti', 'expired', 'ops1-' || o || '-72', pg_temp.id(99), pg_temp.id(99), now() - interval '101 days', now() - interval '100 days'),
      (pg_temp.id(o+73), pg_temp.id(t), pg_temp.id(o+52), pg_temp.id(o+53), pg_temp.id(o+50), 'esewa', 'failed',    'ops1-' || o || '-73', pg_temp.id(99), pg_temp.id(99), now() - interval '90 days', now() - interval '89 days'),
      (pg_temp.id(o+74), pg_temp.id(t), pg_temp.id(o+52), pg_temp.id(o+53), pg_temp.id(o+50), 'esewa', 'queued',    'ops1-' || o || '-74', pg_temp.id(99), pg_temp.id(99), now() - interval '201 days', now() - interval '200 days');
  END LOOP;
END $seed$;
SET LOCAL session_replication_role = origin;

-- ---------------------------------------------------------------- the two DEFINERs: owner, DEFINER, search_path, grants (05-SCHEMA §6.6 inventory rows)
SELECT is((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'engagement.purge_queue()'::regprocedure), 'lims_owner', 'purge_queue is owned by lims_owner');
SELECT is((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'engagement.purge_payment_requests()'::regprocedure), 'lims_owner', 'purge_payment_requests is owned by lims_owner');
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'engagement.purge_queue()'::regprocedure), 'purge_queue is SECURITY DEFINER');
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'engagement.purge_payment_requests()'::regprocedure), 'purge_payment_requests is SECURITY DEFINER');
SELECT ok((SELECT proconfig @> ARRAY['search_path='] FROM pg_proc WHERE oid = 'engagement.purge_queue()'::regprocedure), 'purge_queue pins search_path = ''''');
SELECT ok((SELECT proconfig @> ARRAY['search_path='] FROM pg_proc WHERE oid = 'engagement.purge_payment_requests()'::regprocedure), 'purge_payment_requests pins search_path = ''''');
SELECT ok(has_function_privilege('lims_worker', 'engagement.purge_queue()', 'EXECUTE'), 'lims_worker may execute purge_queue');
SELECT ok(has_function_privilege('lims_worker', 'engagement.purge_payment_requests()', 'EXECUTE'), 'lims_worker may execute purge_payment_requests');
SELECT ok(NOT has_function_privilege('lims_app', 'engagement.purge_queue()', 'EXECUTE') AND NOT has_function_privilege('lims_api', 'engagement.purge_queue()', 'EXECUTE'), 'the request roles may not execute purge_queue');
SELECT ok(NOT has_function_privilege('lims_app', 'engagement.purge_payment_requests()', 'EXECUTE') AND NOT has_function_privilege('lims_api', 'engagement.purge_payment_requests()', 'EXECUTE'), 'the request roles may not execute purge_payment_requests');
SELECT ok(NOT has_function_privilege('public', 'engagement.purge_queue()', 'EXECUTE') AND NOT has_function_privilege('public', 'engagement.purge_payment_requests()', 'EXECUTE'), 'PUBLIC may not execute either purge');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'engagement' AND p.proname LIKE 'purge%' AND p.prosecdef), 2, 'exactly two purge DEFINERs exist in schema engagement (class-E deletes are NOT DEFINERs; purge_by_retention is not built, §6.4)');

-- ---------------------------------------------------------------- §6.6 test 5: refused without system + tenant claims
SELECT is(pg_temp.worker('user', 1, 'SELECT engagement.purge_queue()'), 'EP0001:purge_requires_system_tenant_claims', 'purge_queue as a user actor -> purge_requires_system_tenant_claims');
SELECT is(pg_temp.worker('patient', 1, 'SELECT engagement.purge_queue()'), 'EP0001:purge_requires_system_tenant_claims', 'purge_queue as a patient actor -> purge_requires_system_tenant_claims');
SELECT is(pg_temp.x('lims_worker', NULL, NULL, 'SELECT engagement.purge_queue()', 'v'), 'EP0001:purge_requires_system_tenant_claims', 'purge_queue with no claims -> purge_requires_system_tenant_claims');
SELECT is(pg_temp.x('lims_worker', jsonb_build_object('actor_type', 'system', 'sub', pg_temp.id(99))::text, NULL, 'SELECT engagement.purge_queue()', 'v'), 'EP0001:purge_requires_system_tenant_claims', 'purge_queue as system WITHOUT a tenant claim -> purge_requires_system_tenant_claims');
SELECT is(pg_temp.worker('user', 1, 'SELECT engagement.purge_payment_requests()'), 'EP0001:purge_requires_system_tenant_claims', 'purge_payment_requests as a user actor -> purge_requires_system_tenant_claims');
SELECT is(pg_temp.x('lims_worker', NULL, NULL, 'SELECT engagement.purge_payment_requests()', 'v'), 'EP0001:purge_requires_system_tenant_claims', 'purge_payment_requests with no claims -> purge_requires_system_tenant_claims');
SELECT is(pg_temp.cnt('queue_tokens', 1) || '/' || pg_temp.cnt('payment_requests', 1), '5/4', 'the refused calls deleted nothing');

-- ---------------------------------------------------------------- §6.6 test 5: the claimed tenant only; own app.maintenance sees/deletes nothing; GUC reset after return
-- attackers first (before any purge ran): setting app.maintenance yourself opens nothing, for the request role and for the worker role
SELECT ok(pg_temp.x('lims_app', pg_temp.cl('system', 1), 'SET LOCAL app.maintenance = ''engagement_purge_queue''', 'DELETE FROM engagement.queue_tokens', 'w') IN ('0') OR pg_temp.x('lims_app', pg_temp.cl('system', 1), 'SET LOCAL app.maintenance = ''engagement_purge_queue''', 'DELETE FROM engagement.queue_tokens', 'w') LIKE 'E42501:%', 'lims_app + own app.maintenance=engagement_purge_queue deletes no queue_tokens (no DELETE policy/grant for lims_app)');
SELECT ok(pg_temp.x('lims_app', pg_temp.cl('system', 1), 'SET LOCAL app.maintenance = ''engagement_purge_queue''', 'DELETE FROM engagement.queue_day_counters', 'w') IN ('0') OR pg_temp.x('lims_app', pg_temp.cl('system', 1), 'SET LOCAL app.maintenance = ''engagement_purge_queue''', 'DELETE FROM engagement.queue_day_counters', 'w') LIKE 'E42501:%', 'lims_app + own app.maintenance deletes no queue_day_counters');
SELECT ok(pg_temp.x('lims_app', pg_temp.cl('system', 1), 'SET LOCAL app.maintenance = ''engagement_purge_payment_requests''', 'DELETE FROM engagement.payment_requests', 'w') IN ('0') OR pg_temp.x('lims_app', pg_temp.cl('system', 1), 'SET LOCAL app.maintenance = ''engagement_purge_payment_requests''', 'DELETE FROM engagement.payment_requests', 'w') LIKE 'E42501:%', 'lims_app + own app.maintenance deletes no payment_requests');
SELECT ok(pg_temp.x('lims_worker', pg_temp.cl('system', 1), 'SET LOCAL app.maintenance = ''engagement_purge_queue''', 'DELETE FROM engagement.queue_tokens', 'w') IN ('0') OR pg_temp.x('lims_worker', pg_temp.cl('system', 1), 'SET LOCAL app.maintenance = ''engagement_purge_queue''', 'DELETE FROM engagement.queue_tokens', 'w') LIKE 'E42501:%', 'lims_worker + own app.maintenance deletes no queue_tokens (the owner policies are TO lims_owner only)');
SELECT is(pg_temp.cnt('queue_tokens', 1) || '/' || pg_temp.cnt('queue_day_counters', 1) || '/' || pg_temp.cnt('payment_requests', 1), '5/2/4', 'after the attacks tenant A still has every queue and payment row');

-- purge_queue as the system actor of tenant A
SELECT is(pg_temp.worker('system', 1, 'SELECT engagement.purge_queue()'), '4', 'purge_queue (tenant A) returns tokens + day counters deleted: 3 tokens (400 d x2 incl. the self-FK transfer pair, 366 d) + 1 counter');
SELECT is(pg_temp.cnt('queue_tokens', 1), '2', 'tenant A keeps the tokens at the 365-day boundary and today');
SELECT is(pg_temp.cnt('queue_day_counters', 1), '1', 'tenant A keeps today''s day counter');
SELECT is(pg_temp.cnt('queue_tokens', 2) || '/' || pg_temp.cnt('queue_day_counters', 2), '5/2', 'tenant B (not the claimed tenant) lost nothing');
SELECT is(current_setting('app.maintenance', true), '', 'app.maintenance is '''' after purge_queue returns');
SELECT is(pg_temp.worker('system', 1, 'SELECT engagement.purge_queue()'), '0', 'purge_queue is idempotent: a second run deletes nothing');

-- purge_payment_requests as the system actor of tenant A
SELECT is(pg_temp.worker('system', 1, 'SELECT engagement.purge_payment_requests()'), '2', 'purge_payment_requests (tenant A) returns 2: completed -91 d and expired -100 d');
SELECT is(pg_temp.cnt('payment_requests', 1), '2', 'tenant A keeps failed -89 d (inside 90 d) and the non-terminal queued row');
SELECT is(pg_temp.cnt('payment_requests', 2), '4', 'tenant B (not the claimed tenant) lost nothing');
SELECT is(current_setting('app.maintenance', true), '', 'app.maintenance is '''' after purge_payment_requests returns');
SELECT is(pg_temp.worker('system', 1, 'SELECT engagement.purge_payment_requests()'), '0', 'purge_payment_requests is idempotent');
-- the same call under tenant B's claims purges B only
SELECT is(pg_temp.worker('system', 2, 'SELECT engagement.purge_queue()') || '/' || pg_temp.worker('system', 2, 'SELECT engagement.purge_payment_requests()'), '4/2', 'under tenant B claims the purges delete tenant B rows (same counts) and no tenant A row');
SELECT is(pg_temp.cnt('queue_tokens', 1) || '/' || pg_temp.cnt('payment_requests', 1), '2/2', 'tenant A rows unchanged by the tenant-B run');

-- ---------------------------------------------------------------- class-E deletes: the system actor only, only past expires_at, only the claimed tenant (NOT DEFINERs; lims_app + __delete__tenant)
-- not the system actor -> nothing deleted
SELECT is(pg_temp.app('user', 1, 'DELETE FROM engagement.otp_challenges'), '0', 'a user actor deletes no otp_challenges (policy requires the system actor)');
SELECT is(pg_temp.app('patient', 1, 'DELETE FROM engagement.otp_challenges'), '0', 'a patient actor deletes no otp_challenges');
SELECT is(pg_temp.app('user', 1, 'DELETE FROM engagement.notifications'), '0', 'a user actor deletes no notifications');
SELECT is(pg_temp.app('user', 1, 'DELETE FROM engagement.number_counters'), '0', 'a user actor deletes no number_counters');
SELECT is(pg_temp.app('user', 1, 'DELETE FROM engagement.link_codes WHERE NOT EXISTS (SELECT 1 FROM engagement.account_patient_links l WHERE l.tenant_id = link_codes.tenant_id AND l.link_code_id = link_codes.id)'), '0', 'a user actor deletes no link_codes');
SELECT is(pg_temp.cnt('otp_challenges', 1) || '/' || pg_temp.cnt('notifications', 1) || '/' || pg_temp.cnt('number_counters', 1) || '/' || pg_temp.cnt('link_codes', 1), '3/2/3/3', 'nothing changed after the non-system attempts');
-- the system actor of tenant A: only rows past expires_at (+ window)
SELECT is(pg_temp.app('system', 1, 'DELETE FROM engagement.otp_challenges'), '1', 'system actor A: an unfiltered DELETE removes only the otp_challenge expired > 24 h ago (the 23 h and live ones survive the policy)');
SELECT is(pg_temp.app('system', 1, 'DELETE FROM engagement.notifications'), '1', 'system actor A: removes only the expired notification');
SELECT is(pg_temp.app('system', 1, 'DELETE FROM engagement.number_counters'), '1', 'system actor A: removes only the expired rate key (live key and the numbering key with expires_at NULL survive)');
SELECT is(pg_temp.cnt('otp_challenges', 1) || '/' || pg_temp.cnt('notifications', 1) || '/' || pg_temp.cnt('number_counters', 1), '2/1/2', 'tenant A survivors: 2 otp, 1 notification, 2 counters');
SELECT is(pg_temp.cnt('otp_challenges', 2) || '/' || pg_temp.cnt('notifications', 2) || '/' || pg_temp.cnt('number_counters', 2), '3/2/3', 'tenant B (not the claimed tenant) lost nothing');
-- link_codes: referenced code kept (task filter) and FK-protected (bare delete)
SELECT like(pg_temp.app('system', 1, 'DELETE FROM engagement.link_codes WHERE id = ' || quote_literal(pg_temp.id(1012)::text) || '::uuid'), 'E23503:%', 'a bare DELETE of a link_code referenced by a link fails on account_patient_links__code__fk (23503): the data layer protects it even if the task filter were missing');
SELECT is(pg_temp.app('system', 1, 'DELETE FROM engagement.link_codes WHERE NOT EXISTS (SELECT 1 FROM engagement.account_patient_links l WHERE l.tenant_id = link_codes.tenant_id AND l.link_code_id = link_codes.id)'), '1', 'the task''s DELETE (NOT EXISTS link filter) removes only the unreferenced code expired > 90 d ago');
SELECT is(pg_temp.cnt('link_codes', 1), '2', 'tenant A keeps the REFERENCED expired code (12) and the code expired only 89 d ago (13)');
SELECT is((SELECT count(*)::int FROM engagement.link_codes WHERE id = pg_temp.id(1012)), 1, 'the referenced link_code row 12 is still there');
SELECT is(pg_temp.cnt('link_codes', 2), '3', 'tenant B link_codes untouched');
-- system actor of tenant B cannot delete tenant A rows by id
SELECT is(pg_temp.app('system', 2, 'DELETE FROM engagement.otp_challenges WHERE tenant_id = ' || quote_literal(pg_temp.id(1)::text) || '::uuid'), '0', 'system actor B deleting tenant A otp_challenges by tenant_id deletes 0 (cross-tenant)');
-- class-E tables the spec keeps have no system delete path in this task
SELECT is(pg_temp.app('system', 1, 'DELETE FROM engagement.account_patient_links'), '0', 'the system actor cannot delete account_patient_links (class M, kept)');
SELECT ok(pg_temp.app('system', 1, 'DELETE FROM engagement.payment_requests') IN ('0') OR pg_temp.app('system', 1, 'DELETE FROM engagement.payment_requests') LIKE 'E42501:%', 'the system actor has no direct DELETE on payment_requests (only the DEFINER purges it)');
SELECT ok(pg_temp.app('system', 1, 'DELETE FROM engagement.queue_tokens') IN ('0') OR pg_temp.app('system', 1, 'DELETE FROM engagement.queue_tokens') LIKE 'E42501:%', 'the system actor has no direct DELETE on queue_tokens (only the DEFINER purges it)');
SELECT is(pg_temp.app('system', 1, 'DELETE FROM engagement.self_registrations'), '0', 'no self_registrations row delete exists (row kept; only the personal fields are redacted, B15)');

SELECT * FROM finish();
ROLLBACK;
