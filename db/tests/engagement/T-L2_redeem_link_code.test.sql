-- C16.T-L2 live-DB assertions under FORCE RLS: app.engagement_redeem_link_code(bytea), app.engagement_apply_report_link(uuid, timestamptz), the tenant-claim helpers and the patient column guard
-- (05-SCHEMA §6.1 bodies, §4 guard `engagement.guard_patient_link_update`, §6.6 FORCE-RLS tests 1, 2, 3 and 6; 07-SECURITY probe P-L9; 02-TRD §4.3.2 step 2, §4.3.3 step 3, §4.3.5; 08 A2.4/A5.5 bytea = bytea).
-- Synthetic data only. One rolled-back transaction. RLS is never disabled for the assertions (the seed runs with session_replication_role = replica; every assertion runs as lims_app with patient claims).
-- Run: pg_prove -d <migrated db with the engagement DDL of CR-C16-006 and the §6.1 functions> db/tests/engagement/T-L2_redeem_link_code.test.sql   (superuser; pgTAP in schema `extensions`; run from the repo root)
-- Needs a live Postgres with C0 + C16 migrations; it is NOT part of .orchestra/notes/T-L2-verify.cmd (no database in the unit-test environment, same as T-A2 / T-A3 / T-Q3).
-- Fails now: the migrated schema has no engagement.* DDL / app.engagement_redeem_link_code yet (db/migrations has no engagement migration).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\ir ../fixtures/T0B-06_identity_standin.sql

CREATE FUNCTION pg_temp.id(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01950c16-0000-7000-8000-' || lpad(to_hex(k), 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.h(s text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT sha256(convert_to('synthetic-l2-' || s, 'UTF8')) $$;
-- claims of a signed-in patient (post-OTP session): membership p_member of tenant p_tenant (no patient_stage claim)
CREATE FUNCTION pg_temp.pc(p_member int, p_tenant int DEFAULT 1) RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', 'patient', 'tenant_id', pg_temp.id(p_tenant), 'sub', pg_temp.id(p_member + 1000), 'membership_id', pg_temp.id(p_member), 'aal', 'aal1')::text $$;
-- run p_sql as lims_app with the claims p_claims. modes: v scalar text ('<null>' when no row), n row count of a SELECT, w DML row count. Errors come back as 'E<SQLSTATE>:<message>'.
CREATE FUNCTION pg_temp.x(p_claims text, p_sql text, p_mode text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE 'SET LOCAL ROLE lims_app';
  BEGIN
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSIF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := n::text;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := n::text; END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
-- as the superuser (no RLS): read back state
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $$ DECLARE r text; BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r, '<null>'); END $$;
-- the redeem call, flattened to one text value
CREATE FUNCTION pg_temp.redeem(p_member int, p_tenant int, p_code text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.x(pg_temp.pc(p_member, p_tenant),
    format($q$SELECT concat_ws('|', link_code_id, patient_id, relationship, display_name_snapshot, sex_snapshot, existing_link_id, existing_link_was_suspended) FROM app.engagement_redeem_link_code(%L::bytea)$q$, '\x' || encode(pg_temp.h(p_code), 'hex')), 'v') $$;

-- ---------------------------------------------------------------- fixtures: tenants 1 (A) and 2 (B); patient accounts 301 / 302 (A), 303 (B); codes; links
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id(1), 'tpl_a', 'Lab A', 'Lab A', 'active', pg_temp.id(99), pg_temp.id(99)), (pg_temp.id(2), 'tpl_b', 'Lab B', 'Lab B', 'active', pg_temp.id(99), pg_temp.id(99));
INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, created_by, updated_by) VALUES
  (pg_temp.id(401), pg_temp.id(1), pg_temp.id(1401), 'patient', pg_temp.id(99), pg_temp.id(99)), (pg_temp.id(402), pg_temp.id(1), pg_temp.id(1402), 'patient', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(403), pg_temp.id(2), pg_temp.id(1403), 'patient', pg_temp.id(99), pg_temp.id(99));
