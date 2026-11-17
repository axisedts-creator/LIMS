-- T0C-MSGDESK-1 pgTAP suite (LD-321, LD-325; founder 2026-11-17 09:18 NPT order, ElabAssist "Messages" and "Message To Laboratory") for migration
-- 20261117240000_engagement__add_broadcast_and_tickets.sql: engagement.broadcast_template, engagement.broadcast, engagement.broadcast_recipient (staff only, tenant RLS FORCE-d),
-- partners.partner_ticket, partners.partner_ticket_message (tenant RLS FORCE-d, partner actors see only their own partner's tickets), idempotent re-apply.
-- Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written by the superuser test session with system claims (audit context),
-- every isolation assertion runs as SET LOCAL ROLE lims_app. Seeds 010 supply tenant A/B (a001/b001), users a300/a30c/a30a/a309, memberships, centres.
-- Run: bash db/tests/run-suites.sh db/tests/engagement/T0C-MSGDESK-1_broadcast_and_tickets.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (the brief names tables and the listed columns; a different choice needs a ruling, not a silent test edit; names equal the contract test msgdesk1-openapi.test.ts):
--  - Schemas: broadcast_template, broadcast, broadcast_recipient in engagement; partner_ticket, partner_ticket_message in partners (the ticket paths live in partners.yaml, the policies in db/policies/partners.sql).
--  - engagement.broadcast_template(id, tenant_id, name, channel, body, is_active, version, created_at, created_by, updated_at, updated_by): channel sms | whatsapp | email, name and body not empty. lims_app: SELECT, INSERT, UPDATE, no DELETE (deactivate only).
--  - engagement.broadcast(id, tenant_id, template_id, audience_filter jsonb, status, recipient_count, opted_out_count, requested_by, approved_by, version, created_at, created_by, updated_at, updated_by): composite FK (tenant_id, template_id),
--    status draft | pending_approval | approved | sending | sent | cancelled, recipient_count 0..5000, opted_out_count >= 0, approved_by must differ from requested_by (second person rule, enforced in the table as well),
--    a broadcast in approved, sending or sent has an approver. lims_app: SELECT, INSERT, UPDATE, no DELETE.
--  - engagement.broadcast_recipient(id, tenant_id, broadcast_id, party_kind, party_id, channel_address, status, outbox_id, created_at, created_by, updated_at): composite FK (tenant_id, broadcast_id), party_kind laboratory | franchise | client | lab_user,
--    status queued | sent | failed | skipped, one row per (broadcast, party_kind, party_id), outbox_id unique when set (one outbox row per recipient, so a retry never double sends). channel_address holds the real address (needed to send); masking is done on read by the API.
--    lims_app: SELECT, INSERT, UPDATE (status moves), no DELETE.
--  - partners.partner_ticket(id, tenant_id, party_kind, party_id, subject, status, version, created_at, created_by, updated_at, updated_by): party_kind 'partner' (party_id = partners.partners.id) or another value of the closed list, status new | replied | closed,
--    subject not empty. lims_app: SELECT, INSERT, UPDATE, no DELETE.
--  - partners.partner_ticket_message(id, tenant_id, ticket_id, sender_kind, body, created_by, created_at): composite FK (tenant_id, ticket_id), sender_kind partner | lab, body not empty. Append only: lims_app has SELECT and INSERT, no UPDATE, no DELETE.
--  - Actor rules: staff (user, system) read and write all five tables of their tenant. A partner actor (claims actor_type partner + membership of an active or invited partner user) sees and creates only tickets of its own partner
--    (party_kind partner, party_id = app.current_partner_id()) and the messages of those tickets, and may only write messages with sender_kind partner. Patients, portal actors and partner actors see no broadcast row.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c700-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.s(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-00000000' || s)::uuid $$;     -- seed ids: user a300 (staff A), a30c, a30a, membership a500 ...
CREATE FUNCTION pg_temp.mem(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT pg_temp.uid(1030 + n) $$;                                -- partner memberships 1 (P1 admin), 2 (P2 admin)
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'user', p_mem uuid DEFAULT NULL, p_sub uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant,
    'sub', coalesce(p_sub, CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a300' ELSE '01a1a98a-ac40-7000-8000-00000000b300' END::uuid),
    'membership_id', coalesce(p_mem, CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a500' ELSE '01a1a98a-ac40-7000-8000-00000000b500' END::uuid)) $$;
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);

-- run p_sql as p_role with claims; mode n = count of a query, w = ROW_COUNT of a statement; errors -> 'E' || SQLSTATE
CREATE FUNCTION pg_temp.x(p_role text, p_claims jsonb, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; END IF;
    r := 'n=' || n;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.a(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.b(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
-- tenant A partner actor: p_n = partner membership (1 = P1 admin of user a30c, 2 = P2 admin of user a30a)
CREATE FUNCTION pg_temp.pa(p_n int, p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner', pg_temp.mem(p_n), CASE p_n WHEN 1 THEN pg_temp.s('a30c') ELSE pg_temp.s('a30a') END), p_sql, p_mode) $$;
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
-- one scalar as text, or 'E' || SQLSTATE (a missing column fails one assertion, not the whole file)
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r, 'NULL'); EXCEPTION WHEN OTHERS THEN RETURN 'E' || SQLSTATE; END $f$;
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
CREATE FUNCTION pg_temp.cols_missing(p_tbl text, p_cols text[]) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(c, ',') FROM unnest(p_cols) c WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass(p_tbl) AND a.attname = c AND NOT a.attisdropped AND a.attnum > 0) $$;

-- ===================================================================================================================================== fixtures: OLD tables only (partner accounts as in T0B-13.C13_behaviour)
-- tenant A: partners P1 (1001), P2 (1002); tenant B: PB (1003). Partner users: P1 admin (mem 1, user a30c), P2 admin (mem 2, user a30a).
SELECT pg_temp.fx('catalog.credit_parties', jsonb_build_object('id', pg_temp.uid(1011), 'tenant_id', pg_temp.ta(), 'party_code', 'SYN-MD-X', 'name', 'Synthetic partner X', 'kind', 'partner_lab'));
SELECT pg_temp.fx('catalog.credit_parties', jsonb_build_object('id', pg_temp.uid(1012), 'tenant_id', pg_temp.ta(), 'party_code', 'SYN-MD-Y', 'name', 'Synthetic partner Y', 'kind', 'clinic'));
SELECT pg_temp.fx('catalog.credit_parties', jsonb_build_object('id', pg_temp.uid(1013), 'tenant_id', pg_temp.tb(), 'party_code', 'SYN-MD-B', 'name', 'Synthetic partner B', 'kind', 'partner_lab'));
SELECT pg_temp.fx('core.memberships', jsonb_build_object('id', pg_temp.mem(1), 'tenant_id', pg_temp.ta(), 'user_id', pg_temp.s('a30c'), 'actor_type', 'partner', 'all_centres', false, 'status', 'active', 'partner_role', 'partner_admin'));
SELECT pg_temp.fx('core.memberships', jsonb_build_object('id', pg_temp.mem(2), 'tenant_id', pg_temp.ta(), 'user_id', pg_temp.s('a30a'), 'actor_type', 'partner', 'all_centres', false, 'status', 'active', 'partner_role', 'partner_admin'));
SELECT pg_temp.fx('partners.settings', jsonb_build_object('tenant_id', pg_temp.ta()));
SELECT pg_temp.fx('partners.settings', jsonb_build_object('tenant_id', pg_temp.tb()));
SELECT pg_temp.fx('partners.partners', jsonb_build_object('id', pg_temp.uid(1001), 'tenant_id', pg_temp.ta(), 'partner_code', 'SYN-MD-X', 'name', 'Synthetic partner', 'credit_party_id', pg_temp.uid(1011),
  'receiving_branch_id', pg_temp.s('a101'), 'receiving_centre_id', pg_temp.s('a201'), 'conversion_mode', 'on_receipt'));
SELECT pg_temp.fx('partners.partners', jsonb_build_object('id', pg_temp.uid(1002), 'tenant_id', pg_temp.ta(), 'partner_code', 'SYN-MD-Y', 'name', 'Synthetic partner', 'credit_party_id', pg_temp.uid(1012),
  'receiving_branch_id', pg_temp.s('a102'), 'receiving_centre_id', pg_temp.s('a202'), 'conversion_mode', 'on_receipt'));
SELECT pg_temp.fx('partners.partners', jsonb_build_object('id', pg_temp.uid(1003), 'tenant_id', pg_temp.tb(), 'partner_code', 'SYN-MD-B', 'name', 'Synthetic partner', 'credit_party_id', pg_temp.uid(1013),
  'receiving_branch_id', pg_temp.s('b101'), 'receiving_centre_id', pg_temp.s('b201'), 'conversion_mode', 'on_receipt'));
SELECT pg_temp.fx('partners.partner_users', jsonb_build_object('id', pg_temp.uid(1021), 'tenant_id', pg_temp.ta(), 'partner_id', pg_temp.uid(1001), 'membership_id', pg_temp.mem(1), 'partner_role', 'partner_admin', 'status', 'active',
  'display_name', 'Test User', 'email_masked', 'a***@p***.invalid', 'invited_by_actor_type', 'user'));
SELECT pg_temp.fx('partners.partner_users', jsonb_build_object('id', pg_temp.uid(1023), 'tenant_id', pg_temp.ta(), 'partner_id', pg_temp.uid(1002), 'membership_id', pg_temp.mem(2), 'partner_role', 'partner_admin', 'status', 'active',
  'display_name', 'Test User', 'email_masked', 'a***@p***.invalid', 'invited_by_actor_type', 'user'));

-- ===================================================================================================================================== (1) engagement.broadcast_template
SELECT has_table('engagement'::name, 'broadcast_template'::name, 'engagement.broadcast_template exists');
SELECT is(pg_temp.cols_missing('engagement.broadcast_template', ARRAY['id','tenant_id','name','channel','body','is_active','version','created_at','created_by','updated_at','updated_by']), NULL, 'broadcast_template has the 11 columns');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('engagement.broadcast_template')), true, 'broadcast_template: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('engagement.broadcast_template') AND polcmd = 'd'), 0, 'broadcast_template: no DELETE policy');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('engagement.broadcast_template') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND pg_get_expr(polwithcheck, polrelid) !~ 'tenant_id')), 0, 'broadcast_template: every policy is tenant scoped');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'engagement.broadcast_template', 'SELECT') AND has_table_privilege('lims_app', 'engagement.broadcast_template', 'INSERT')
  AND has_table_privilege('lims_app', 'engagement.broadcast_template', 'UPDATE') AND NOT has_table_privilege('lims_app', 'engagement.broadcast_template', 'DELETE'))::text$q$), 'true', 'broadcast_template: lims_app has SELECT, INSERT, UPDATE and no DELETE');
SELECT is(pg_temp.ins('engagement.broadcast_template', jsonb_build_object('id', pg_temp.uid(201), 'tenant_id', pg_temp.ta(), 'name', 'Eid greeting (SYNTHETIC)', 'channel', 'sms', 'body', 'Dear {{party_name}}, we are closed on Friday.')), 'ok', 'template insert: tenant A / sms');
SELECT is(pg_temp.ins('engagement.broadcast_template', jsonb_build_object('id', pg_temp.uid(202), 'tenant_id', pg_temp.ta(), 'name', 'Rate change (SYNTHETIC)', 'channel', 'whatsapp', 'body', 'New rates from Shrawan 1.', 'is_active', false)), 'ok', 'template insert: tenant A / whatsapp / inactive');
SELECT is(pg_temp.ins('engagement.broadcast_template', jsonb_build_object('id', pg_temp.uid(203), 'tenant_id', pg_temp.tb(), 'name', 'Notice B (SYNTHETIC)', 'channel', 'email', 'body', 'Hello from B.')), 'ok', 'template insert: tenant B / email');
SELECT is(pg_temp.ins('engagement.broadcast_template', jsonb_build_object('id', pg_temp.uid(204), 'tenant_id', pg_temp.ta(), 'name', 'Bad channel', 'channel', 'telegram', 'body', 'x')), '23514', 'template insert: unknown channel rejected');
SELECT is(pg_temp.ins('engagement.broadcast_template', jsonb_build_object('id', pg_temp.uid(205), 'tenant_id', pg_temp.ta(), 'name', '', 'channel', 'sms', 'body', 'x')), '23514', 'template insert: empty name rejected');
SELECT is(pg_temp.ins('engagement.broadcast_template', jsonb_build_object('id', pg_temp.uid(206), 'tenant_id', pg_temp.ta(), 'name', 'Empty body', 'channel', 'sms', 'body', '')), '23514', 'template insert: empty body rejected');
SELECT is(pg_temp.q($q$SELECT is_active::text FROM engagement.broadcast_template WHERE id = '0190c700-0000-7000-8000-000000000201'$q$), 'true', 'template: active by default');
SELECT is(pg_temp.a($q$DELETE FROM engagement.broadcast_template WHERE id = '0190c700-0000-7000-8000-000000000201'$q$), 'E42501', 'tenant A staff cannot DELETE a template (no grant)');
SELECT is(pg_temp.a($q$UPDATE engagement.broadcast_template SET is_active = false WHERE id = '0190c700-0000-7000-8000-000000000201'$q$), 'n=1', 'tenant A staff can deactivate a template');
SELECT is(pg_temp.a($q$SELECT 1 FROM engagement.broadcast_template$q$, 'n'), 'n=2', 'tenant A staff sees its 2 templates');
SELECT is(pg_temp.b($q$SELECT 1 FROM engagement.broadcast_template$q$, 'n'), 'n=1', 'tenant B staff sees its 1 template');
SELECT is(pg_temp.a($q$SELECT 1 FROM engagement.broadcast_template WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$, 'n'), 'n=0', 'tenant A cannot read tenant B templates by filter');
SELECT is(pg_temp.a($q$UPDATE engagement.broadcast_template SET body = 'hijack' WHERE id = '0190c700-0000-7000-8000-000000000203'$q$), 'n=0', 'tenant A cannot update a tenant B template');
SELECT is(pg_temp.a($q$INSERT INTO engagement.broadcast_template (id, tenant_id, name, channel, body, created_by, updated_by) VALUES ('0190c700-0000-7000-8000-000000000207',
  '01a1a98a-ac40-7000-8000-00000000b001', 'x', 'sms', 'x', '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a300')$q$), 'E42501', 'tenant A cannot insert a template for tenant B (RLS WITH CHECK)');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM engagement.broadcast_template', 'n'), 'n=0', 'patient claims see 0 templates');
SELECT is(pg_temp.pa(1, 'SELECT 1 FROM engagement.broadcast_template', 'n'), 'n=0', 'partner claims see 0 templates');

-- ===================================================================================================================================== (2) engagement.broadcast
SELECT has_table('engagement'::name, 'broadcast'::name, 'engagement.broadcast exists');
SELECT is(pg_temp.cols_missing('engagement.broadcast', ARRAY['id','tenant_id','template_id','audience_filter','status','recipient_count','opted_out_count','requested_by','approved_by','version','created_at','created_by','updated_at','updated_by']), NULL, 'broadcast has the 14 columns');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('engagement.broadcast')), true, 'broadcast: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('engagement.broadcast') AND polcmd = 'd'), 0, 'broadcast: no DELETE policy (history is kept)');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('engagement.broadcast') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND pg_get_expr(polwithcheck, polrelid) !~ 'tenant_id')), 0, 'broadcast: every policy is tenant scoped');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'engagement.broadcast', 'SELECT') AND has_table_privilege('lims_app', 'engagement.broadcast', 'INSERT')
  AND has_table_privilege('lims_app', 'engagement.broadcast', 'UPDATE') AND NOT has_table_privilege('lims_app', 'engagement.broadcast', 'DELETE'))::text$q$), 'true', 'broadcast: lims_app has SELECT, INSERT, UPDATE and no DELETE');
