-- T0C-PRINTCFG-1 pgTAP suite (LD-316, LD-319(1), LD-335; founder 2026-11-17 08:39 NPT: own notepad header and footer on printed reports and bills, signer profiles, plain black and white bill)
-- for migration 20261117160000_reporting__add_print_profiles_and_signatories.sql:
--   reporting.print_profile   (one active row per tenant, branch, document kind (and recipient type); text rules; mm and pt bounds; RLS by tenant)
--   reporting.signatory_profile (one row per user; signature image id optional; RLS by tenant)
--   billing.print_log.style   (the print record stores the style used: full | plain_bw, old rows read 'full')
-- Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written by the superuser test session with system claims (audit context),
-- every isolation assertion runs as SET LOCAL ROLE lims_app. Seeds 010 supply tenant A/B (a001/b001), branches a101/a102/b101, users a300..a306/b300..b304.
-- Run: bash db/tests/run-suites.sh db/tests/reporting/T0C-PRINTCFG-1_print_profiles.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (the brief lists columns and rules, not every constraint name; a different choice needs a ruling, not a silent test edit; names equal the contract test printcfg1-openapi.test.ts):
--  - reporting.print_profile(id, tenant_id, branch_id NULL = lab default, document_kind, recipient_type NULL = every recipient (LD-319(1)), paper_mode, header_text, footer_text, reserve_top_mm, reserve_bottom_mm,
--    show_logo, show_seller_pan DEFAULT true, grayscale, font_size_pt, is_active (the brief says `active`; the repo convention is is_active, either name passes here), version, created_at, created_by, updated_at, updated_by).
--  - document_kind report | invoice | credit_note; paper_mode letterhead_image | typed_header_footer | preprinted_paper | plain; recipient_type patient | doctor | franchise | laboratory | other.
--  - header_text / footer_text: plain text, at most 8 lines of at most 120 characters (lines split at newline), no markup: '<' and '>' refused, control characters (other than newline) refused. Violations -> 23514.
--  - reserve_top_mm 0..80, reserve_bottom_mm 0..60, font_size_pt 8..12 (CHECK, 23514).
--  - Uniqueness: one ACTIVE row per (tenant, branch, document_kind, recipient_type) where a NULL branch (lab default) and a NULL recipient type are each ONE value (23505); inactive rows may repeat.
--  - reporting.signatory_profile(id?, tenant_id, user_id, display_name, title, registration_no, signature_asset_id NULL, is_active, version, created_*, updated_at, updated_by): UNIQUE (tenant_id, user_id) (one row per user,
--    active or not), FK (tenant_id, user_id) -> core.users, display_name not empty. The asset id FK target is not pinned here (no fixture is invented).
--  - Both new tables: RLS enabled and FORCE-d, tenant scoped policies, staff or system only (patient and partner claims see 0 rows), a row audit trigger (app.tg_row_audit, class M).
--  - billing.print_log.style text NOT NULL DEFAULT 'full' CHECK IN ('full','plain_bw'); print_log stays append only for lims_app (SELECT, INSERT only).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c700-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.brA1() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a101'::uuid $$;
CREATE FUNCTION pg_temp.brA2() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a102'::uuid $$;
CREATE FUNCTION pg_temp.brB1() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b101'::uuid $$;
CREATE FUNCTION pg_temp.usrA(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-00000000a30' || n::text)::uuid $$;
CREATE FUNCTION pg_temp.usrB(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-00000000b30' || n::text)::uuid $$;
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'user') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a300' ELSE '01a1a98a-ac40-7000-8000-00000000b300' END::uuid,
    'membership_id', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a500' ELSE '01a1a98a-ac40-7000-8000-00000000b500' END::uuid) $$;
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
-- the active flag is is_active (repo convention) or active (the brief): which one the table has
CREATE FUNCTION pg_temp.actcol(p_tbl text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce((SELECT attname::text FROM pg_attribute WHERE attrelid = to_regclass(p_tbl) AND attname IN ('is_active', 'active') AND NOT attisdropped ORDER BY attname LIMIT 1), 'is_active') $$;
-- a valid print profile of tenant p_tenant with id uid(p_n); p_extra overrides keys (a key set to JSON null stays a key: use `- 'key'` to drop one)
CREATE FUNCTION pg_temp.pj(p_n int, p_tenant uuid, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(p_n), 'tenant_id', p_tenant, 'document_kind', 'report', 'paper_mode', 'typed_header_footer',
    'header_text', E'Synthetic Lab\nKathmandu (SYNTHETIC)', 'footer_text', 'Synthetic footer line', 'reserve_top_mm', 0, 'reserve_bottom_mm', 0,
    'show_logo', false, 'show_seller_pan', true, 'grayscale', false, 'font_size_pt', 10, pg_temp.actcol('reporting.print_profile'), true) || p_extra $$;
CREATE FUNCTION pg_temp.ip(p_n int, p_tenant uuid, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.ins('reporting.print_profile', pg_temp.pj(p_n, p_tenant, p_extra)) $$;
-- a valid signatory profile row
CREATE FUNCTION pg_temp.sj(p_user uuid, p_tenant uuid, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('tenant_id', p_tenant, 'user_id', p_user, 'display_name', 'Dr Synthetic Pathologist', 'title', 'Consultant Pathologist', 'registration_no', 'SYN-REG-0001',
    pg_temp.actcol('reporting.signatory_profile'), true) || p_extra $$;
CREATE FUNCTION pg_temp.isg(p_user uuid, p_tenant uuid, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.ins('reporting.signatory_profile', pg_temp.sj(p_user, p_tenant, p_extra)) $$;
-- a valid billing.print_log row
CREATE FUNCTION pg_temp.lj(p_n int, p_tenant uuid, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(p_n), 'tenant_id', p_tenant, 'document_kind', 'invoice', 'document_id', pg_temp.uid(p_n + 5000), 'document_no', 'SYN/2082-83/' || p_n,
    'print_no', 1, 'is_copy', false, 'reason_code', 'first_print', 'printed_at', now()) || p_extra $$;
CREATE FUNCTION pg_temp.il(p_n int, p_tenant uuid, p_extra jsonb DEFAULT '{}'::jsonb) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.ins('billing.print_log', pg_temp.lj(p_n, p_tenant, p_extra)) $$;
CREATE FUNCTION pg_temp.lines(p_lines int, p_len int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT string_agg(repeat('x', p_len), E'\n') FROM generate_series(1, p_lines) $$;

-- ===================================================================================================================================== (1) shape, RLS, audit, grants
SELECT has_table('reporting'::name, 'print_profile'::name, 'reporting.print_profile exists');
SELECT has_table('reporting'::name, 'signatory_profile'::name, 'reporting.signatory_profile exists');
SELECT is((SELECT string_agg(c, ',') FROM unnest(ARRAY['id','tenant_id','branch_id','document_kind','recipient_type','paper_mode','header_text','footer_text','reserve_top_mm','reserve_bottom_mm','show_logo','show_seller_pan','grayscale','font_size_pt','created_at','updated_at','updated_by']) c
           WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('reporting.print_profile') AND a.attname = c AND NOT a.attisdropped AND a.attnum > 0)), NULL,
  'print_profile has every column of the brief (plus recipient_type, LD-319(1))');
SELECT is((SELECT count(*)::int FROM pg_attribute WHERE attrelid = to_regclass('reporting.print_profile') AND attname IN ('is_active', 'active') AND NOT attisdropped AND atttypid = 'boolean'::regtype), 1, 'print_profile has exactly one boolean active flag (is_active or active)');
SELECT is((SELECT string_agg(c, ',') FROM unnest(ARRAY['tenant_id','user_id','display_name','title','registration_no','signature_asset_id','updated_at','updated_by']) c
           WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('reporting.signatory_profile') AND a.attname = c AND NOT a.attisdropped AND a.attnum > 0)), NULL,
  'signatory_profile has every column of the brief');
SELECT is((SELECT count(*)::int FROM pg_attribute WHERE attrelid = to_regclass('reporting.signatory_profile') AND attname IN ('is_active', 'active') AND NOT attisdropped AND atttypid = 'boolean'::regtype), 1, 'signatory_profile has exactly one boolean active flag');
SELECT is((SELECT attnotnull FROM pg_attribute WHERE attrelid = to_regclass('reporting.signatory_profile') AND attname = 'signature_asset_id'), false, 'signature_asset_id is nullable (a signer without an image is allowed)');
SELECT is((SELECT attnotnull FROM pg_attribute WHERE attrelid = to_regclass('reporting.print_profile') AND attname = 'branch_id'), false, 'print_profile.branch_id is nullable (NULL = the lab default)');
SELECT is((SELECT count(*)::int FROM pg_attribute WHERE attrelid = to_regclass('reporting.print_profile') AND attname IN ('reserve_top_mm','reserve_bottom_mm','font_size_pt') AND atttypid IN ('int2'::regtype,'int4'::regtype)), 3, 'mm and pt values are whole numbers');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('reporting.print_profile')), true, 'print_profile: RLS enabled and FORCE-d');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = to_regclass('reporting.signatory_profile')), true, 'signatory_profile: RLS enabled and FORCE-d');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('reporting.print_profile') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND coalesce(pg_get_expr(polwithcheck, polrelid), '') !~ 'tenant_id')), 0, 'print_profile: every policy is tenant scoped');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('reporting.signatory_profile') AND (pg_get_expr(polqual, polrelid) !~ 'tenant_id' AND coalesce(pg_get_expr(polwithcheck, polrelid), '') !~ 'tenant_id')), 0, 'signatory_profile: every policy is tenant scoped');
SELECT cmp_ok((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('reporting.print_profile') AND polcmd IN ('r','a','w','*')), '>=', 3, 'print_profile: SELECT, INSERT and UPDATE are covered by a policy');
SELECT cmp_ok((SELECT count(*)::int FROM pg_policy WHERE polrelid = to_regclass('reporting.signatory_profile') AND polcmd IN ('r','a','w','*')), '>=', 3, 'signatory_profile: SELECT, INSERT and UPDATE are covered by a policy');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'reporting.print_profile', 'SELECT') AND has_table_privilege('lims_app', 'reporting.print_profile', 'INSERT') AND has_table_privilege('lims_app', 'reporting.print_profile', 'UPDATE'))::text$q$), 'true', 'print_profile: lims_app has SELECT, INSERT and UPDATE');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'reporting.signatory_profile', 'SELECT') AND has_table_privilege('lims_app', 'reporting.signatory_profile', 'INSERT') AND has_table_privilege('lims_app', 'reporting.signatory_profile', 'UPDATE'))::text$q$), 'true', 'signatory_profile: lims_app has SELECT, INSERT and UPDATE');
SELECT is(pg_temp.q($q$SELECT (NOT has_table_privilege('anon', 'reporting.print_profile', 'SELECT') AND NOT has_table_privilege('anon', 'reporting.signatory_profile', 'SELECT'))::text$q$), 'true', 'neither table is readable by anon');
SELECT is(pg_temp.q($q$SELECT (EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = 'reporting.print_profile'::regclass AND NOT t.tgisinternal AND p.proname = 'tg_row_audit'))::text$q$), 'true', 'print_profile: row audit trigger (a header change is audited)');
SELECT is(pg_temp.q($q$SELECT (EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = 'reporting.signatory_profile'::regclass AND NOT t.tgisinternal AND p.proname = 'tg_row_audit'))::text$q$), 'true', 'signatory_profile: row audit trigger (a signature image change is audited)');