INSERT INTO engagement.accounts (id, tenant_id, membership_id, user_id, phone_e164, phone_hmac, created_by, updated_by) VALUES
  (pg_temp.id(301), pg_temp.id(1), pg_temp.id(401), pg_temp.id(1401), '+99003000001', pg_temp.h('p301'), pg_temp.id(98), pg_temp.id(98)),
  (pg_temp.id(302), pg_temp.id(1), pg_temp.id(402), pg_temp.id(1402), '+99003000002', pg_temp.h('p302'), pg_temp.id(98), pg_temp.id(98)),
  (pg_temp.id(303), pg_temp.id(2), pg_temp.id(403), pg_temp.id(1403), '+99003000003', pg_temp.h('p303'), pg_temp.id(98), pg_temp.id(98));
-- codes: 601 P501 bound to 301 (self, female); 608 P501 bound to 301 (wrong-phone probe); 603 P501 EXPIRED; 602 P502 bound to 302 (reactivation); 607 P504 bound to 301 (widen); 604 tenant B P503 bound to 303; 606 redeemed (parent of link 801)
INSERT INTO engagement.link_codes (id, tenant_id, patient_id, code_hmac, bound_phone_hmac, bound_phone_last2, record_phone_hmac, relationship, consent_id, display_name_snapshot, sex_snapshot, issued_by_membership_id, status, redeemed_at, redeemed_account_id, created_at, created_by, expires_at, updated_at, updated_by) VALUES
  (pg_temp.id(601), pg_temp.id(1), pg_temp.id(501), pg_temp.h('code601'), pg_temp.h('p301'), '01', pg_temp.h('rec501'), 'self',  pg_temp.id(701), 'Synthetic One',   'female', pg_temp.id(97), 'issued',   NULL, NULL, now(), pg_temp.id(97), now() + interval '72 hours', now(), pg_temp.id(97)),
  (pg_temp.id(608), pg_temp.id(1), pg_temp.id(501), pg_temp.h('code608'), pg_temp.h('p301'), '01', pg_temp.h('rec501'), 'self',  pg_temp.id(701), 'Synthetic One',   'female', pg_temp.id(97), 'issued',   NULL, NULL, now(), pg_temp.id(97), now() + interval '72 hours', now(), pg_temp.id(97)),
  (pg_temp.id(603), pg_temp.id(1), pg_temp.id(501), pg_temp.h('code603'), pg_temp.h('p301'), '01', NULL,                'self',  pg_temp.id(701), 'Synthetic One',   'female', pg_temp.id(97), 'issued',   NULL, NULL, now() - interval '100 hours', pg_temp.id(97), now() - interval '1 hour', now(), pg_temp.id(97)),
  (pg_temp.id(602), pg_temp.id(1), pg_temp.id(502), pg_temp.h('code602'), pg_temp.h('p302'), '02', pg_temp.h('rec502'), 'child', pg_temp.id(702), 'Synthetic Two',   'male',   pg_temp.id(97), 'issued',   NULL, NULL, now(), pg_temp.id(97), now() + interval '72 hours', now(), pg_temp.id(97)),
  (pg_temp.id(607), pg_temp.id(1), pg_temp.id(504), pg_temp.h('code607'), pg_temp.h('p301'), '01', pg_temp.h('rec504'), 'other', pg_temp.id(703), 'Synthetic Four',  'female', pg_temp.id(97), 'issued',   NULL, NULL, now(), pg_temp.id(97), now() + interval '72 hours', now(), pg_temp.id(97)),
  (pg_temp.id(604), pg_temp.id(2), pg_temp.id(503), pg_temp.h('code604'), pg_temp.h('p303'), '03', NULL,                'self',  pg_temp.id(704), 'Synthetic Three', 'female', pg_temp.id(97), 'issued',   NULL, NULL, now(), pg_temp.id(97), now() + interval '72 hours', now(), pg_temp.id(97)),
  (pg_temp.id(606), pg_temp.id(1), pg_temp.id(502), pg_temp.h('code606'), pg_temp.h('p302'), '02', NULL,                'child', pg_temp.id(702), 'Synthetic Two',   'male',   pg_temp.id(97), 'redeemed', now() - interval '20 days', pg_temp.id(302), now() - interval '21 days', pg_temp.id(97), now() - interval '18 days', now(), pg_temp.id(97));