SELECT is(pg_temp.ins('engagement.broadcast', jsonb_build_object('id', pg_temp.uid(211), 'tenant_id', pg_temp.ta(), 'template_id', pg_temp.uid(201), 'audience_filter', '{"party_kinds":["client","franchise"],"active_only":true}'::jsonb,
  'status', 'draft', 'recipient_count', 2, 'opted_out_count', 1, 'requested_by', pg_temp.s('a300'))), 'ok', 'broadcast insert: tenant A / draft');
SELECT is(pg_temp.ins('engagement.broadcast', jsonb_build_object('id', pg_temp.uid(212), 'tenant_id', pg_temp.ta(), 'template_id', pg_temp.uid(202), 'audience_filter', '{"party_kinds":["lab_user"]}'::jsonb,
  'status', 'pending_approval', 'recipient_count', 40, 'opted_out_count', 0, 'requested_by', pg_temp.s('a300'))), 'ok', 'broadcast insert: tenant A / pending_approval');
SELECT is(pg_temp.ins('engagement.broadcast', jsonb_build_object('id', pg_temp.uid(213), 'tenant_id', pg_temp.tb(), 'template_id', pg_temp.uid(203), 'audience_filter', '{"party_kinds":["client"]}'::jsonb,
  'status', 'draft', 'recipient_count', 1, 'opted_out_count', 0, 'requested_by', pg_temp.s('b300'))), 'ok', 'broadcast insert: tenant B');
