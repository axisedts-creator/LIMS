-- C6-T43 live-DB check of 02-TRD §14 row "Second fix pass" (b) (08 A21.4 / A12.7): the four C6 pre-tenant DEFINERs use app.pre_* GUC names and leave every GUC '' on EVERY return path
-- (found row, no row, wrong input, unknown token, early reject of ingest) + a `lims_app` session that sets the same GUC itself sees nothing; (a) A21.1 schema/policy facts that hold in
-- the DB: portal_links.purpose / portal_sessions.link_purpose CHECKs, dues links are sms|whatsapp patient links only, redeem DEFINER refuses a dues link.
-- Fixture-free where possible (unknown tokens). Run: pg_prove -d <db> db/tests/reporting/C6-T43.a21.test.sql   (pgTAP in schema `extensions`; migrations loaded; superuser). NOT run in the tester sandbox (no Postgres).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.guc_empty(p_name text) RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting(p_name, true), '') = '' $$;
CREATE FUNCTION pg_temp.all_empty() RETURNS boolean LANGUAGE sql AS $$
  SELECT bool_and(pg_temp.guc_empty(g)) FROM unnest(ARRAY['app.pre_qr_token_sha256', 'app.pre_portal_credential_sha256', 'app.pre_portal_token_sha256',
    'app.pre_callback_token_sha256', 'app.pre_callback_tenant_id', 'app.pre_callback_channel_account_id']) g $$;

-- (b) names: no app.lookup_* left in any of the four bodies; each body sets and resets its app.pre_* GUC
SELECT is((SELECT count(*)::int FROM pg_proc p WHERE p.oid IN ('app.reporting_verify_qr(bytea)'::regprocedure, 'app.reporting_resolve_portal_credential(text, bytea)'::regprocedure,
  'app.reporting_ingest_provider_callback(text, bytea, jsonb)'::regprocedure, 'app.reporting_redeem_link_for_app(bytea, bytea)'::regprocedure) AND p.prosrc ~ 'app\.lookup_'), 0, 'A21.4: no app.lookup_* GUC in the four C6 DEFINERs');