INSERT INTO engagement.account_patient_links (id, tenant_id, account_id, patient_id, relationship, method, link_code_id, display_name, sex_snapshot, status, suspend_reason, suspended_at, visible_from, record_phone_hmac_at_link, created_by, updated_by) VALUES
  -- 801: acct 302 / P502 SUSPENDED (phone_mismatch) with a visible_from; 802: acct 301 / P504 active report_link with visible_from; 803: acct 301 / P505 active, visible_from set (apply_report_link: least);
  -- 804: acct 301 / P506 active, visible_from NULL; 805: acct 302 / P507 suspended (apply_report_link reactivation); 806: acct 302 / P508 suspended (guard probe)
  (pg_temp.id(801), pg_temp.id(1), pg_temp.id(302), pg_temp.id(502), 'child', 'link_code',   pg_temp.id(606), 'Synthetic Two',  NULL,     'suspended', 'phone_mismatch', now() - interval '1 hour', now() - interval '10 days', pg_temp.h('old'), pg_temp.id(98), pg_temp.id(98)),
  (pg_temp.id(802), pg_temp.id(1), pg_temp.id(301), pg_temp.id(504), 'other', 'report_link', NULL,              'Synthetic Four', NULL,     'active',    NULL, NULL, '2026-02-01T00:00:00Z', NULL, pg_temp.id(98), pg_temp.id(98)),
  (pg_temp.id(803), pg_temp.id(1), pg_temp.id(301), pg_temp.id(505), 'other', 'report_link', NULL,              'Synthetic Five', NULL,     'active',    NULL, NULL, '2026-03-01T00:00:00Z', NULL, pg_temp.id(98), pg_temp.id(98)),
  (pg_temp.id(804), pg_temp.id(1), pg_temp.id(301), pg_temp.id(506), 'other', 'report_link', NULL,              'Synthetic Six',  NULL,     'active',    NULL, NULL, NULL, NULL, pg_temp.id(98), pg_temp.id(98)),
  (pg_temp.id(805), pg_temp.id(1), pg_temp.id(302), pg_temp.id(507), 'other', 'report_link', NULL,              'Synthetic Seven', NULL,    'suspended', 'dormant', now() - interval '1 day', '2026-01-01T00:00:00Z', pg_temp.h('old'), pg_temp.id(98), pg_temp.id(98)),
  (pg_temp.id(806), pg_temp.id(1), pg_temp.id(302), pg_temp.id(508), 'other', 'report_link', NULL,              'Synthetic Eight', NULL,    'suspended', 'dormant', now() - interval '1 day', '2026-01-01T00:00:00Z', NULL, pg_temp.id(98), pg_temp.id(98));
SET LOCAL session_replication_role = origin;