SELECT is(pg_temp.ins('engagement.broadcast', jsonb_build_object('id', pg_temp.uid(214), 'tenant_id', pg_temp.ta(), 'template_id', pg_temp.uid(203), 'audience_filter', '{"party_kinds":["client"]}'::jsonb,
  'status', 'draft', 'recipient_count', 1, 'opted_out_count', 0, 'requested_by', pg_temp.s('a300'))), '23503', 'broadcast insert: a template of tenant B is rejected (composite FK)');
SELECT is(pg_temp.ins('engagement.broadcast', jsonb_build_object('id', pg_temp.uid(215), 'tenant_id', pg_temp.ta(), 'template_id', pg_temp.uid(201), 'audience_filter', '{"party_kinds":["client"]}'::jsonb,
  'status', 'queued', 'recipient_count', 1, 'opted_out_count', 0, 'requested_by', pg_temp.s('a300'))), '23514', 'broadcast insert: unknown status rejected');
SELECT is(pg_temp.ins('engagement.broadcast', jsonb_build_object('id', pg_temp.uid(216), 'tenant_id', pg_temp.ta(), 'template_id', pg_temp.uid(201), 'audience_filter', '{"party_kinds":["client"]}'::jsonb,
  'status', 'draft', 'recipient_count', 5001, 'opted_out_count', 0, 'requested_by', pg_temp.s('a300'))), '23514', 'broadcast insert: more than 5000 recipients rejected');
SELECT is(pg_temp.ins('engagement.broadcast', jsonb_build_object('id', pg_temp.uid(217), 'tenant_id', pg_temp.ta(), 'template_id', pg_temp.uid(201), 'audience_filter', '{"party_kinds":["client"]}'::jsonb,
  'status', 'draft', 'recipient_count', 5000, 'opted_out_count', 0, 'requested_by', pg_temp.s('a300'))), 'ok', 'broadcast insert: exactly 5000 recipients accepted');
SELECT is(pg_temp.ins('engagement.broadcast', jsonb_build_object('id', pg_temp.uid(218), 'tenant_id', pg_temp.ta(), 'template_id', pg_temp.uid(201), 'audience_filter', '{"party_kinds":["client"]}'::jsonb,
  'status', 'draft', 'recipient_count', -1, 'opted_out_count', 0, 'requested_by', pg_temp.s('a300'))), '23514', 'broadcast insert: negative recipient_count rejected');