-- ===================================================================================================================================== (2) print_profile inserts and CHECKs
SELECT is(pg_temp.ip(301, pg_temp.ta()), 'ok', 'insert: tenant A lab default report profile (branch NULL)');
SELECT is(pg_temp.ip(302, pg_temp.tb()), 'ok', 'insert: tenant B lab default report profile');
SELECT is(pg_temp.ip(303, pg_temp.ta(), jsonb_build_object('branch_id', pg_temp.brA1())), 'ok', 'insert: tenant A branch 1 report profile (a branch row and the lab default coexist)');
SELECT is(pg_temp.ip(304, pg_temp.ta(), jsonb_build_object('branch_id', pg_temp.brA2())), 'ok', 'insert: tenant A branch 2 report profile (another branch, same kind)');
SELECT is(pg_temp.ip(305, pg_temp.ta(), jsonb_build_object('document_kind', 'invoice')), 'ok', 'insert: tenant A lab default invoice profile (same branch NULL, another document kind)');
SELECT is(pg_temp.ip(306, pg_temp.ta(), jsonb_build_object('document_kind', 'credit_note')), 'ok', 'insert: tenant A lab default credit_note profile');
SELECT is(pg_temp.ip(307, pg_temp.ta(), jsonb_build_object('recipient_type', 'patient')), 'ok', 'insert: tenant A lab default report profile for the recipient type patient (LD-319(1))');
SELECT is(pg_temp.ip(308, pg_temp.ta(), jsonb_build_object('recipient_type', 'doctor')), 'ok', 'insert: tenant A lab default report profile for the recipient type doctor');
SELECT is(pg_temp.ip(309, pg_temp.ta(), jsonb_build_object('paper_mode', 'plain', 'document_kind', 'invoice', 'branch_id', pg_temp.brA1(), 'header_text', '', 'footer_text', '', 'grayscale', true)), 'ok', 'insert: a plain black and white invoice profile for branch 1, empty header and footer');
SELECT is(pg_temp.ip(310, pg_temp.ta(), jsonb_build_object('document_kind', 'report', 'paper_mode', 'preprinted_paper', 'reserve_top_mm', 80, 'reserve_bottom_mm', 60, 'font_size_pt', 12, 'is_active', false) - 'is_active' || jsonb_build_object(pg_temp.actcol('reporting.print_profile'), false)), 'ok',
  'insert: an INACTIVE preprinted_paper profile at the maximum blank space (80 mm top, 60 mm bottom) and 12 pt');