-- ================================================================ §6.6 test 1: helpers return the expected value for tenant A and nothing for tenant B claims
SELECT is(pg_temp.x(pg_temp.pc(401, 1), 'SELECT app.engagement_account_id()::text', 'v'), pg_temp.id(301)::text, 'T1: account id of patient 401 (tenant A)');
SELECT is(pg_temp.x(pg_temp.pc(401, 2), 'SELECT app.engagement_account_id()::text', 'v'), '<null>', 'T1: tenant B claims carrying a tenant A membership: no account');
SELECT is(pg_temp.x(pg_temp.pc(403, 1), 'SELECT app.engagement_account_id()::text', 'v'), '<null>', 'T1: a tenant B membership under tenant A claims: no account');
SELECT is(pg_temp.x(pg_temp.pc(401, 1), 'SELECT (SELECT array_agg(p ORDER BY p) FROM unnest(app.engagement_patient_ids()) p)::text', 'v'), '{' || pg_temp.id(504) || ',' || pg_temp.id(505) || ',' || pg_temp.id(506) || '}', 'T1: patient ids = the ACTIVE links of account 301 only');
SELECT is(pg_temp.x(pg_temp.pc(403, 2), 'SELECT app.engagement_patient_ids()::text', 'v'), '{}', 'T1: tenant B account without links: empty');
SELECT is(pg_temp.x(pg_temp.pc(401, 1), format('SELECT app.engagement_patient_visible(%L, now())', pg_temp.id(504)), 'v'), 'true', 'T1: patient_visible: an active link with visible_from 2026-02-01 is visible now');
SELECT is(pg_temp.x(pg_temp.pc(401, 1), format('SELECT app.engagement_patient_visible(%L, now())', pg_temp.id(502)), 'v'), 'false', 'T1: a patient whose link is suspended (502, account 302) is not visible to account 301');

-- ================================================================ §6.6 test 2: redeem
SELECT is(pg_temp.x(pg_temp.pc(401, 1), 'SELECT count(*) FROM engagement.link_codes', 'v'), '0', 'patient actors have no policy on link_codes (SELECT sees 0 rows)');
SELECT is(pg_temp.x(pg_temp.pc(401, 1), $$UPDATE engagement.link_codes SET status = 'redeemed', redeemed_at = now(), redeemed_account_id = (SELECT app.engagement_account_id())$$, 'w'), '0', 'patient actors cannot UPDATE link_codes directly (0 rows)');
SELECT matches(pg_temp.x(pg_temp.pc(401, 1), $$SELECT * FROM app.engagement_redeem_link_code('abc'::text)$$, 'v'), '^E42883', 'a text parameter is refused: the signature is (bytea) (08 A2.4)');

SELECT is(pg_temp.redeem(402, 1, 'code601'), '<null>', 'another account (phone p302) redeeming 601 (bound to p301): no row');
SELECT is(pg_temp.q($$SELECT status FROM engagement.link_codes WHERE id = '$$ || pg_temp.id(601) || $$'$$), 'issued', 'wrong phone: the code is still issued');
SELECT is(pg_temp.redeem(403, 2, 'code601'), '<null>', 'tenant B claims cannot redeem a tenant A code');
SELECT is(pg_temp.redeem(401, 1, 'code603'), '<null>', 'an EXPIRED code: no row');
SELECT is(pg_temp.redeem(401, 1, 'nosuchcode'), '<null>', 'an unknown code: no row');
SELECT is(pg_temp.redeem(401, 1, 'code604'), '<null>', 'a tenant B code under tenant A claims: no row');

SELECT is(pg_temp.redeem(401, 1, 'code601'), pg_temp.id(601) || '|' || pg_temp.id(501) || '|self|Synthetic One|female||false', 'redeem for the bound phone: (code, patient, relationship, name, sex, no existing link)');
SELECT is(pg_temp.q($$SELECT status || '/' || (redeemed_account_id = '$$ || pg_temp.id(301) || $$')::text FROM engagement.link_codes WHERE id = '$$ || pg_temp.id(601) || $$'$$), 'redeemed/true', 'the code is redeemed by account 301');
SELECT is(pg_temp.redeem(401, 1, 'code601'), '<null>', 'redeeming it again: no row (single use)');
SELECT is(pg_temp.redeem(402, 1, 'code601'), '<null>', 'and by any other account: no row');
SELECT is(pg_temp.q($$SELECT count(*) FROM engagement.account_patient_links WHERE patient_id = '$$ || pg_temp.id(501) || $$'$$), '0', 'the DEFINER inserts no link when none exists (the service does, after the limits)');