SELECT is(pg_temp.ins('engagement.broadcast', jsonb_build_object('id', pg_temp.uid(219), 'tenant_id', pg_temp.ta(), 'template_id', pg_temp.uid(201), 'audience_filter', '{"party_kinds":["client"]}'::jsonb,
  'status', 'draft', 'recipient_count', 1, 'opted_out_count', -1, 'requested_by', pg_temp.s('a300'))), '23514', 'broadcast insert: negative opted_out_count rejected');
-- the second person rule lives in the table too
SELECT is(pg_temp.ins('engagement.broadcast', jsonb_build_object('id', pg_temp.uid(220), 'tenant_id', pg_temp.ta(), 'template_id', pg_temp.uid(201), 'audience_filter', '{"party_kinds":["client"]}'::jsonb,
  'status', 'approved', 'recipient_count', 1, 'opted_out_count', 0, 'requested_by', pg_temp.s('a300'), 'approved_by', pg_temp.s('a300'))), '23514', 'broadcast insert: approver equal to requester rejected (second person rule)');
SELECT is(pg_temp.ins('engagement.broadcast', jsonb_build_object('id', pg_temp.uid(221), 'tenant_id', pg_temp.ta(), 'template_id', pg_temp.uid(201), 'audience_filter', '{"party_kinds":["client"]}'::jsonb,
  'status', 'approved', 'recipient_count', 1, 'opted_out_count', 0, 'requested_by', pg_temp.s('a300'))), '23514', 'broadcast insert: approved without an approver rejected');
SELECT is(pg_temp.ins('engagement.broadcast', jsonb_build_object('id', pg_temp.uid(222), 'tenant_id', pg_temp.ta(), 'template_id', pg_temp.uid(201), 'audience_filter', '{"party_kinds":["client"]}'::jsonb,
  'status', 'sending', 'recipient_count', 1, 'opted_out_count', 0, 'requested_by', pg_temp.s('a300'))), '23514', 'broadcast insert: sending without an approver rejected');
SELECT is(pg_temp.ins('engagement.broadcast', jsonb_build_object('id', pg_temp.uid(223), 'tenant_id', pg_temp.ta(), 'template_id', pg_temp.uid(201), 'audience_filter', '{"party_kinds":["client"]}'::jsonb,
  'status', 'approved', 'recipient_count', 1, 'opted_out_count', 0, 'requested_by', pg_temp.s('a300'), 'approved_by', pg_temp.s('a30c'))), 'ok', 'broadcast insert: approved by a second person is accepted');
SELECT is(pg_temp.a($q$UPDATE engagement.broadcast SET status = 'approved', approved_by = '01a1a98a-ac40-7000-8000-00000000a300' WHERE id = '0190c700-0000-7000-8000-000000000212'$q$), 'E23514', 'broadcast update: approving your own request is rejected by the table');
SELECT is(pg_temp.a($q$UPDATE engagement.broadcast SET status = 'approved', approved_by = '01a1a98a-ac40-7000-8000-00000000a30c' WHERE id = '0190c700-0000-7000-8000-000000000212'$q$), 'n=1', 'broadcast update: a second person approves');
SELECT is(pg_temp.a($q$UPDATE engagement.broadcast SET status = 'cancelled' WHERE id = '0190c700-0000-7000-8000-000000000211'$q$), 'n=1', 'broadcast update: a draft can be cancelled');
SELECT is(pg_temp.a($q$DELETE FROM engagement.broadcast WHERE id = '0190c700-0000-7000-8000-000000000211'$q$), 'E42501', 'tenant A staff cannot DELETE a broadcast (no grant)');
SELECT is(pg_temp.a($q$SELECT 1 FROM engagement.broadcast$q$, 'n'), 'n=4', 'tenant A staff sees its 4 broadcasts (211, 212, 217, 223)');
SELECT is(pg_temp.b($q$SELECT 1 FROM engagement.broadcast$q$, 'n'), 'n=1', 'tenant B staff sees its 1 broadcast');
SELECT is(pg_temp.a($q$SELECT 1 FROM engagement.broadcast WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$, 'n'), 'n=0', 'tenant A cannot read tenant B broadcasts by filter');
SELECT is(pg_temp.a($q$UPDATE engagement.broadcast SET status = 'cancelled' WHERE id = '0190c700-0000-7000-8000-000000000213'$q$), 'n=0', 'tenant A cannot update a tenant B broadcast');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM engagement.broadcast', 'n'), 'n=0', 'patient claims see 0 broadcasts');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal'), 'SELECT 1 FROM engagement.broadcast', 'n'), 'n=0', 'portal claims see 0 broadcasts');
SELECT is(pg_temp.pa(1, 'SELECT 1 FROM engagement.broadcast', 'n'), 'n=0', 'partner claims see 0 broadcasts');
SELECT is(pg_temp.pa(1, $q$INSERT INTO engagement.broadcast (id, tenant_id, template_id, audience_filter, status, recipient_count, opted_out_count, requested_by, created_by, updated_by) VALUES ('0190c700-0000-7000-8000-000000000224',
  '01a1a98a-ac40-7000-8000-00000000a001', '0190c700-0000-7000-8000-000000000201', '{"party_kinds":["client"]}', 'draft', 1, 0, '01a1a98a-ac40-7000-8000-00000000a30c', '01a1a98a-ac40-7000-8000-00000000a30c', '01a1a98a-ac40-7000-8000-00000000a30c')$q$), 'E42501', 'a partner actor cannot create a broadcast');

-- ===================================================================================================================================== (3) engagement.broadcast_recipient
SELECT has_table('engagement'::name, 'broadcast_recipient'::name, 'engagement.broadcast_recipient exists');
SELECT is(pg_temp.cols_missing('engagement.broadcast_recipient', ARRAY['id','tenant_id','broadcast_id','party_kind','party_id','channel_address','status','outbox_id','created_at','created_by','updated_at']), NULL, 'broadcast_recipient has the 11 columns');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('engagement.broadcast_recipient')), true, 'broadcast_recipient: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('engagement.broadcast_recipient') AND polcmd = 'd'), 0, 'broadcast_recipient: no DELETE policy');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('engagement.broadcast_recipient') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND pg_get_expr(polwithcheck, polrelid) !~ 'tenant_id')), 0, 'broadcast_recipient: every policy is tenant scoped');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'engagement.broadcast_recipient', 'SELECT') AND has_table_privilege('lims_app', 'engagement.broadcast_recipient', 'INSERT')
  AND has_table_privilege('lims_app', 'engagement.broadcast_recipient', 'UPDATE') AND NOT has_table_privilege('lims_app', 'engagement.broadcast_recipient', 'DELETE'))::text$q$), 'true', 'broadcast_recipient: lims_app has SELECT, INSERT, UPDATE and no DELETE');