SELECT is(pg_temp.ip(311, pg_temp.ta(), jsonb_build_object('document_kind', 'report', 'paper_mode', 'letterhead_image', 'reserve_top_mm', 0, 'reserve_bottom_mm', 0, 'font_size_pt', 8, 'show_logo', true, 'branch_id', pg_temp.brA1(), 'recipient_type', 'franchise')), 'ok',
  'insert: letterhead_image with 0 mm and 8 pt (the lower bounds), logo on');
SELECT is(pg_temp.ip(312, pg_temp.ta(), jsonb_build_object('document_kind', 'receipt')), '23514', 'insert: document_kind receipt rejected (report, invoice, credit_note only)');
SELECT is(pg_temp.ip(313, pg_temp.ta(), jsonb_build_object('paper_mode', 'letterhead')), '23514', 'insert: unknown paper_mode rejected');
SELECT is(pg_temp.ip(314, pg_temp.ta(), jsonb_build_object('recipient_type', 'insurer')), '23514', 'insert: unknown recipient_type rejected');
SELECT is(pg_temp.ip(315, pg_temp.ta(), jsonb_build_object('reserve_top_mm', 81)), '23514', 'insert: reserve_top_mm 81 rejected (0 to 80)');
SELECT is(pg_temp.ip(316, pg_temp.ta(), jsonb_build_object('reserve_top_mm', -1)), '23514', 'insert: reserve_top_mm -1 rejected');
SELECT is(pg_temp.ip(317, pg_temp.ta(), jsonb_build_object('reserve_bottom_mm', 61)), '23514', 'insert: reserve_bottom_mm 61 rejected (0 to 60)');
SELECT is(pg_temp.ip(318, pg_temp.ta(), jsonb_build_object('reserve_bottom_mm', -1)), '23514', 'insert: reserve_bottom_mm -1 rejected');
SELECT is(pg_temp.ip(319, pg_temp.ta(), jsonb_build_object('font_size_pt', 7)), '23514', 'insert: font_size_pt 7 rejected (8 to 12)');
SELECT is(pg_temp.ip(320, pg_temp.ta(), jsonb_build_object('font_size_pt', 13)), '23514', 'insert: font_size_pt 13 rejected');
SELECT is(pg_temp.ip(321, pg_temp.ta(), jsonb_build_object('branch_id', pg_temp.brB1())), '23503', 'insert: a tenant B branch on a tenant A profile rejected (composite foreign key)');
SELECT is(pg_temp.ip(322, pg_temp.ta(), jsonb_build_object('branch_id', pg_temp.uid(999))), '23503', 'insert: an unknown branch rejected');
SELECT is(pg_temp.q($q$SELECT (show_seller_pan AND NOT show_logo)::text FROM reporting.print_profile WHERE id = '0190c700-0000-7000-8000-000000000301'$q$), 'true', 'the fixture row keeps show_seller_pan true and show_logo false as inserted');
SELECT is(pg_temp.ins('reporting.print_profile', pg_temp.pj(323, pg_temp.ta(), jsonb_build_object('document_kind', 'invoice', 'branch_id', pg_temp.brA2(), 'is_active', true) - 'is_active') - 'show_seller_pan'), 'ok', 'insert: a profile without show_seller_pan is accepted');
SELECT is(pg_temp.q($q$SELECT show_seller_pan::text FROM reporting.print_profile WHERE id = '0190c700-0000-7000-8000-000000000323'$q$), 'true', 'show_seller_pan DEFAULTS to true (a tax bill carries the seller PAN)');

