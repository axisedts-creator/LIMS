-- C2-T27 DB integration of the per_tenant worker tasks (02-TRD §10: identity.apply_pending_numbering, identity.access_review_due; 08 A13 P-6, A23.1; 05-SCHEMA §5 policies, §11 tests 22/32).
-- The tasks run as lims_worker with the identity system actor's claims PLUS the job tenant (core withTenantScope). Proven here, under FORCE RLS and without disabling it:
--   * tenant_settings: the system actor of tenant A can apply the pending numbering (UPDATE moving pending_* into the live patterns, version bump) on A's row and changes 0 rows of B;
--   * access_reviews: SELECT sees only the job tenant's reviews; admin_notices: INSERT of an access_review_due notice for the job tenant works, for another tenant is refused;
--   * the notice's subject_id must be non-NULL for kind access_review_due (admin_notices__subject__ck).
-- Run: bash db/tests/run-suites.sh db/tests/identity/C2-T27_worker_tenant_tasks.test.sql   (pgTAP, migrated + seeded DB; synthetic data; one rolled-back transaction)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c270-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.claims(p_tenant uuid) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_object('tenant_id', p_tenant, 'sub', pg_temp.sys(), 'actor_type', 'system') $$;
CREATE FUNCTION pg_temp.sysc(p_tenant uuid) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claims', pg_temp.claims(p_tenant)::text, true) $$;
CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE cols text := (SELECT string_agg(quote_ident(k), ',') FROM jsonb_object_keys(p_row) k);
BEGIN EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, p_row::text); END $f$;
CREATE FUNCTION pg_temp.v(p_role text, p_claims jsonb, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN EXECUTE p_sql INTO r; r := coalesce(r, '<none>'); EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;

SELECT is(c.relforcerowsecurity, true, 'FORCE RLS on ' || t) FROM unnest(ARRAY['identity.tenant_settings', 'identity.access_reviews', 'identity.admin_notices']) t JOIN pg_class c ON c.oid = t::regclass;

-- fixtures: settings of A (pending numbering) and B (pending numbering), one old review each (membership ...a500 is tenant A's seed membership; B reuses none: B gets no review)
SELECT pg_temp.sysc(pg_temp.ta());
SELECT pg_temp.ins('identity.tenant_settings', jsonb_build_object('tenant_id', pg_temp.ta(), 'legal_name_snapshot', 'Synthetic Lab Alpha', 'display_name', 'Synthetic Lab Alpha',
  'pending_invoice_no_pattern', 'N{fyl}-{seq:6}', 'pending_credit_note_no_pattern', 'CNN-{fyl}-{seq:6}', 'pending_effective_fy_bs', '2084/85', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.access_reviews', jsonb_build_object('id', pg_temp.uid(1), 'tenant_id', pg_temp.ta(), 'reviewed_by_membership_id', '01a1a98a-ac40-7000-8000-00000000a500', 'memberships_reviewed', 3,
  'reviewed_at', now() - interval '100 days', 'created_by', pg_temp.sys()));
SELECT pg_temp.sysc(pg_temp.tb());
SELECT pg_temp.ins('identity.tenant_settings', jsonb_build_object('tenant_id', pg_temp.tb(), 'legal_name_snapshot', 'Synthetic Lab Beta', 'display_name', 'Synthetic Lab Beta',
  'pending_invoice_no_pattern', 'B{fyl}-{seq:6}', 'pending_effective_fy_bs', '2084/85', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));

-- apply_pending_numbering: as lims_worker, system actor of tenant A
SELECT is(pg_temp.v('lims_worker', pg_temp.claims(pg_temp.ta()), $$WITH u AS (UPDATE identity.tenant_settings SET invoice_no_pattern = coalesce(pending_invoice_no_pattern, invoice_no_pattern),
    credit_note_no_pattern = coalesce(pending_credit_note_no_pattern, credit_note_no_pattern), pending_invoice_no_pattern = NULL, pending_credit_note_no_pattern = NULL, pending_effective_fy_bs = NULL,
    version = version + 1, updated_at = now(), updated_by = '01a1b34e-1000-7eee-9d29-d7ca59a102b5' WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001' AND pending_effective_fy_bs IS NOT NULL RETURNING 1) SELECT count(*)::text FROM u$$),
  '1', 'tenant A system actor applies A''s pending numbering (tenant_settings__update__tenant admits the system actor)');
SELECT is((SELECT invoice_no_pattern || '|' || credit_note_no_pattern || '|' || coalesce(pending_effective_fy_bs, 'NULL') FROM identity.tenant_settings WHERE tenant_id = pg_temp.ta()), 'N{fyl}-{seq:6}|CNN-{fyl}-{seq:6}|NULL',
  'A: live patterns replaced, pending cleared');
SELECT is(pg_temp.v('lims_worker', pg_temp.claims(pg_temp.ta()), $$WITH u AS (UPDATE identity.tenant_settings SET invoice_no_pattern = pending_invoice_no_pattern, pending_invoice_no_pattern = NULL, pending_effective_fy_bs = NULL, updated_by = '01a1b34e-1000-7eee-9d29-d7ca59a102b5'
    WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001' RETURNING 1) SELECT count(*)::text FROM u$$), '0', 'the same system actor under A''s claims changes 0 rows of tenant B (RLS)');
SELECT is((SELECT pending_effective_fy_bs FROM identity.tenant_settings WHERE tenant_id = pg_temp.tb()), '2084/85', 'B''s pending numbering is untouched');

-- access_review_due: reads access_reviews, inserts one notice
SELECT is(pg_temp.v('lims_worker', pg_temp.claims(pg_temp.ta()), 'SELECT count(*)::text FROM identity.access_reviews'), '1', 'tenant A job sees A''s access review');
SELECT is(pg_temp.v('lims_worker', pg_temp.claims(pg_temp.tb()), 'SELECT count(*)::text FROM identity.access_reviews'), '0', 'tenant B job sees none of A''s reviews');
SELECT is(pg_temp.v('lims_worker', pg_temp.claims(pg_temp.ta()), $$WITH i AS (INSERT INTO identity.admin_notices (id, tenant_id, kind, subject_type, subject_id, expires_at, created_by, updated_by)
    VALUES ('0190c270-0000-7000-8000-000000000101', '01a1a98a-ac40-7000-8000-00000000a001', 'access_review_due', 'access_review', '0190c270-0000-7000-8000-000000000001', now() + interval '30 days',
    '01a1b34e-1000-7eee-9d29-d7ca59a102b5', '01a1b34e-1000-7eee-9d29-d7ca59a102b5') RETURNING 1) SELECT count(*)::text FROM i$$), '1', 'tenant A system actor inserts the access_review_due notice');
SELECT matches(pg_temp.v('lims_worker', pg_temp.claims(pg_temp.ta()), $$INSERT INTO identity.admin_notices (id, tenant_id, kind, subject_type, subject_id, expires_at, created_by, updated_by)
    VALUES ('0190c270-0000-7000-8000-000000000102', '01a1a98a-ac40-7000-8000-00000000b001', 'access_review_due', 'access_review', '0190c270-0000-7000-8000-000000000001', now() + interval '30 days',
    '01a1b34e-1000-7eee-9d29-d7ca59a102b5', '01a1b34e-1000-7eee-9d29-d7ca59a102b5') RETURNING 'x'$$), '^E', 'a job under A''s claims cannot insert a notice for tenant B');
SELECT is(pg_temp.v('lims_worker', pg_temp.claims(pg_temp.ta()), $$INSERT INTO identity.admin_notices (id, tenant_id, kind, subject_type, subject_id, expires_at, created_by, updated_by)
    VALUES ('0190c270-0000-7000-8000-000000000103', '01a1a98a-ac40-7000-8000-00000000a001', 'access_review_due', 'access_review', NULL, now() + interval '30 days',
    '01a1b34e-1000-7eee-9d29-d7ca59a102b5', '01a1b34e-1000-7eee-9d29-d7ca59a102b5') RETURNING 'x'$$), 'E23514', 'admin_notices__subject__ck: access_review_due needs a subject_id');
SELECT is(pg_temp.v('lims_worker', pg_temp.claims(pg_temp.tb()), 'SELECT count(*)::text FROM identity.admin_notices'), '0', 'tenant B job does not see A''s notice');

-- no tenant claims: nothing readable (the per_tenant tasks never run without the tenant)
SELECT is(pg_temp.v('lims_worker', jsonb_build_object('sub', pg_temp.sys(), 'actor_type', 'system'), 'SELECT (SELECT count(*) FROM identity.tenant_settings)::text || (SELECT count(*) FROM identity.admin_notices) || (SELECT count(*) FROM identity.access_reviews)'),
  '000', 'system claims without tenant_id see no tenant_settings / admin_notices / access_reviews');

SELECT * FROM finish();
ROLLBACK;