SELECT is(pg_temp.ins('engagement.broadcast_recipient', jsonb_build_object('id', pg_temp.uid(231), 'tenant_id', pg_temp.ta(), 'broadcast_id', pg_temp.uid(223), 'party_kind', 'client', 'party_id', pg_temp.uid(1011),
  'channel_address', '9800000001', 'status', 'queued', 'outbox_id', pg_temp.uid(241))), 'ok', 'recipient insert: client queued with its outbox row');
SELECT is(pg_temp.ins('engagement.broadcast_recipient', jsonb_build_object('id', pg_temp.uid(232), 'tenant_id', pg_temp.ta(), 'broadcast_id', pg_temp.uid(223), 'party_kind', 'franchise', 'party_id', pg_temp.uid(1012),
  'channel_address', '9800000002', 'status', 'skipped')), 'ok', 'recipient insert: franchise skipped (opted out), no outbox row');
SELECT is(pg_temp.ins('engagement.broadcast_recipient', jsonb_build_object('id', pg_temp.uid(233), 'tenant_id', pg_temp.tb(), 'broadcast_id', pg_temp.uid(213), 'party_kind', 'client', 'party_id', pg_temp.uid(1013),
  'channel_address', '9800000003', 'status', 'queued')), 'ok', 'recipient insert: tenant B');
SELECT is(pg_temp.ins('engagement.broadcast_recipient', jsonb_build_object('id', pg_temp.uid(234), 'tenant_id', pg_temp.ta(), 'broadcast_id', pg_temp.uid(213), 'party_kind', 'client', 'party_id', pg_temp.uid(1013),
  'channel_address', '9800000004', 'status', 'queued')), '23503', 'recipient insert: a broadcast of tenant B is rejected (composite FK)');
SELECT is(pg_temp.ins('engagement.broadcast_recipient', jsonb_build_object('id', pg_temp.uid(235), 'tenant_id', pg_temp.ta(), 'broadcast_id', pg_temp.uid(223), 'party_kind', 'client', 'party_id', pg_temp.uid(1011),
  'channel_address', '9800000001', 'status', 'queued')), '23505', 'recipient insert: the same party twice in one broadcast is rejected (never two messages to one party)');
SELECT is(pg_temp.ins('engagement.broadcast_recipient', jsonb_build_object('id', pg_temp.uid(236), 'tenant_id', pg_temp.ta(), 'broadcast_id', pg_temp.uid(223), 'party_kind', 'lab_user', 'party_id', pg_temp.uid(1012),
  'channel_address', '9800000005', 'status', 'queued', 'outbox_id', pg_temp.uid(241))), '23505', 'recipient insert: one outbox row serves one recipient only (outbox_id unique)');
SELECT is(pg_temp.ins('engagement.broadcast_recipient', jsonb_build_object('id', pg_temp.uid(237), 'tenant_id', pg_temp.ta(), 'broadcast_id', pg_temp.uid(223), 'party_kind', 'lab_user', 'party_id', pg_temp.uid(1013),
  'channel_address', '9800000006', 'status', 'failed')), 'ok', 'recipient insert: several recipients without an outbox row are fine (outbox_id null is not unique)');
SELECT is(pg_temp.ins('engagement.broadcast_recipient', jsonb_build_object('id', pg_temp.uid(238), 'tenant_id', pg_temp.ta(), 'broadcast_id', pg_temp.uid(223), 'party_kind', 'patient', 'party_id', pg_temp.uid(1014),
  'channel_address', '9800000007', 'status', 'queued')), '23514', 'recipient insert: unknown party kind rejected (patients are not an audience)');
SELECT is(pg_temp.ins('engagement.broadcast_recipient', jsonb_build_object('id', pg_temp.uid(239), 'tenant_id', pg_temp.ta(), 'broadcast_id', pg_temp.uid(223), 'party_kind', 'client', 'party_id', pg_temp.uid(1015),
  'channel_address', '9800000008', 'status', 'delivered')), '23514', 'recipient insert: unknown status rejected');
SELECT is(pg_temp.a($q$UPDATE engagement.broadcast_recipient SET status = 'sent' WHERE id = '0190c700-0000-7000-8000-000000000231'$q$), 'n=1', 'tenant A staff moves a recipient to sent');
SELECT is(pg_temp.a($q$DELETE FROM engagement.broadcast_recipient WHERE id = '0190c700-0000-7000-8000-000000000231'$q$), 'E42501', 'tenant A staff cannot DELETE a recipient (no grant)');
SELECT is(pg_temp.a($q$SELECT 1 FROM engagement.broadcast_recipient$q$, 'n'), 'n=3', 'tenant A staff sees its 3 recipients (231, 232, 237)');
SELECT is(pg_temp.b($q$SELECT 1 FROM engagement.broadcast_recipient$q$, 'n'), 'n=1', 'tenant B staff sees its 1 recipient');
SELECT is(pg_temp.a($q$SELECT 1 FROM engagement.broadcast_recipient WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$, 'n'), 'n=0', 'tenant A cannot read tenant B recipients by filter');
SELECT is(pg_temp.a($q$UPDATE engagement.broadcast_recipient SET status = 'failed' WHERE id = '0190c700-0000-7000-8000-000000000233'$q$), 'n=0', 'tenant A cannot update a tenant B recipient');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM engagement.broadcast_recipient', 'n'), 'n=0', 'patient claims see 0 recipients');
SELECT is(pg_temp.pa(1, 'SELECT 1 FROM engagement.broadcast_recipient', 'n'), 'n=0', 'partner claims see 0 recipients (a partner never sees who else was messaged)');

-- ===================================================================================================================================== (4) partners.partner_ticket
SELECT has_table('partners'::name, 'partner_ticket'::name, 'partners.partner_ticket exists');
SELECT is(pg_temp.cols_missing('partners.partner_ticket', ARRAY['id','tenant_id','party_kind','party_id','subject','status','version','created_at','created_by','updated_at','updated_by']), NULL, 'partner_ticket has the 11 columns');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('partners.partner_ticket')), true, 'partner_ticket: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('partners.partner_ticket') AND polcmd = 'd'), 0, 'partner_ticket: no DELETE policy');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('partners.partner_ticket') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND pg_get_expr(polwithcheck, polrelid) !~ 'tenant_id')), 0, 'partner_ticket: every policy is tenant scoped');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('partners.partner_ticket') AND polcmd = 'r' AND pg_get_expr(polqual, polrelid) ~ 'current_partner_id'), 1, 'partner_ticket: exactly one SELECT policy binds the partner actor to its own partner');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'partners.partner_ticket', 'SELECT') AND has_table_privilege('lims_app', 'partners.partner_ticket', 'INSERT')
  AND has_table_privilege('lims_app', 'partners.partner_ticket', 'UPDATE') AND NOT has_table_privilege('lims_app', 'partners.partner_ticket', 'DELETE'))::text$q$), 'true', 'partner_ticket: lims_app has SELECT, INSERT, UPDATE and no DELETE');