-- ---- text rules: header_text and footer_text are plain text, at most 8 lines of 120 characters, no markup
SELECT is(pg_temp.ip(330, pg_temp.ta(), jsonb_build_object('document_kind', 'invoice', 'branch_id', pg_temp.brA2(), 'header_text', pg_temp.lines(8, 120), 'footer_text', pg_temp.lines(8, 120), pg_temp.actcol('reporting.print_profile'), false)), 'ok',
  'text: exactly 8 lines of exactly 120 characters accepted in both header and footer');
SELECT is(pg_temp.ip(331, pg_temp.ta(), jsonb_build_object('header_text', pg_temp.lines(9, 10), pg_temp.actcol('reporting.print_profile'), false)), '23514', 'text: 9 lines in header_text rejected');
SELECT is(pg_temp.ip(332, pg_temp.ta(), jsonb_build_object('footer_text', pg_temp.lines(9, 10), pg_temp.actcol('reporting.print_profile'), false)), '23514', 'text: 9 lines in footer_text rejected');
SELECT is(pg_temp.ip(333, pg_temp.ta(), jsonb_build_object('header_text', pg_temp.lines(1, 121), pg_temp.actcol('reporting.print_profile'), false)), '23514', 'text: a header line of 121 characters rejected');
SELECT is(pg_temp.ip(334, pg_temp.ta(), jsonb_build_object('footer_text', pg_temp.lines(1, 121), pg_temp.actcol('reporting.print_profile'), false)), '23514', 'text: a footer line of 121 characters rejected');
SELECT is(pg_temp.ip(335, pg_temp.ta(), jsonb_build_object('header_text', pg_temp.lines(3, 10) || E'\n' || repeat('y', 121), pg_temp.actcol('reporting.print_profile'), false)), '23514', 'text: one long line among short ones rejected');
SELECT is(pg_temp.ip(336, pg_temp.ta(), jsonb_build_object('header_text', '<b>Synthetic Lab</b>', pg_temp.actcol('reporting.print_profile'), false)), '23514', 'text: HTML tags in header_text rejected (no markup)');
SELECT is(pg_temp.ip(337, pg_temp.ta(), jsonb_build_object('footer_text', '<script>alert(1)</script>', pg_temp.actcol('reporting.print_profile'), false)), '23514', 'text: a script tag in footer_text rejected');
SELECT is(pg_temp.ip(338, pg_temp.ta(), jsonb_build_object('header_text', 'Synthetic <img src=x onerror=alert(1)>', pg_temp.actcol('reporting.print_profile'), false)), '23514', 'text: an img tag with an event handler rejected');
SELECT is(pg_temp.ip(339, pg_temp.ta(), jsonb_build_object('footer_text', 'a < b', pg_temp.actcol('reporting.print_profile'), false)), '23514', 'text: a lone < rejected (angle brackets are not allowed at all)');
SELECT is(pg_temp.ip(340, pg_temp.ta(), jsonb_build_object('header_text', 'a > b', pg_temp.actcol('reporting.print_profile'), false)), '23514', 'text: a lone > rejected');
SELECT is(pg_temp.ip(341, pg_temp.ta(), jsonb_build_object('header_text', 'Synthetic' || chr(1) || 'Lab', pg_temp.actcol('reporting.print_profile'), false)), '23514', 'text: a control character rejected (plain text only)');
SELECT is(pg_temp.ip(342, pg_temp.ta(), jsonb_build_object('header_text', 'Synthetic Lab, Kathmandu - PAN 123456789 - Ph 01-5550000 (SYNTHETIC)', 'footer_text', 'Thank you & get well soon; open 6am-8pm', pg_temp.actcol('reporting.print_profile'), false)), 'ok',
  'text: ordinary punctuation (comma, dash, ampersand, semicolon, brackets) is plain text and accepted');