-- existing SUSPENDED link of the same (account, patient): reactivated INSIDE the DEFINER (the guard would refuse the same change for the patient)
SELECT is(pg_temp.redeem(402, 1, 'code602'), pg_temp.id(602) || '|' || pg_temp.id(502) || '|child|Synthetic Two|male|' || pg_temp.id(801) || '|true', 'redeem for a patient with a suspended link: existing_link_id + was_suspended');
SELECT is(pg_temp.q($$SELECT concat_ws('|', status, coalesce(suspend_reason, 'null'), coalesce(suspended_at::text, 'null'), coalesce(visible_from::text, 'null'), method, link_code_id, version, sex_snapshot, (record_phone_hmac_at_link = $$ || quote_literal('\x' || encode(pg_temp.h('rec502'), 'hex')) || $$::bytea)::text) FROM engagement.account_patient_links WHERE id = '$$ || pg_temp.id(801) || $$'$$),
  'active|null|null|null|link_code|' || pg_temp.id(602) || '|2|male|true', 'link 801: active, suspension cleared, visible_from NULL, method link_code, link_code_id set, version + 1, sex copied, record_phone_hmac_at_link refreshed');
-- existing ACTIVE report link: widened to full history, method upgraded
SELECT is(pg_temp.redeem(401, 1, 'code607'), pg_temp.id(607) || '|' || pg_temp.id(504) || '|other|Synthetic Four|female|' || pg_temp.id(802) || '|false', 'redeem for a patient with an active link: existing_link_id, was_suspended false');
SELECT is(pg_temp.q($$SELECT concat_ws('|', status, coalesce(visible_from::text, 'null'), method, link_code_id) FROM engagement.account_patient_links WHERE id = '$$ || pg_temp.id(802) || $$'$$), 'active|null|link_code|' || pg_temp.id(607), 'link 802: visible_from NULL, method link_code');

-- ================================================================ §6.6 test 3: engagement_apply_report_link
SELECT is(pg_temp.x(pg_temp.pc(401, 1), format('SELECT concat_ws(%L, link_id, prior_status) FROM app.engagement_apply_report_link(%L, %L::timestamptz)', '|', pg_temp.id(505), '2026-02-01T00:00:00Z'), 'v'), pg_temp.id(803) || '|active', 'active link: row returned');
SELECT is(pg_temp.q($$SELECT visible_from::text FROM engagement.account_patient_links WHERE id = '$$ || pg_temp.id(803) || $$'$$), '2026-02-01 00:00:00+00', 'active link: visible_from = least(old, released_at)');
SELECT is(pg_temp.x(pg_temp.pc(401, 1), format('SELECT link_id FROM app.engagement_apply_report_link(%L, %L::timestamptz)', pg_temp.id(505), '2026-04-01T00:00:00Z'), 'v'), pg_temp.id(803)::text, 'a later released_at is accepted ...');
SELECT is(pg_temp.q($$SELECT visible_from::text FROM engagement.account_patient_links WHERE id = '$$ || pg_temp.id(803) || $$'$$), '2026-02-01 00:00:00+00', '... but never narrows the history');
SELECT is(pg_temp.x(pg_temp.pc(401, 1), format('SELECT link_id FROM app.engagement_apply_report_link(%L, %L::timestamptz)', pg_temp.id(506), '2026-02-01T00:00:00Z'), 'v'), pg_temp.id(804)::text, 'full-history link: row returned');
SELECT is(pg_temp.q($$SELECT coalesce(visible_from::text, 'null') FROM engagement.account_patient_links WHERE id = '$$ || pg_temp.id(804) || $$'$$), 'null', 'full-history link (visible_from NULL) stays NULL');
SELECT is(pg_temp.x(pg_temp.pc(402, 1), format('SELECT concat_ws(%L, link_id, prior_status) FROM app.engagement_apply_report_link(%L, %L::timestamptz)', '|', pg_temp.id(507), '2026-02-15T00:00:00Z'), 'v'), pg_temp.id(805) || '|suspended', 'suspended link: row returned with prior_status suspended');
SELECT is(pg_temp.q($$SELECT concat_ws('|', status, coalesce(suspend_reason, 'null'), coalesce(suspended_at::text, 'null'), visible_from::text, method, (record_phone_hmac_at_link = $$ || quote_literal('\x' || encode(pg_temp.h('p302'), 'hex')) || $$::bytea)::text) FROM engagement.account_patient_links WHERE id = '$$ || pg_temp.id(805) || $$'$$),
  'active|null|null|2026-02-15 00:00:00+00|report_link|true', 'suspended link: reactivated, visible_from = released_at, record_phone_hmac_at_link = the account phone hmac, method unchanged');