SELECT is(pg_temp.ins('partners.partner_ticket', jsonb_build_object('id', pg_temp.uid(251), 'tenant_id', pg_temp.ta(), 'party_kind', 'partner', 'party_id', pg_temp.uid(1001), 'subject', 'Report delay (SYNTHETIC)', 'status', 'new')), 'ok', 'ticket insert: tenant A / partner P1 / new');
SELECT is(pg_temp.ins('partners.partner_ticket', jsonb_build_object('id', pg_temp.uid(252), 'tenant_id', pg_temp.ta(), 'party_kind', 'partner', 'party_id', pg_temp.uid(1002), 'subject', 'Pickup question (SYNTHETIC)', 'status', 'replied')), 'ok', 'ticket insert: tenant A / partner P2 / replied');
SELECT is(pg_temp.ins('partners.partner_ticket', jsonb_build_object('id', pg_temp.uid(253), 'tenant_id', pg_temp.tb(), 'party_kind', 'partner', 'party_id', pg_temp.uid(1003), 'subject', 'Notice B (SYNTHETIC)', 'status', 'new')), 'ok', 'ticket insert: tenant B');
SELECT is(pg_temp.ins('partners.partner_ticket', jsonb_build_object('id', pg_temp.uid(254), 'tenant_id', pg_temp.ta(), 'party_kind', 'partner', 'party_id', pg_temp.uid(1001), 'subject', 'x', 'status', 'open')), '23514', 'ticket insert: unknown status rejected (new, replied, closed only)');
SELECT is(pg_temp.ins('partners.partner_ticket', jsonb_build_object('id', pg_temp.uid(255), 'tenant_id', pg_temp.ta(), 'party_kind', 'bogus', 'party_id', pg_temp.uid(1001), 'subject', 'x', 'status', 'new')), '23514', 'ticket insert: unknown party kind rejected');
SELECT is(pg_temp.ins('partners.partner_ticket', jsonb_build_object('id', pg_temp.uid(256), 'tenant_id', pg_temp.ta(), 'party_kind', 'partner', 'party_id', pg_temp.uid(1001), 'subject', '', 'status', 'new')), '23514', 'ticket insert: empty subject rejected');
SELECT is(pg_temp.q($q$SELECT version::text FROM partners.partner_ticket WHERE id = '0190c700-0000-7000-8000-000000000251'$q$), '1', 'ticket: version starts at 1');
-- staff
SELECT is(pg_temp.a($q$SELECT 1 FROM partners.partner_ticket$q$, 'n'), 'n=2', 'tenant A staff sees both partners tickets');
SELECT is(pg_temp.b($q$SELECT 1 FROM partners.partner_ticket$q$, 'n'), 'n=1', 'tenant B staff sees its 1 ticket');
SELECT is(pg_temp.a($q$SELECT 1 FROM partners.partner_ticket WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$, 'n'), 'n=0', 'tenant A cannot read tenant B tickets by filter');
SELECT is(pg_temp.a($q$UPDATE partners.partner_ticket SET status = 'closed' WHERE id = '0190c700-0000-7000-8000-000000000252'$q$), 'n=1', 'tenant A staff closes a ticket');
SELECT is(pg_temp.a($q$UPDATE partners.partner_ticket SET status = 'new' WHERE id = '0190c700-0000-7000-8000-000000000252'$q$), 'n=1', 'tenant A staff reopens a ticket');
SELECT is(pg_temp.a($q$UPDATE partners.partner_ticket SET status = 'closed' WHERE id = '0190c700-0000-7000-8000-000000000253'$q$), 'n=0', 'tenant A cannot update a tenant B ticket');
SELECT is(pg_temp.a($q$DELETE FROM partners.partner_ticket WHERE id = '0190c700-0000-7000-8000-000000000251'$q$), 'E42501', 'tenant A staff cannot DELETE a ticket (no grant)');
SELECT is(pg_temp.a($q$INSERT INTO partners.partner_ticket (id, tenant_id, party_kind, party_id, subject, status, created_by, updated_by) VALUES ('0190c700-0000-7000-8000-000000000257',
  '01a1a98a-ac40-7000-8000-00000000b001', 'partner', '0190c700-0000-7000-8000-000000001003', 'x', 'new', '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a300')$q$), 'E42501', 'tenant A cannot insert a ticket for tenant B (RLS WITH CHECK)');
-- partner actors: only their own partner
SELECT is(pg_temp.pa(1, 'SELECT 1 FROM partners.partner_ticket', 'n'), 'n=1', 'partner P1 sees only its own ticket');
SELECT is(pg_temp.pa(2, 'SELECT 1 FROM partners.partner_ticket', 'n'), 'n=1', 'partner P2 sees only its own ticket');
SELECT is(pg_temp.pa(1, $q$SELECT 1 FROM partners.partner_ticket WHERE id = '0190c700-0000-7000-8000-000000000252'$q$, 'n'), 'n=0', 'partner P1 cannot read the ticket of partner P2 (not found, not forbidden)');
SELECT is(pg_temp.pa(1, $q$SELECT 1 FROM partners.partner_ticket WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$, 'n'), 'n=0', 'partner P1 cannot read a tenant B ticket');
SELECT is(pg_temp.pa(1, $q$INSERT INTO partners.partner_ticket (id, tenant_id, party_kind, party_id, subject, status, created_by, updated_by) VALUES ('0190c700-0000-7000-8000-000000000258',
  '01a1a98a-ac40-7000-8000-00000000a001', 'partner', '0190c700-0000-7000-8000-000000001001', 'Need a pickup (SYNTHETIC)', 'new', '01a1a98a-ac40-7000-8000-00000000a30c', '01a1a98a-ac40-7000-8000-00000000a30c')$q$), 'n=1', 'partner P1 creates a ticket for itself');
SELECT is(pg_temp.pa(1, $q$INSERT INTO partners.partner_ticket (id, tenant_id, party_kind, party_id, subject, status, created_by, updated_by) VALUES ('0190c700-0000-7000-8000-000000000259',
  '01a1a98a-ac40-7000-8000-00000000a001', 'partner', '0190c700-0000-7000-8000-000000001002', 'Forged for P2', 'new', '01a1a98a-ac40-7000-8000-00000000a30c', '01a1a98a-ac40-7000-8000-00000000a30c')$q$), 'E42501', 'partner P1 cannot create a ticket for partner P2 (RLS WITH CHECK)');