SELECT is(pg_temp.ip(343, pg_temp.ta(), jsonb_build_object('header_text', E'नमस्ते Synthetic Lab', pg_temp.actcol('reporting.print_profile'), false)), 'ok', 'text: Devanagari text accepted (a Nepal lab prints its name in Nepali)');
SELECT ok(pg_temp.q($q$SELECT header_text FROM reporting.print_profile WHERE id = '0190c700-0000-7000-8000-000000000331'$q$) = 'NULL', 'no row was stored by a refused text insert (331)');

-- ---- uniqueness: one active row per tenant, branch, document kind (and recipient type)
SELECT is(pg_temp.ip(350, pg_temp.ta()), '23505', 'unique: a second ACTIVE lab default report profile (branch NULL, same kind) rejected: NULL branch counts as one value');
SELECT is(pg_temp.ip(351, pg_temp.ta(), jsonb_build_object('branch_id', pg_temp.brA1())), '23505', 'unique: a second ACTIVE branch 1 report profile rejected');
SELECT is(pg_temp.ip(352, pg_temp.ta(), jsonb_build_object('recipient_type', 'patient')), '23505', 'unique: a second ACTIVE lab default patient copy report profile rejected');
SELECT is(pg_temp.ip(353, pg_temp.ta(), jsonb_build_object('recipient_type', 'laboratory')), 'ok', 'unique: the recipient type laboratory is a different key and is accepted');
SELECT is(pg_temp.ip(354, pg_temp.ta(), jsonb_build_object(pg_temp.actcol('reporting.print_profile'), false)), 'ok', 'unique: any number of INACTIVE rows may repeat a key (history of older notepads)');
SELECT is(pg_temp.ip(355, pg_temp.ta(), jsonb_build_object(pg_temp.actcol('reporting.print_profile'), false)), 'ok', 'unique: a second inactive row with the same key is accepted');
SELECT is(pg_temp.ip(356, pg_temp.tb()), '23505', 'unique: tenant B also cannot hold two active lab default report profiles');
SELECT is(pg_temp.ip(357, pg_temp.tb(), jsonb_build_object('branch_id', pg_temp.brB1())), 'ok', 'unique: tenant B branch row is a different key');
SELECT is(pg_temp.a($q$UPDATE reporting.print_profile SET is_active = true WHERE id = '0190c700-0000-7000-8000-000000000354'$q$) IN ('E23505') OR pg_temp.a($q$UPDATE reporting.print_profile SET active = true WHERE id = '0190c700-0000-7000-8000-000000000354'$q$) = 'E23505', true,
  'unique: re-activating an old row while another active row holds the key is rejected');