SELECT is(pg_temp.x(pg_temp.pc(401, 1), format('SELECT link_id FROM app.engagement_apply_report_link(%L, %L::timestamptz)', pg_temp.id(599), '2026-02-01T00:00:00Z'), 'v'), '<null>', 'no link for that patient: no row');
SELECT is(pg_temp.x(pg_temp.pc(401, 1), format('SELECT link_id FROM app.engagement_apply_report_link(%L, %L::timestamptz)', pg_temp.id(507), '2026-02-01T00:00:00Z'), 'v'), '<null>', 'another account\'s link of that patient: no row');

-- ================================================================ §6.6 test 6 / probe P-L9: the patient column guard (outside a DEFINER)
SELECT matches(pg_temp.x(pg_temp.pc(402, 1), format($u$UPDATE engagement.account_patient_links SET status = 'active', suspend_reason = NULL, suspended_at = NULL WHERE id = %L$u$, pg_temp.id(806)), 'w'), 'immutable_row', 'P-L9: patient UPDATE suspended -> active raises immutable_row');
SELECT matches(pg_temp.x(pg_temp.pc(402, 1), format($u$UPDATE engagement.account_patient_links SET visible_from = NULL WHERE id = %L$u$, pg_temp.id(806)), 'w'), 'immutable_row', 'P-L9: patient UPDATE visible_from -> NULL raises immutable_row');
SELECT matches(pg_temp.x(pg_temp.pc(401, 1), format($u$UPDATE engagement.account_patient_links SET method = 'link_code' WHERE id = %L$u$, pg_temp.id(803)), 'w'), 'immutable_row', 'P-L9: patient UPDATE of method raises immutable_row');
SELECT matches(pg_temp.x(pg_temp.pc(401, 1), format($u$UPDATE engagement.account_patient_links SET link_code_id = %L WHERE id = %L$u$, pg_temp.id(601), pg_temp.id(803)), 'w'), 'immutable_row', 'P-L9: patient UPDATE of link_code_id raises immutable_row');
SELECT is(pg_temp.x(pg_temp.pc(401, 1), format($u$UPDATE engagement.account_patient_links SET relationship = 'parent' WHERE id = %L$u$, pg_temp.id(803)), 'w'), '1', 'P-L9: a relationship change succeeds');
SELECT is(pg_temp.x(pg_temp.pc(401, 1), format($u$UPDATE engagement.account_patient_links SET status = 'revoked', revoked_by_kind = 'account', revoked_reason_code = 'patient_request', revoked_at = now() WHERE id = %L$u$, pg_temp.id(804)), 'w'), '1', 'P-L9: revoke (remove profile) succeeds');
SELECT is(pg_temp.x(pg_temp.pc(401, 1), format($u$UPDATE engagement.account_patient_links SET relationship = 'parent' WHERE id = %L$u$, pg_temp.id(806)), 'w'), '0', 'another account\'s link: 0 rows (PAT_ACC)');
SELECT is(pg_temp.q($$SELECT status FROM engagement.account_patient_links WHERE id = '$$ || pg_temp.id(806) || $$'$$), 'suspended', 'link 806 is still suspended after the refused attempts');

SELECT * FROM finish();
ROLLBACK;