SELECT is(pg_temp.pa(1, $q$DELETE FROM partners.partner_ticket WHERE id = '0190c700-0000-7000-8000-000000000251'$q$), 'E42501', 'a partner actor cannot DELETE a ticket');
SELECT is(pg_temp.pa(1, $q$UPDATE partners.partner_ticket SET status = 'closed' WHERE id = '0190c700-0000-7000-8000-000000000252'$q$), 'n=0', 'partner P1 cannot update the ticket of partner P2');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM partners.partner_ticket', 'n'), 'n=0', 'patient claims see 0 tickets');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal'), 'SELECT 1 FROM partners.partner_ticket', 'n'), 'n=0', 'portal claims see 0 tickets');

-- ===================================================================================================================================== (5) partners.partner_ticket_message
SELECT has_table('partners'::name, 'partner_ticket_message'::name, 'partners.partner_ticket_message exists');
SELECT is(pg_temp.cols_missing('partners.partner_ticket_message', ARRAY['id','tenant_id','ticket_id','sender_kind','body','created_by','created_at']), NULL, 'partner_ticket_message has the 7 columns');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('partners.partner_ticket_message')), true, 'partner_ticket_message: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('partners.partner_ticket_message') AND polcmd IN ('d','w')), 0, 'partner_ticket_message: no UPDATE and no DELETE policy (append only)');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('partners.partner_ticket_message') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND pg_get_expr(polwithcheck, polrelid) !~ 'tenant_id')), 0, 'partner_ticket_message: every policy is tenant scoped');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'partners.partner_ticket_message', 'SELECT') AND has_table_privilege('lims_app', 'partners.partner_ticket_message', 'INSERT')
  AND NOT has_table_privilege('lims_app', 'partners.partner_ticket_message', 'UPDATE') AND NOT has_table_privilege('lims_app', 'partners.partner_ticket_message', 'DELETE'))::text$q$), 'true', 'partner_ticket_message: lims_app has SELECT and INSERT only');
SELECT is(pg_temp.ins('partners.partner_ticket_message', jsonb_build_object('id', pg_temp.uid(261), 'tenant_id', pg_temp.ta(), 'ticket_id', pg_temp.uid(251), 'sender_kind', 'partner', 'body', 'Where is my report? (SYNTHETIC)')), 'ok', 'message insert: partner message on P1 ticket');
SELECT is(pg_temp.ins('partners.partner_ticket_message', jsonb_build_object('id', pg_temp.uid(262), 'tenant_id', pg_temp.ta(), 'ticket_id', pg_temp.uid(252), 'sender_kind', 'lab', 'body', 'Pickup is at 10:00. (SYNTHETIC)')), 'ok', 'message insert: lab reply on P2 ticket');
SELECT is(pg_temp.ins('partners.partner_ticket_message', jsonb_build_object('id', pg_temp.uid(263), 'tenant_id', pg_temp.tb(), 'ticket_id', pg_temp.uid(253), 'sender_kind', 'partner', 'body', 'Hello (SYNTHETIC)')), 'ok', 'message insert: tenant B');
SELECT is(pg_temp.ins('partners.partner_ticket_message', jsonb_build_object('id', pg_temp.uid(264), 'tenant_id', pg_temp.ta(), 'ticket_id', pg_temp.uid(253), 'sender_kind', 'partner', 'body', 'x')), '23503', 'message insert: a ticket of tenant B is rejected (composite FK)');
SELECT is(pg_temp.ins('partners.partner_ticket_message', jsonb_build_object('id', pg_temp.uid(265), 'tenant_id', pg_temp.ta(), 'ticket_id', pg_temp.uid(251), 'sender_kind', 'system', 'body', 'x')), '23514', 'message insert: sender kind other than partner or lab rejected');
SELECT is(pg_temp.ins('partners.partner_ticket_message', jsonb_build_object('id', pg_temp.uid(266), 'tenant_id', pg_temp.ta(), 'ticket_id', pg_temp.uid(251), 'sender_kind', 'lab', 'body', '')), '23514', 'message insert: empty body rejected');
SELECT is(pg_temp.a($q$SELECT 1 FROM partners.partner_ticket_message$q$, 'n'), 'n=2', 'tenant A staff sees its 2 messages');
SELECT is(pg_temp.b($q$SELECT 1 FROM partners.partner_ticket_message$q$, 'n'), 'n=1', 'tenant B staff sees its 1 message');
SELECT is(pg_temp.a($q$INSERT INTO partners.partner_ticket_message (id, tenant_id, ticket_id, sender_kind, body, created_by) VALUES ('0190c700-0000-7000-8000-000000000267',
  '01a1a98a-ac40-7000-8000-00000000a001', '0190c700-0000-7000-8000-000000000251', 'lab', 'We are checking. (SYNTHETIC)', '01a1a98a-ac40-7000-8000-00000000a300')$q$), 'n=1', 'tenant A staff replies as the lab');
SELECT is(pg_temp.a($q$UPDATE partners.partner_ticket_message SET body = 'edited' WHERE id = '0190c700-0000-7000-8000-000000000261'$q$), 'E42501', 'tenant A staff cannot UPDATE a message (append only)');
SELECT is(pg_temp.a($q$DELETE FROM partners.partner_ticket_message WHERE id = '0190c700-0000-7000-8000-000000000261'$q$), 'E42501', 'tenant A staff cannot DELETE a message');
SELECT is(pg_temp.a($q$SELECT 1 FROM partners.partner_ticket_message WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$, 'n'), 'n=0', 'tenant A cannot read tenant B messages by filter');
-- partner actors: messages of their own tickets only, and only as the partner
SELECT is(pg_temp.pa(1, 'SELECT 1 FROM partners.partner_ticket_message', 'n'), 'n=2', 'partner P1 sees the 2 messages of its own ticket (its own and the lab reply)');
SELECT is(pg_temp.pa(1, $q$SELECT 1 FROM partners.partner_ticket_message WHERE ticket_id = '0190c700-0000-7000-8000-000000000252'$q$, 'n'), 'n=0', 'partner P1 cannot read the messages of partner P2');
SELECT is(pg_temp.pa(2, 'SELECT 1 FROM partners.partner_ticket_message', 'n'), 'n=1', 'partner P2 sees only its own thread');
SELECT is(pg_temp.pa(1, $q$INSERT INTO partners.partner_ticket_message (id, tenant_id, ticket_id, sender_kind, body, created_by) VALUES ('0190c700-0000-7000-8000-000000000268',
  '01a1a98a-ac40-7000-8000-00000000a001', '0190c700-0000-7000-8000-000000000251', 'partner', 'Any news? (SYNTHETIC)', '01a1a98a-ac40-7000-8000-00000000a30c')$q$), 'n=1', 'partner P1 replies on its own ticket');