-- ===================================================================================================================================== (3) print_profile RLS and writes
SELECT is(pg_temp.a($q$SELECT 1 FROM reporting.print_profile$q$, 'n'), 'n=' || (SELECT count(*) FROM reporting.print_profile WHERE tenant_id = pg_temp.ta()), 'tenant A staff sees all and only its own profiles');
SELECT is(pg_temp.b($q$SELECT 1 FROM reporting.print_profile$q$, 'n'), 'n=' || (SELECT count(*) FROM reporting.print_profile WHERE tenant_id = pg_temp.tb()), 'tenant B staff sees all and only its own profiles');
SELECT is(pg_temp.a($q$SELECT 1 FROM reporting.print_profile WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$q$, 'n'), 'n=0', 'tenant A cannot read tenant B profiles by filter');
SELECT is(pg_temp.a($q$UPDATE reporting.print_profile SET footer_text = 'hijacked' WHERE id = '0190c700-0000-7000-8000-000000000302'$q$), 'n=0', 'tenant A cannot update a tenant B profile');
SELECT is(pg_temp.b($q$UPDATE reporting.print_profile SET footer_text = 'hijacked' WHERE id = '0190c700-0000-7000-8000-000000000301'$q$), 'n=0', 'tenant B cannot update a tenant A profile');
SELECT is(pg_temp.a($q$UPDATE reporting.print_profile SET footer_text = 'Edited by tenant A staff (SYNTHETIC)' WHERE id = '0190c700-0000-7000-8000-000000000301'$q$), 'n=1', 'tenant A staff can update its own profile');
SELECT is(pg_temp.a($q$UPDATE reporting.print_profile SET footer_text = '<b>x</b>' WHERE id = '0190c700-0000-7000-8000-000000000301'$q$), 'E23514', 'an UPDATE that adds markup is rejected as well (the check is not insert only)');
SELECT is(pg_temp.a($q$UPDATE reporting.print_profile SET header_text = repeat('x', 121) WHERE id = '0190c700-0000-7000-8000-000000000301'$q$), 'E23514', 'an UPDATE with a 121 character line is rejected');
SELECT is(pg_temp.a($q$UPDATE reporting.print_profile SET reserve_top_mm = 90 WHERE id = '0190c700-0000-7000-8000-000000000301'$q$), 'E23514', 'an UPDATE with reserve_top_mm 90 is rejected');
SELECT is(pg_temp.a($q$UPDATE reporting.print_profile SET tenant_id = '01a1a98a-ac40-7000-8000-00000000b001' WHERE id = '0190c700-0000-7000-8000-000000000301'$q$), 'E42501', 'tenant A staff cannot move a profile to tenant B (RLS WITH CHECK)');
SELECT is(pg_temp.a($q$INSERT INTO reporting.print_profile (id, tenant_id, document_kind, paper_mode, header_text, footer_text, reserve_top_mm, reserve_bottom_mm, show_logo, show_seller_pan, grayscale, font_size_pt, created_by, updated_by)
  VALUES ('0190c700-0000-7000-8000-000000000360', '01a1a98a-ac40-7000-8000-00000000b001', 'invoice', 'plain', '', '', 0, 0, false, true, true, 10, '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a300')$q$), 'E42501',
  'tenant A staff cannot insert a profile for tenant B (RLS WITH CHECK)');
SELECT is(pg_temp.a($q$INSERT INTO reporting.print_profile (id, tenant_id, branch_id, document_kind, paper_mode, header_text, footer_text, reserve_top_mm, reserve_bottom_mm, show_logo, show_seller_pan, grayscale, font_size_pt, created_by, updated_by)
  VALUES ('0190c700-0000-7000-8000-000000000361', '01a1a98a-ac40-7000-8000-00000000a001', '01a1a98a-ac40-7000-8000-00000000a101', 'credit_note', 'plain', '', '', 0, 0, false, true, true, 10, '01a1a98a-ac40-7000-8000-00000000a300', '01a1a98a-ac40-7000-8000-00000000a300')$q$), 'n=1',
  'tenant A staff can insert its own profile');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM reporting.print_profile', 'n'), 'n=0', 'patient claims see 0 profiles');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner'), 'SELECT 1 FROM reporting.print_profile', 'n'), 'n=0', 'partner claims see 0 profiles');