SELECT ok((SELECT p.prosrc ~ 'set_config\(''app\.pre_qr_token_sha256'', ''''' FROM pg_proc p WHERE p.oid = 'app.reporting_verify_qr(bytea)'::regprocedure), 'verify_qr resets app.pre_qr_token_sha256');
SELECT ok((SELECT p.prosrc ~ 'set_config\(''app\.pre_portal_credential_sha256'', ''''' FROM pg_proc p WHERE p.oid = 'app.reporting_resolve_portal_credential(text, bytea)'::regprocedure), 'resolve resets app.pre_portal_credential_sha256');
SELECT ok((SELECT p.prosrc ~ 'set_config\(''app\.pre_portal_token_sha256'', ''''' FROM pg_proc p WHERE p.oid = 'app.reporting_redeem_link_for_app(bytea, bytea)'::regprocedure), 'redeem resets app.pre_portal_token_sha256');
SELECT ok((SELECT p.prosrc ~ 'pre_callback_token_sha256.*pre_callback_tenant_id.*pre_callback_channel_account_id' FROM pg_proc p WHERE p.oid = 'app.reporting_ingest_provider_callback(text, bytea, jsonb)'::regprocedure), 'ingest uses the three app.pre_callback_* GUCs');
SELECT is((SELECT prorettype::regtype::text FROM pg_proc WHERE oid = 'app.reporting_resolve_portal_credential(text, bytea)'::regprocedure), 'record', 'resolve returns a table');
SELECT ok(EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proargnames) n WHERE p.oid = 'app.reporting_resolve_portal_credential(text, bytea)'::regprocedure AND n = 'purpose'), 'A21.1: reporting_resolve_portal_credential returns `purpose`');

-- (b) every return path leaves the GUCs empty (unknown / malformed inputs; the found-row paths are in T0B-10.C6_behaviour)
SELECT is((SELECT count(*)::int FROM app.reporting_verify_qr(decode(repeat('ee', 32), 'hex'))), 0, 'verify_qr: unknown token -> 0 rows');
SELECT ok(pg_temp.all_empty(), 'verify_qr: all GUCs empty after the no-row return');
SELECT is((SELECT count(*)::int FROM app.reporting_verify_qr(decode('abcd', 'hex'))), 0, 'verify_qr: wrong length -> 0 rows'); SELECT ok(pg_temp.all_empty(), 'verify_qr: empty after the early return');
SELECT is((SELECT count(*)::int FROM app.reporting_resolve_portal_credential('link', decode(repeat('ee', 32), 'hex'))), 0, 'resolve: unknown link -> 0 rows'); SELECT ok(pg_temp.all_empty(), 'resolve(link): empty after return');
SELECT is((SELECT count(*)::int FROM app.reporting_resolve_portal_credential('session', decode(repeat('ee', 32), 'hex'))), 0, 'resolve: unknown session -> 0 rows'); SELECT ok(pg_temp.all_empty(), 'resolve(session): empty after return');
SELECT is((SELECT count(*)::int FROM app.reporting_resolve_portal_credential('bogus', decode(repeat('ee', 32), 'hex'))), 0, 'resolve: unknown kind -> 0 rows'); SELECT ok(pg_temp.all_empty(), 'resolve(kind): empty after the early return');
SELECT is((SELECT count(*)::int FROM app.reporting_redeem_link_for_app(decode(repeat('ee', 32), 'hex'), decode(repeat('ff', 32), 'hex'))), 0, 'redeem: unknown token -> 0 rows'); SELECT ok(pg_temp.all_empty(), 'redeem: empty after the invalid-link return');
SELECT is((SELECT count(*)::int FROM app.reporting_redeem_link_for_app(decode('ee', 'hex'), decode('ff', 'hex'))), 0, 'redeem: wrong length -> 0 rows'); SELECT ok(pg_temp.all_empty(), 'redeem: empty after the early return');
SELECT is(app.reporting_ingest_provider_callback('recording', decode(repeat('ee', 32), 'hex'), '[]'::jsonb), NULL::uuid, 'ingest: unknown callback token -> NULL (early reject; LD-49(b): NULL, not -1)'); SELECT ok(pg_temp.all_empty(), 'ingest: all three callback GUCs empty after the reject');
SELECT is(app.reporting_ingest_provider_callback('recording', decode('ee', 'hex'), '[]'::jsonb), NULL::uuid, 'ingest: malformed token -> NULL'); SELECT ok(pg_temp.all_empty(), 'ingest: empty after the malformed-token reject');
SELECT is(app.reporting_ingest_provider_callback('recording', decode(repeat('ee', 32), 'hex'), '{}'::jsonb), NULL::uuid, 'ingest: non-array payload -> NULL'); SELECT ok(pg_temp.all_empty(), 'ingest: empty after the payload reject');

-- A20 / A12.7: a lims_app session setting the GUC itself sees nothing (policies are TO lims_reporting_lookup only)
SET LOCAL ROLE lims_app;
SELECT set_config('app.pre_qr_token_sha256', repeat('ab', 32), true); SELECT is((SELECT count(*)::int FROM reporting.qr_tokens), 0, 'A20: lims_app + app.pre_qr_token_sha256 -> 0 qr_tokens');
SELECT set_config('app.pre_portal_credential_sha256', repeat('11', 32), true); SELECT is((SELECT count(*)::int FROM reporting.portal_links), 0, 'A20: lims_app + app.pre_portal_credential_sha256 -> 0 portal_links');
SELECT is((SELECT count(*)::int FROM reporting.portal_sessions), 0, 'A20: ... 0 portal_sessions');
SELECT set_config('app.pre_portal_token_sha256', repeat('11', 32), true); SELECT is((SELECT count(*)::int FROM reporting.portal_links), 0, 'A20: lims_app + app.pre_portal_token_sha256 -> 0 portal_links');
SELECT set_config('app.pre_callback_token_sha256', repeat('44', 32), true); SELECT is((SELECT count(*)::int FROM reporting.channel_accounts), 0, 'A20: lims_app + app.pre_callback_token_sha256 -> 0 channel_accounts');
RESET ROLE;

-- (a) A21.1 constraints (checked through scratch tables built from the real CHECK text; no fixtures)
CREATE TEMP TABLE pl (purpose text, recipient_kind text, channel text);
CREATE TEMP TABLE ps (link_purpose text);
DO $$
DECLARE d text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'portal_links__purpose__ck' AND conrelid = 'reporting.portal_links'::regclass;
  EXECUTE 'ALTER TABLE pl ADD CONSTRAINT ck ' || d;
  SELECT pg_get_constraintdef(oid) INTO d FROM pg_constraint WHERE conname = 'portal_sessions__purpose__ck' AND conrelid = 'reporting.portal_sessions'::regclass;
  EXECUTE 'ALTER TABLE ps ADD CONSTRAINT ck ' || d;
END $$;
SELECT lives_ok($$INSERT INTO pl VALUES ('dues', 'patient', 'sms')$$, 'A21.1: dues link to a patient by sms');
SELECT lives_ok($$INSERT INTO pl VALUES ('dues', 'patient', 'whatsapp')$$, 'A21.1: dues link to a patient by whatsapp');
SELECT throws_ok($$INSERT INTO pl VALUES ('dues', 'patient', 'email')$$, '23514', NULL, 'A21.1: a dues link is never e-mailed');
SELECT throws_ok($$INSERT INTO pl VALUES ('dues', 'referrer', 'sms')$$, '23514', NULL, 'A21.1: a dues link is for patients only');
SELECT throws_ok($$INSERT INTO pl VALUES ('invoice', 'patient', 'sms')$$, '23514', NULL, 'purpose is report|dues');
SELECT lives_ok($$INSERT INTO ps VALUES ('dues')$$, 'portal_sessions.link_purpose dues'); SELECT throws_ok($$INSERT INTO ps VALUES ('other')$$, '23514', NULL, 'portal_sessions.link_purpose is report|dues');
SELECT is((SELECT p.prosrc ~ 'purpose = ''report''' FROM pg_proc p WHERE p.oid = 'app.reporting_redeem_link_for_app(bytea, bytea)'::regprocedure), true, 'A27: the redeem DEFINER only accepts purpose = report links (a dues link -> 0 rows)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'reporting' AND tablename IN ('report_versions', 'qr_tokens') AND policyname LIKE '%__select__portal' AND qual !~ 'portal_link_purpose'), 0, 'A21.1: the portal SELECT policies on report_versions / qr_tokens require portal_link_purpose = report');

SELECT * FROM finish();
ROLLBACK;