SELECT is(pg_temp.pa(1, $q$INSERT INTO partners.partner_ticket_message (id, tenant_id, ticket_id, sender_kind, body, created_by) VALUES ('0190c700-0000-7000-8000-000000000269',
  '01a1a98a-ac40-7000-8000-00000000a001', '0190c700-0000-7000-8000-000000000251', 'lab', 'Pretending to be the lab', '01a1a98a-ac40-7000-8000-00000000a30c')$q$), 'E42501', 'partner P1 cannot write a message as the lab');
SELECT is(pg_temp.pa(1, $q$INSERT INTO partners.partner_ticket_message (id, tenant_id, ticket_id, sender_kind, body, created_by) VALUES ('0190c700-0000-7000-8000-000000000270',
  '01a1a98a-ac40-7000-8000-00000000a001', '0190c700-0000-7000-8000-000000000252', 'partner', 'Into the ticket of P2', '01a1a98a-ac40-7000-8000-00000000a30c')$q$), 'E42501', 'partner P1 cannot reply on the ticket of partner P2');
SELECT is(pg_temp.pa(1, $q$UPDATE partners.partner_ticket_message SET body = 'edited' WHERE id = '0190c700-0000-7000-8000-000000000261'$q$), 'E42501', 'a partner actor cannot UPDATE a message');
SELECT is(pg_temp.pa(1, $q$DELETE FROM partners.partner_ticket_message WHERE id = '0190c700-0000-7000-8000-000000000261'$q$), 'E42501', 'a partner actor cannot DELETE a message');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM partners.partner_ticket_message', 'n'), 'n=0', 'patient claims see 0 messages');

-- ===================================================================================================================================== (6) idempotent re-apply: second run changes nothing
CREATE TEMP TABLE before_state AS
  SELECT (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace IN ('engagement'::regnamespace, 'partners'::regnamespace) AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped) AS cols,
         (SELECT count(*) FROM pg_constraint k WHERE k.connamespace IN ('engagement'::regnamespace, 'partners'::regnamespace)) AS cons,
         (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace IN ('engagement'::regnamespace, 'partners'::regnamespace)) AS idxs,
         (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace IN ('engagement'::regnamespace, 'partners'::regnamespace)) AS pols,
         (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace IN ('engagement'::regnamespace, 'partners'::regnamespace) AND NOT t.tgisinternal) AS trgs,
         (SELECT count(*) FROM pg_class c WHERE c.relnamespace IN ('engagement'::regnamespace, 'partners'::regnamespace) AND c.relkind IN ('r','p')) AS tbls,
         (SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint WHERE connamespace IN ('engagement'::regnamespace, 'partners'::regnamespace) AND contype = 'c') AS checks,
         (SELECT count(*) FROM engagement.broadcast_template) AS n_tpl, (SELECT count(*) FROM engagement.broadcast) AS n_bc, (SELECT count(*) FROM engagement.broadcast_recipient) AS n_rcp,
         (SELECT count(*) FROM partners.partner_ticket) AS n_tk, (SELECT count(*) FROM partners.partner_ticket_message) AS n_msg;
\ir ../../migrations/20261117240000_engagement__add_broadcast_and_tickets.sql
RESET ROLE;
SELECT is((SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace IN ('engagement'::regnamespace, 'partners'::regnamespace) AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped), (SELECT cols FROM before_state), 're-apply: column count unchanged');
SELECT is((SELECT count(*) FROM pg_constraint k WHERE k.connamespace IN ('engagement'::regnamespace, 'partners'::regnamespace)), (SELECT cons FROM before_state), 're-apply: constraint count unchanged');
SELECT is((SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace IN ('engagement'::regnamespace, 'partners'::regnamespace)), (SELECT idxs FROM before_state), 're-apply: index count unchanged');
SELECT is((SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace IN ('engagement'::regnamespace, 'partners'::regnamespace)), (SELECT pols FROM before_state), 're-apply: policy count unchanged');
SELECT is((SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace IN ('engagement'::regnamespace, 'partners'::regnamespace) AND NOT t.tgisinternal), (SELECT trgs FROM before_state), 're-apply: trigger count unchanged');
SELECT is((SELECT count(*) FROM pg_class c WHERE c.relnamespace IN ('engagement'::regnamespace, 'partners'::regnamespace) AND c.relkind IN ('r','p')), (SELECT tbls FROM before_state), 're-apply: table count unchanged');
SELECT is((SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conname) FROM pg_constraint WHERE connamespace IN ('engagement'::regnamespace, 'partners'::regnamespace) AND contype = 'c'), (SELECT checks FROM before_state), 're-apply: every CHECK definition unchanged');
SELECT is((SELECT count(*) FROM engagement.broadcast_template), (SELECT n_tpl FROM before_state), 're-apply: no template row added or removed');
SELECT is((SELECT count(*) FROM engagement.broadcast), (SELECT n_bc FROM before_state), 're-apply: no broadcast row added or removed');
SELECT is((SELECT count(*) FROM engagement.broadcast_recipient), (SELECT n_rcp FROM before_state), 're-apply: no recipient row added or removed');
SELECT is((SELECT count(*) FROM partners.partner_ticket), (SELECT n_tk FROM before_state), 're-apply: no ticket row added or removed');
SELECT is((SELECT count(*) FROM partners.partner_ticket_message), (SELECT n_msg FROM before_state), 're-apply: no message row added or removed');
SELECT is(pg_temp.ins('engagement.broadcast', jsonb_build_object('id', pg_temp.uid(271), 'tenant_id', pg_temp.ta(), 'template_id', pg_temp.uid(201), 'audience_filter', '{"party_kinds":["client"]}'::jsonb,
  'status', 'approved', 'recipient_count', 1, 'opted_out_count', 0, 'requested_by', pg_temp.s('a300'), 'approved_by', pg_temp.s('a300'))), '23514', 're-apply: the second person rule still holds');
SELECT is(pg_temp.pa(1, $q$SELECT 1 FROM partners.partner_ticket WHERE id = '0190c700-0000-7000-8000-000000000252'$q$, 'n'), 'n=0', 're-apply: a partner still cannot read another partner ticket');

SELECT * FROM finish();
ROLLBACK;