-- ===================================================================================================================================== (4) signatory_profile
SELECT is(pg_temp.isg(pg_temp.usrA(4), pg_temp.ta()), 'ok', 'signatory: tenant A pathologist profile (no image)');
SELECT is(pg_temp.q($q$SELECT coalesce(signature_asset_id::text, 'none') FROM reporting.signatory_profile WHERE user_id = '01a1a98a-ac40-7000-8000-00000000a304'$q$), 'none', 'signatory: signature_asset_id stays NULL when not given');
SELECT is(pg_temp.isg(pg_temp.usrB(4), pg_temp.tb()), 'ok', 'signatory: tenant B pathologist profile');
SELECT is(pg_temp.isg(pg_temp.usrA(4), pg_temp.ta(), jsonb_build_object('display_name', 'Dr Another')), '23505', 'signatory: a second row for the same user rejected (one row per user)');
SELECT is(pg_temp.isg(pg_temp.usrA(4), pg_temp.ta(), jsonb_build_object(pg_temp.actcol('reporting.signatory_profile'), false)), '23505', 'signatory: a second INACTIVE row for the same user is rejected too (one row per user, not one active row)');
SELECT is(pg_temp.isg(pg_temp.usrA(3), pg_temp.ta()), 'ok', 'signatory: another user of tenant A gets its own row');
SELECT is(pg_temp.isg(pg_temp.usrB(4), pg_temp.ta(), jsonb_build_object('display_name', 'Cross tenant signer')), '23503', 'signatory: a tenant B user on a tenant A row rejected (composite foreign key to core.users)');
SELECT is(pg_temp.isg(pg_temp.uid(998), pg_temp.ta()), '23503', 'signatory: an unknown user rejected');
SELECT is(pg_temp.isg(pg_temp.usrA(5), pg_temp.ta(), jsonb_build_object('display_name', '')), '23514', 'signatory: an empty display_name rejected');
SELECT is(pg_temp.isg(pg_temp.usrA(6), pg_temp.ta(), jsonb_build_object('title', 'Consultant Histopathologist', 'registration_no', 'NMC-SYN-12345')), 'ok', 'signatory: title and registration_no are stored');
SELECT is(pg_temp.q($q$SELECT (title = 'Consultant Histopathologist' AND registration_no = 'NMC-SYN-12345')::text FROM reporting.signatory_profile WHERE user_id = '01a1a98a-ac40-7000-8000-00000000a306'$q$), 'true', 'signatory: title and registration_no read back as written');
SELECT is(pg_temp.a($q$SELECT 1 FROM reporting.signatory_profile$q$, 'n'), 'n=' || (SELECT count(*) FROM reporting.signatory_profile WHERE tenant_id = pg_temp.ta()), 'tenant A staff sees all and only its own signer profiles');
SELECT is(pg_temp.b($q$SELECT 1 FROM reporting.signatory_profile$q$, 'n'), 'n=1', 'tenant B staff sees its 1 signer profile');
SELECT is(pg_temp.a($q$SELECT 1 FROM reporting.signatory_profile WHERE user_id = '01a1a98a-ac40-7000-8000-00000000b304'$q$, 'n'), 'n=0', 'tenant A cannot read the tenant B signer profile by filter');
SELECT is(pg_temp.a($q$UPDATE reporting.signatory_profile SET display_name = 'hijacked' WHERE user_id = '01a1a98a-ac40-7000-8000-00000000b304'$q$), 'n=0', 'tenant A cannot update the tenant B signer profile');
SELECT is(pg_temp.b($q$UPDATE reporting.signatory_profile SET display_name = 'hijacked' WHERE user_id = '01a1a98a-ac40-7000-8000-00000000a304'$q$), 'n=0', 'tenant B cannot update the tenant A signer profile');
SELECT is(pg_temp.a($q$UPDATE reporting.signatory_profile SET display_name = 'Dr Synthetic Edited' WHERE user_id = '01a1a98a-ac40-7000-8000-00000000a304'$q$), 'n=1', 'tenant A staff can update its own signer profile');
SELECT is(pg_temp.a($q$UPDATE reporting.signatory_profile SET display_name = '' WHERE user_id = '01a1a98a-ac40-7000-8000-00000000a304'$q$), 'E23514', 'an UPDATE to an empty display_name is rejected');
SELECT is(pg_temp.a($q$UPDATE reporting.signatory_profile SET tenant_id = '01a1a98a-ac40-7000-8000-00000000b001' WHERE user_id = '01a1a98a-ac40-7000-8000-00000000a304'$q$), 'E42501', 'tenant A staff cannot move a signer profile to tenant B');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT 1 FROM reporting.signatory_profile', 'n'), 'n=0', 'patient claims see 0 signer profiles');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner'), 'SELECT 1 FROM reporting.signatory_profile', 'n'), 'n=0', 'partner claims see 0 signer profiles');

-- ===================================================================================================================================== (5) billing.print_log.style (the print record stores the style used)
SELECT has_column('billing'::name, 'print_log'::name, 'style'::name, 'billing.print_log has the column style');
SELECT is((SELECT attnotnull FROM pg_attribute WHERE attrelid = to_regclass('billing.print_log') AND attname = 'style'), true, 'print_log.style is NOT NULL');
SELECT is(pg_temp.q($q$SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = 'billing.print_log'::regclass AND a.attname = 'style'$q$), $$'full'::text$$, 'print_log.style DEFAULTS to full');
SELECT is(pg_temp.il(401, pg_temp.ta()), 'ok', 'print_log: a print without a style is accepted (the default applies)');
SELECT is(pg_temp.q($q$SELECT style FROM billing.print_log WHERE id = '0190c700-0000-7000-8000-000000000401'$q$), 'full', 'print_log: the default style stored is full');
SELECT is(pg_temp.il(402, pg_temp.ta(), jsonb_build_object('style', 'plain_bw')), 'ok', 'print_log: style plain_bw accepted');
SELECT is(pg_temp.q($q$SELECT style FROM billing.print_log WHERE id = '0190c700-0000-7000-8000-000000000402'$q$), 'plain_bw', 'print_log: plain_bw is stored as given');
SELECT is(pg_temp.il(403, pg_temp.ta(), jsonb_build_object('style', 'full', 'document_kind', 'credit_note')), 'ok', 'print_log: a credit note print stores its style too');
SELECT is(pg_temp.il(404, pg_temp.ta(), jsonb_build_object('style', 'colour')), '23514', 'print_log: an unknown style rejected');
SELECT is(pg_temp.il(405, pg_temp.ta(), jsonb_build_object('style', 'PLAIN_BW')), '23514', 'print_log: upper case style rejected (exact values only)');
SELECT is(pg_temp.il(406, pg_temp.ta(), jsonb_build_object('style', '')), '23514', 'print_log: an empty style rejected');
SELECT is(pg_temp.q($q$SELECT count(*)::text FROM billing.print_log WHERE style IS NULL OR style NOT IN ('full', 'plain_bw')$q$), '0', 'every print_log row (fixtures and rows that existed before) has a valid style');
SELECT is(pg_temp.q($q$SELECT (has_table_privilege('lims_app', 'billing.print_log', 'SELECT') AND has_table_privilege('lims_app', 'billing.print_log', 'INSERT')
  AND NOT has_table_privilege('lims_app', 'billing.print_log', 'UPDATE') AND NOT has_table_privilege('lims_app', 'billing.print_log', 'DELETE'))::text$q$), 'true', 'print_log stays append only for lims_app (SELECT and INSERT, no UPDATE, no DELETE)');
SELECT is(pg_temp.a($q$UPDATE billing.print_log SET style = 'plain_bw' WHERE id = '0190c700-0000-7000-8000-000000000401'$q$), 'E42501', 'staff cannot rewrite the style of a past print');
SELECT is(pg_temp.a($q$DELETE FROM billing.print_log WHERE id = '0190c700-0000-7000-8000-000000000401'$q$), 'E42501', 'staff cannot delete a print record');

-- ===================================================================================================================================== (6) idempotent re-apply: second run changes nothing and the rules still hold
CREATE TEMP TABLE before_state AS
  SELECT (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace IN ('reporting'::regnamespace, 'billing'::regnamespace) AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped) AS cols,
         (SELECT count(*) FROM pg_constraint k WHERE k.connamespace IN ('reporting'::regnamespace, 'billing'::regnamespace)) AS cons,
         (SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace IN ('reporting'::regnamespace, 'billing'::regnamespace)) AS idxs,
         (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace IN ('reporting'::regnamespace, 'billing'::regnamespace)) AS pols,
         (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace IN ('reporting'::regnamespace, 'billing'::regnamespace) AND NOT t.tgisinternal) AS trgs,
         (SELECT count(*) FROM pg_class c WHERE c.relnamespace IN ('reporting'::regnamespace, 'billing'::regnamespace) AND c.relkind IN ('r','p')) AS tbls,
         (SELECT count(*) FROM pg_proc p WHERE p.pronamespace IN ('reporting'::regnamespace, 'billing'::regnamespace)) AS procs,
         (SELECT string_agg(conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conrelid::regclass::text, conname) FROM pg_constraint WHERE connamespace IN ('reporting'::regnamespace, 'billing'::regnamespace) AND contype = 'c') AS checks,
         (SELECT count(*) FROM reporting.print_profile) AS n_profile,
         (SELECT count(*) FROM reporting.signatory_profile) AS n_signer,
         (SELECT count(*) FROM billing.print_log) AS n_log;
\ir ../../migrations/20261117160000_reporting__add_print_profiles_and_signatories.sql
RESET ROLE;
SELECT is((SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace IN ('reporting'::regnamespace, 'billing'::regnamespace) AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped), (SELECT cols FROM before_state), 're-apply: column count unchanged');
SELECT is((SELECT count(*) FROM pg_constraint k WHERE k.connamespace IN ('reporting'::regnamespace, 'billing'::regnamespace)), (SELECT cons FROM before_state), 're-apply: constraint count unchanged');
SELECT is((SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace IN ('reporting'::regnamespace, 'billing'::regnamespace)), (SELECT idxs FROM before_state), 're-apply: index count unchanged');
SELECT is((SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace IN ('reporting'::regnamespace, 'billing'::regnamespace)), (SELECT pols FROM before_state), 're-apply: policy count unchanged');
SELECT is((SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace IN ('reporting'::regnamespace, 'billing'::regnamespace) AND NOT t.tgisinternal), (SELECT trgs FROM before_state), 're-apply: trigger count unchanged');
SELECT is((SELECT count(*) FROM pg_class c WHERE c.relnamespace IN ('reporting'::regnamespace, 'billing'::regnamespace) AND c.relkind IN ('r','p')), (SELECT tbls FROM before_state), 're-apply: table count unchanged');
SELECT is((SELECT count(*) FROM pg_proc p WHERE p.pronamespace IN ('reporting'::regnamespace, 'billing'::regnamespace)), (SELECT procs FROM before_state), 're-apply: function count unchanged');
SELECT is((SELECT string_agg(conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conrelid::regclass::text, conname) FROM pg_constraint WHERE connamespace IN ('reporting'::regnamespace, 'billing'::regnamespace) AND contype = 'c'), (SELECT checks FROM before_state), 're-apply: every CHECK definition unchanged');
SELECT is((SELECT count(*) FROM reporting.print_profile), (SELECT n_profile FROM before_state), 're-apply: no print profile added or removed');
SELECT is((SELECT count(*) FROM reporting.signatory_profile), (SELECT n_signer FROM before_state), 're-apply: no signer profile added or removed');
SELECT is((SELECT count(*) FROM billing.print_log), (SELECT n_log FROM before_state), 're-apply: no print record added or removed');
SELECT is(pg_temp.q($q$SELECT style FROM billing.print_log WHERE id = '0190c700-0000-7000-8000-000000000402'$q$), 'plain_bw', 're-apply: a stored plain_bw print keeps its style');
SELECT is(pg_temp.ip(370, pg_temp.ta()), '23505', 're-apply: the one-active-row rule still holds');
SELECT is(pg_temp.ip(371, pg_temp.ta(), jsonb_build_object('header_text', '<b>x</b>', pg_temp.actcol('reporting.print_profile'), false)), '23514', 're-apply: the markup rule still holds');
SELECT is(pg_temp.isg(pg_temp.usrA(4), pg_temp.ta()), '23505', 're-apply: the one-row-per-user rule still holds');

SELECT * FROM finish();
ROLLBACK;
