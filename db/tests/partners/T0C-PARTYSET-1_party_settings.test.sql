-- T0C-PARTYSET-1 pgTAP suite (LD-321; founder blanket authority LD-310; priority 2026-11-17 09:18 NPT) for migration 20261117220000_partners__add_party_settings_and_penalties.sql:
-- four tenant tables in schema partners (party_commercial_setting, party_onboarding, non_compliance_penalty, non_compliance_event), one in schema catalog (icd_code), new columns on
-- partners.partners (tax_number, national_id_number) and catalog.doctors (speciality, hospital, national_id_number; NO rate column, LD-385), and audit triggers that never copy ID numbers.
-- Covers: shape + CHECKs, ranges (0..365 days, 0..10000 bp), enums, onboarding transitions (pending -> approved | held | rejected, held -> approved | rejected only), penalty event transitions
-- (raised -> waived | charged only, charged needs ledger_entry_id, one ledger entry once), ICD unique per tenant, ID numbers never in audit.audit_log, composite tenant FKs, ENABLE + FORCE RLS,
-- grants (no DELETE), isolation probes (A/B, patient / partner / portal actors), idempotent re-apply. Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written
-- by the superuser test session with system claims (audit context), every isolation assertion runs as SET LOCAL ROLE lims_app. Seeds supply tenants A/B (a001/b001), memberships a500/b500.
-- Run: bash db/tests/run-suites.sh db/tests/partners/T0C-PARTYSET-1_party_settings.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (brief gives fields, not column or constraint names; a different choice needs a ruling, not a silent test edit):
--  - Every new table has id, tenant_id, created_at, updated_at, created_by (uuid NOT NULL, no FK), version integer default 1; no DEFAULT on id / tenant_id (UUIDv7 in app code); NULL is the only "none".
--  - party_commercial_setting(party_kind in partner|credit_party|doctor|referrer, party_id uuid (polymorphic, no FK), auto_release_reports, whatsapp_enabled, insurance_enabled, print_exception,
--    auto_block_overdue boolean NOT NULL, lab_number_scheme_code text NULL ^[A-Z0-9_-]{1,20}$, billing_cycle daily|weekly|fortnightly|monthly|quarterly, invoice_payment_days / invoice_blocking_days /
--    invoice_warning_days integer 0..365, interest_bp_per_day / commission_bp / tds_bp integer 0..10000 (tds_bp DEFAULT 0), priority P1..P5, header_footer_mode with|without|both);
--    UNIQUE (tenant_id, party_kind, party_id). The fixtures give every column except tds_bp and version, so no other DEFAULT is assumed.
--  - party_onboarding(party_kind, party_id, status pending|approved|held|rejected DEFAULT 'pending', reason text NULL 1..500, decided_by uuid NULL, decided_at timestamptz NULL); UNIQUE (tenant_id, party_kind, party_id);
--    status pending <=> decided_at IS NULL; held and rejected need a reason; transitions pending -> approved | held | rejected, held -> approved | rejected; approved and rejected are final (trigger).
--  - non_compliance_penalty(code ^[A-Z0-9_-]{1,20}$ unique per tenant, name 1..120, amount_paisa integer|bigint >= 0, is_active DEFAULT true).
--  - non_compliance_event(party_kind, party_id, penalty_id composite FK, event_date date NOT NULL, amount_paisa >= 0, reason NULL 1..500, status raised|waived|charged DEFAULT 'raised', ledger_entry_id uuid NULL
--    (no FK pinned: the ledger table belongs to billing), decided_by uuid NULL); raised <=> decided_by IS NULL; charged <=> ledger_entry_id IS NOT NULL; ledger_entry_id unique per tenant when set (charged once);
--    transitions raised -> waived | charged only (trigger); a charged event keeps its ledger_entry_id for good.
--  - catalog.icd_code(code ^[0-9A-Z][0-9A-Z.]{0,15}$ unique per tenant, title 1..500, chapter NULL 1..120, is_active DEFAULT true). It is separate from frontdesk.icd_codes (see the contract test header).
--  - partners.partners gains tax_number, national_id_number text NULL (1..32 chars); catalog.doctors gains speciality text NULL (1..120), hospital text NULL (1..200),
--    national_id_number text NULL (1..32). app.tg_row_audit() copies whole rows into audit_log, so the audit triggers partners__audit, doctors__audit, credit_parties__audit are re-created with the ID
--    columns as excluded arguments: an ID number is never in audit.audit_log (done_when 3).
--  - lims_app has SELECT, INSERT, UPDATE and NO DELETE on the five new tables.
--  - Not tested here: masking at read (API), reveal permission and audit event (service, T0B-PARTYSET-1), ledger posting of a charge (service), runtime effects of the settings, cloud apply (founder, push-cloud).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c4f0-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
CREATE FUNCTION pg_temp.mem(p_tenant uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_tenant = '01a1a98a-ac40-7000-8000-00000000a001'::uuid THEN pg_temp.id('00000000a500') ELSE pg_temp.id('00000000b500') END $$;
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'system') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', pg_temp.sys(), 'membership_id', pg_temp.mem(p_tenant)) $$;
-- run p_sql as p_role with claims; mode n = count of a query, w = ROW_COUNT of a statement; errors -> 'E' || SQLSTATE || '|' || SQLERRM
CREATE FUNCTION pg_temp.x(p_role text, p_claims jsonb, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; END IF;
    r := 'n=' || n;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || '|' || SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.a(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.b(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, p_mode) $$;
-- superuser fixture insert of the keys of p_row (system claims of the row's tenant give app.tg_row_audit its context); created_by / updated_by added when the table has them; 'ok' or SQLSTATE
CREATE FUNCTION pg_temp.try(p_tbl text, p_row jsonb) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r jsonb := p_row; a text; cols text; res text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.cl((p_row ->> 'tenant_id')::uuid)::text, true);
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(p_tbl) AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.sys()); END IF;
  END LOOP;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  BEGIN
    EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, r::text);
    res := 'ok';
  EXCEPTION WHEN OTHERS THEN res := SQLSTATE; END;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN res;
END $f$;
-- superuser UPDATE with system claims of tenant A; returns 'ok' or SQLSTATE (used for transitions: the trigger and CHECKs speak, RLS is not the subject)
CREATE FUNCTION pg_temp.upd(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE res text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.cl(pg_temp.ta())::text, true);
  BEGIN EXECUTE p_sql; res := 'ok'; EXCEPTION WHEN OTHERS THEN res := SQLSTATE; END;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN res;
END $f$;
-- row builders (p_over is merged last)
CREATE FUNCTION pg_temp.set_(n int, p_tenant uuid, p_party int, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'party_kind', 'credit_party', 'party_id', pg_temp.uid(p_party),
    'auto_release_reports', false, 'whatsapp_enabled', false, 'insurance_enabled', false, 'print_exception', false, 'auto_block_overdue', false, 'lab_number_scheme_code', 'KTM_A',
    'billing_cycle', 'monthly', 'invoice_payment_days', 30, 'invoice_blocking_days', 60, 'invoice_warning_days', 45, 'interest_bp_per_day', 5, 'commission_bp', 1000,
    'priority', 'P3', 'header_footer_mode', 'both') || p_over $$;
CREATE FUNCTION pg_temp.onb(n int, p_tenant uuid, p_party int, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'party_kind', 'partner', 'party_id', pg_temp.uid(p_party)) || p_over $$;
CREATE FUNCTION pg_temp.pen(n int, p_tenant uuid, p_code text, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'code', p_code, 'name', 'Synthetic penalty ' || p_code, 'amount_paisa', 50000) || p_over $$;
CREATE FUNCTION pg_temp.evt(n int, p_tenant uuid, p_pen int, p_party int, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'party_kind', 'partner', 'party_id', pg_temp.uid(p_party), 'penalty_id', pg_temp.uid(p_pen),
    'event_date', '2026-11-17', 'amount_paisa', 50000) || p_over $$;
CREATE FUNCTION pg_temp.icd(n int, p_tenant uuid, p_code text, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'code', p_code, 'title', 'Synthetic diagnosis ' || p_code) || p_over $$;
CREATE FUNCTION pg_temp.doc(n int, p_tenant uuid, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'doctor_code', 'SYNDOC' || n, 'display_name', 'Synthetic Doctor ' || n, 'name_normalised', 'synthetic doctor ' || n,
    'source', 'back_office') || p_over $$;

CREATE TEMP TABLE nt(s, t) AS VALUES ('partners','party_commercial_setting'),('partners','party_onboarding'),('partners','non_compliance_penalty'),('partners','non_compliance_event'),('catalog','icd_code');

-- ===================================================================================================================================== shape of the five tables
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = n.s) AND c.relname = n.t AND c.relkind = 'r'), 1, n.s || '.' || n.t || ' exists') FROM nt n;
SELECT is((SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid = to_regclass(n.s || '.' || n.t)), true, n.t || ' ENABLE + FORCE row level security') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = n.s AND p.tablename = n.t AND p.roles <> ARRAY['lims_app']::name[]), 0, 'every policy on ' || n.t || ' is TO lims_app only') FROM nt n;
SELECT ok((SELECT count(*) FROM pg_policy p WHERE p.polrelid = to_regclass(n.s || '.' || n.t)) >= 3, n.t || ' has SELECT, INSERT and UPDATE policies') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = to_regclass(n.s || '.' || n.t)
            AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) !~ 'tenant_id = '), 0, 'every ' || n.t || ' policy is tenant_id-scoped') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = n.s AND p.tablename = n.t AND p.cmd IN ('DELETE', 'ALL')), 0, n.t || ' has no DELETE / ALL policy') FROM nt n;
SELECT is(has_table_privilege('lims_app', to_regclass(n.s || '.' || n.t), x.priv), x.want, 'lims_app ' || x.priv || ' on ' || n.t || ' = ' || x.want)
  FROM nt n CROSS JOIN (VALUES ('SELECT', true), ('INSERT', true), ('UPDATE', true), ('DELETE', false), ('TRUNCATE', false)) x(priv, want);
SELECT is(coalesce(has_table_privilege(r.role, to_regclass(n.s || '.' || n.t), 'SELECT'), false), false, r.role || ' has no grant on ' || n.t) FROM nt n CROSS JOIN (VALUES ('anon'),('authenticated')) r(role)
  WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role);
SELECT is((SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]), 'tenant_id', '§9 test 2: ' || c.relname || ' index ' || ic.relname || ' leads with tenant_id')
  FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid
 WHERE c.relname IN (SELECT t FROM nt) AND c.relnamespace IN ('partners'::regnamespace, 'catalog'::regnamespace)
   AND NOT (i.indisprimary AND i.indnatts = 1 AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'id');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass(n.s || '.' || n.t) AND k.contype = 'u' AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) = ARRAY['tenant_id','id']), n.t || ' has UNIQUE (tenant_id, id) next to PRIMARY KEY (id)') FROM nt n;
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass(n.s || '.' || n.t) AND k.contype = 'f' AND k.confrelid = 'core.tenants'::regclass), n.t || ' references core.tenants') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = to_regclass(n.s || '.' || n.t) AND a.attname IN ('id','tenant_id') AND a.atthasdef AND NOT a.attisdropped), 0, n.t || ': no DEFAULT on id / tenant_id') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = to_regclass(n.s || '.' || n.t) AND a.attname IN ('id','tenant_id','created_at','updated_at','created_by') AND a.attnotnull AND NOT a.attisdropped), 5,
  n.t || ': id, tenant_id, created_at, updated_at, created_by are NOT NULL') FROM nt n;
SELECT is((SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = to_regclass(m.s || '.' || m.t) AND a.attname = m.col AND NOT a.attisdropped), m.typ, m.t || '.' || m.col || ' is ' || m.typ)
  FROM (VALUES ('partners','party_commercial_setting','party_kind','text'),('partners','party_commercial_setting','party_id','uuid'),('partners','party_commercial_setting','auto_release_reports','boolean'),
               ('partners','party_commercial_setting','whatsapp_enabled','boolean'),('partners','party_commercial_setting','insurance_enabled','boolean'),('partners','party_commercial_setting','print_exception','boolean'),
               ('partners','party_commercial_setting','auto_block_overdue','boolean'),('partners','party_commercial_setting','lab_number_scheme_code','text'),('partners','party_commercial_setting','billing_cycle','text'),
               ('partners','party_commercial_setting','invoice_payment_days','integer'),('partners','party_commercial_setting','invoice_blocking_days','integer'),('partners','party_commercial_setting','invoice_warning_days','integer'),
               ('partners','party_commercial_setting','interest_bp_per_day','integer'),('partners','party_commercial_setting','commission_bp','integer'),('partners','party_commercial_setting','tds_bp','integer'),
               ('partners','party_commercial_setting','priority','text'),('partners','party_commercial_setting','header_footer_mode','text'),
               ('partners','party_onboarding','party_kind','text'),('partners','party_onboarding','party_id','uuid'),('partners','party_onboarding','status','text'),('partners','party_onboarding','reason','text'),
               ('partners','party_onboarding','decided_by','uuid'),('partners','party_onboarding','decided_at','timestamp with time zone'),
               ('partners','non_compliance_penalty','code','text'),('partners','non_compliance_penalty','name','text'),('partners','non_compliance_penalty','is_active','boolean'),
               ('partners','non_compliance_event','party_kind','text'),('partners','non_compliance_event','party_id','uuid'),('partners','non_compliance_event','penalty_id','uuid'),
               ('partners','non_compliance_event','event_date','date'),('partners','non_compliance_event','reason','text'),('partners','non_compliance_event','status','text'),
               ('partners','non_compliance_event','ledger_entry_id','uuid'),('partners','non_compliance_event','decided_by','uuid'),
               ('catalog','icd_code','code','text'),('catalog','icd_code','title','text'),('catalog','icd_code','chapter','text'),('catalog','icd_code','is_active','boolean')) m(s, t, col, typ);
SELECT ok((SELECT format_type(a.atttypid, a.atttypmod) IN ('integer', 'bigint') FROM pg_attribute a WHERE a.attrelid = to_regclass(m.t) AND a.attname = 'amount_paisa' AND NOT a.attisdropped), m.t || '.amount_paisa is integer paisa')
  FROM (VALUES ('partners.non_compliance_penalty'), ('partners.non_compliance_event')) m(t);
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = 'partners.party_commercial_setting'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
            AND a.attname IN ('lab_number_scheme_code')), NULL::text[], 'lab_number_scheme_code is nullable (a plain code, optional)');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = to_regclass(n.s || '.' || n.t) AND a.attnum > 0 AND NOT a.attisdropped AND a.atttypid IN ('float4'::regtype, 'float8'::regtype, 'numeric'::regtype, 'money'::regtype)), 0,
  'no float, numeric or money column in ' || n.t) FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_class WHERE relkind = 'S' AND relnamespace IN ('partners'::regnamespace, 'catalog'::regnamespace) AND relname ~ 'party_commercial|party_onboarding|non_compliance|icd_code'), 0, 'no sequences');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'partners.party_commercial_setting'::regclass AND a.attname = 'tds_bp' AND a.atthasdef AND NOT a.attisdropped), 1, 'tds_bp has a DEFAULT (0)');

-- ===================================================================================================================================== new columns on partners.partners and catalog.doctors
SELECT is((SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = to_regclass(m.t) AND a.attname = m.col AND NOT a.attisdropped), m.typ, m.t || '.' || m.col || ' is ' || m.typ)
  FROM (VALUES ('partners.partners','tax_number','text'),('partners.partners','national_id_number','text'),('catalog.doctors','speciality','text'),('catalog.doctors','hospital','text'),
               ('catalog.doctors','national_id_number','text')) m(t, col, typ);
SELECT is((SELECT a.attnotnull FROM pg_attribute a WHERE a.attrelid = to_regclass(m.t) AND a.attname = m.col AND NOT a.attisdropped), false, m.t || '.' || m.col || ' is nullable (optional, existing rows unchanged)')
  FROM (VALUES ('partners.partners','tax_number'),('partners.partners','national_id_number'),('catalog.doctors','speciality'),('catalog.doctors','hospital'),('catalog.doctors','national_id_number')) m(t, col);
SELECT is((SELECT a.atthasdef FROM pg_attribute a WHERE a.attrelid = to_regclass(m.t) AND a.attname = m.col AND NOT a.attisdropped), false, m.t || '.' || m.col || ' has no DEFAULT (no rewrite of old rows)')
  FROM (VALUES ('partners.partners','tax_number'),('partners.partners','national_id_number'),('catalog.doctors','speciality'),('catalog.doctors','hospital'),('catalog.doctors','national_id_number')) m(t, col);
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'catalog.credit_parties'::regclass AND a.attname = 'pan' AND NOT a.attisdropped), 1, 'catalog.credit_parties.pan is kept (never renamed; masked at read)');
SELECT is(pg_temp.try('catalog.doctors', pg_temp.doc(1, pg_temp.ta())), 'ok', 'a doctor without the new fields still inserts (additive)');
SELECT is(pg_temp.try('catalog.doctors', pg_temp.doc(2, pg_temp.ta(), '{"speciality":"Pathology (synthetic)","hospital":"Synthetic Hospital","national_id_number":"SYN-NID-LEAK-0002"}')), 'ok',
  'a doctor with speciality, hospital and national_id_number');
-- LD-385: the per doctor rate lives only in partners.party_commercial_setting (party_kind doctor); the C3 doctor table carries none
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'catalog.doctors'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ~* 'commission'), 0, 'catalog.doctors has no commission_bp column (LD-385)');
SELECT is((SELECT count(*)::int FROM pg_constraint k WHERE k.conrelid = 'catalog.doctors'::regclass AND (k.conname ~* 'commission' OR pg_get_constraintdef(k.oid) ~* 'commission')), 0, 'catalog.doctors has no commission constraint (LD-385)');
SELECT is(pg_temp.try('catalog.doctors', pg_temp.doc(5, pg_temp.tb(), '{"national_id_number":"SYN-NID-LEAK-0005"}')), 'ok', 'tenant B doctor with an ID number');
SELECT is(pg_temp.try('catalog.doctors', pg_temp.doc(10 + t.i, pg_temp.ta(), t.o)), '23514', t.lbl)
  FROM (VALUES (3, jsonb_build_object('national_id_number', repeat('N', 33)), '33 char national_id_number -> check_violation'), (4, '{"national_id_number":""}'::jsonb, 'empty national_id_number -> check_violation'),
               (5, jsonb_build_object('speciality', repeat('s', 121)), 'oversize speciality -> check_violation'), (6, jsonb_build_object('hospital', repeat('h', 201)), 'oversize hospital -> check_violation'),
               (7, '{"speciality":""}'::jsonb, 'empty speciality -> check_violation')) t(i, o, lbl);
SELECT is((SELECT count(*)::int FROM pg_constraint k WHERE k.conrelid = 'partners.partners'::regclass AND k.contype = 'c' AND pg_get_constraintdef(k.oid) ~ 'national_id_number'), 1, 'partners.partners has a CHECK on national_id_number length');
SELECT is((SELECT count(*)::int FROM pg_constraint k WHERE k.conrelid = 'partners.partners'::regclass AND k.contype = 'c' AND pg_get_constraintdef(k.oid) ~ 'tax_number'), 1, 'partners.partners has a CHECK on tax_number length');

-- ===================================================================================================================================== party commercial settings
SELECT is(pg_temp.try('partners.party_commercial_setting', pg_temp.set_(101, pg_temp.ta(), 900)), 'ok', 'setting A101 (credit_party 900)');
SELECT is(pg_temp.try('partners.party_commercial_setting', pg_temp.set_(102, pg_temp.ta(), 900, '{"party_kind":"doctor"}')), 'ok', 'the same party id as a doctor is another party (kind is part of the key)');
SELECT is(pg_temp.try('partners.party_commercial_setting', pg_temp.set_(103, pg_temp.tb(), 900)), 'ok', 'setting B103 (tenant B, party id reused)');
SELECT is(pg_temp.try('partners.party_commercial_setting', pg_temp.set_(104, pg_temp.ta(), 901, '{"priority":"P1","billing_cycle":"daily","header_footer_mode":"with","auto_release_reports":true,"whatsapp_enabled":true,"insurance_enabled":true,"print_exception":true,"auto_block_overdue":true}')), 'ok',
  'a setting with every switch on');
SELECT is((SELECT tds_bp FROM partners.party_commercial_setting WHERE id = pg_temp.uid(101)), 0, 'tds_bp defaults to 0');
SELECT is((SELECT version FROM partners.party_commercial_setting WHERE id = pg_temp.uid(101)), 1, 'a setting starts at version 1');
SELECT is((SELECT interest_bp_per_day FROM partners.party_commercial_setting WHERE id = pg_temp.uid(101)), 5, 'interest is stored as integer basis points per day');
SELECT is(pg_temp.try('partners.party_commercial_setting', pg_temp.set_(105, pg_temp.ta(), 900)), '23505', 'one setting row per party -> unique_violation');
SELECT is(pg_temp.try('partners.party_commercial_setting', pg_temp.set_(106, pg_temp.ta(), 902, '{"lab_number_scheme_code":null}')), 'ok', 'lab_number_scheme_code may be NULL');
SELECT is(pg_temp.try('partners.party_commercial_setting', pg_temp.set_(107, pg_temp.ta(), 903, '{"tds_bp":750}')), 'ok', 'tds_bp 750 (7.5 percent)');
SELECT is(pg_temp.try('partners.party_commercial_setting', pg_temp.set_(110 + t.i, pg_temp.ta(), 910 + t.i, t.o)), '23514', t.lbl)
  FROM (VALUES (1, '{"invoice_payment_days":366}'::jsonb, 'invoice_payment_days 366 rejected'), (2, '{"invoice_payment_days":-1}'::jsonb, 'invoice_payment_days -1 rejected'),
               (3, '{"invoice_blocking_days":366}'::jsonb, 'invoice_blocking_days 366 rejected'), (4, '{"invoice_blocking_days":-1}'::jsonb, 'invoice_blocking_days -1 rejected'),
               (5, '{"invoice_warning_days":366}'::jsonb, 'invoice_warning_days 366 rejected'), (6, '{"invoice_warning_days":-1}'::jsonb, 'invoice_warning_days -1 rejected'),
               (7, '{"interest_bp_per_day":10001}'::jsonb, 'interest_bp_per_day 10001 rejected'), (8, '{"interest_bp_per_day":-1}'::jsonb, 'interest_bp_per_day -1 rejected'),
               (9, '{"commission_bp":10001}'::jsonb, 'commission_bp 10001 rejected'), (10, '{"commission_bp":-1}'::jsonb, 'commission_bp -1 rejected'),
               (11, '{"tds_bp":10001}'::jsonb, 'tds_bp 10001 rejected'), (12, '{"tds_bp":-1}'::jsonb, 'tds_bp -1 rejected'),
               (13, '{"priority":"P6"}'::jsonb, 'priority P6 rejected'), (14, '{"priority":"P0"}'::jsonb, 'priority P0 rejected'), (15, '{"priority":"p1"}'::jsonb, 'priority is case sensitive'),
               (16, '{"billing_cycle":"yearly"}'::jsonb, 'billing_cycle yearly rejected'), (17, '{"billing_cycle":"Monthly"}'::jsonb, 'billing_cycle is case sensitive'),
               (18, '{"header_footer_mode":"neither"}'::jsonb, 'header_footer_mode neither rejected'), (19, '{"party_kind":"franchise"}'::jsonb, 'party_kind franchise rejected'),
               (20, '{"lab_number_scheme_code":"bad code!"}'::jsonb, 'lab_number_scheme_code with a space rejected'), (21, '{"lab_number_scheme_code":""}'::jsonb, 'empty lab_number_scheme_code rejected (NULL is the only none)'),
               (22, jsonb_build_object('lab_number_scheme_code', repeat('A', 21)), 'lab_number_scheme_code of 21 chars rejected')) t(i, o, lbl);
SELECT is(pg_temp.try('partners.party_commercial_setting', pg_temp.set_(140 + t.i, pg_temp.ta(), 940 + t.i, t.o)), '23502', t.lbl)
  FROM (VALUES (1, '{"billing_cycle":null}'::jsonb, 'NULL billing_cycle rejected'), (2, '{"priority":null}'::jsonb, 'NULL priority rejected'), (3, '{"header_footer_mode":null}'::jsonb, 'NULL header_footer_mode rejected'),
               (4, '{"commission_bp":null}'::jsonb, 'NULL commission_bp rejected'), (5, '{"invoice_payment_days":null}'::jsonb, 'NULL invoice_payment_days rejected'),
               (6, '{"auto_release_reports":null}'::jsonb, 'NULL auto_release_reports rejected'), (7, '{"party_id":null}'::jsonb, 'NULL party_id rejected')) t(i, o, lbl);
SELECT is(pg_temp.try('partners.party_commercial_setting', pg_temp.set_(150 + k.i, pg_temp.ta(), 950 + k.i, jsonb_build_object('party_kind', k.k))), 'ok', 'party_kind ' || k.k || ' accepted')
  FROM (VALUES (1, 'partner'), (2, 'credit_party'), (3, 'doctor'), (4, 'referrer')) k(i, k);
SELECT is(pg_temp.try('partners.party_commercial_setting', pg_temp.set_(160 + k.i, pg_temp.ta(), 960 + k.i, jsonb_build_object('billing_cycle', k.k))), 'ok', 'billing_cycle ' || k.k || ' accepted')
  FROM (VALUES (1, 'daily'), (2, 'weekly'), (3, 'fortnightly'), (4, 'monthly'), (5, 'quarterly')) k(i, k);
SELECT is(pg_temp.try('partners.party_commercial_setting', pg_temp.set_(170 + k.i, pg_temp.ta(), 970 + k.i, jsonb_build_object('priority', k.k))), 'ok', 'priority ' || k.k || ' accepted')
  FROM (VALUES (1, 'P1'), (2, 'P2'), (3, 'P3'), (4, 'P4'), (5, 'P5')) k(i, k);
SELECT is(pg_temp.try('partners.party_commercial_setting', pg_temp.set_(180 + k.i, pg_temp.ta(), 980 + k.i, jsonb_build_object('header_footer_mode', k.k))), 'ok', 'header_footer_mode ' || k.k || ' accepted')
  FROM (VALUES (1, 'with'), (2, 'without'), (3, 'both')) k(i, k);
SELECT is(pg_temp.try('partners.party_commercial_setting', pg_temp.set_(190, pg_temp.ta(), 990, '{"invoice_payment_days":0,"invoice_blocking_days":365,"invoice_warning_days":0,"interest_bp_per_day":10000,"commission_bp":0,"tds_bp":10000}')), 'ok', 'the range ends 0, 365 and 10000 are accepted');
SELECT is(pg_temp.a(format($$ UPDATE partners.party_commercial_setting SET tds_bp = 10001 WHERE id = %L $$, pg_temp.uid(101))) ~ '^E23514', true, 'update to tds_bp 10001 -> check_violation');
SELECT is(pg_temp.a(format($$ UPDATE partners.party_commercial_setting SET invoice_payment_days = 90, priority = 'P5', version = version + 1 WHERE id = %L $$, pg_temp.uid(101))), 'n=1', 'lims_app can update a setting');
SELECT is(pg_temp.a(format($$ DELETE FROM partners.party_commercial_setting WHERE id = %L $$, pg_temp.uid(101))) ~ '^E42501', true, 'lims_app cannot delete a setting row');

-- ===================================================================================================================================== onboarding queue
SELECT is(pg_temp.try('partners.party_onboarding', pg_temp.onb(201, pg_temp.ta(), 800)), 'ok', 'onboarding A201 (partner 800)');
SELECT is(pg_temp.try('partners.party_onboarding', pg_temp.onb(202, pg_temp.ta(), 801)), 'ok', 'onboarding A202');
SELECT is(pg_temp.try('partners.party_onboarding', pg_temp.onb(203, pg_temp.ta(), 802)), 'ok', 'onboarding A203');
SELECT is(pg_temp.try('partners.party_onboarding', pg_temp.onb(204, pg_temp.ta(), 803)), 'ok', 'onboarding A204');
SELECT is(pg_temp.try('partners.party_onboarding', pg_temp.onb(205, pg_temp.ta(), 804)), 'ok', 'onboarding A205');
SELECT is(pg_temp.try('partners.party_onboarding', pg_temp.onb(206, pg_temp.tb(), 800)), 'ok', 'onboarding B206 (tenant B, party id reused)');
SELECT is((SELECT status FROM partners.party_onboarding WHERE id = pg_temp.uid(201)), 'pending', 'a queue row starts pending');
SELECT is((SELECT decided_at FROM partners.party_onboarding WHERE id = pg_temp.uid(201)), NULL::timestamptz, 'a pending row has no decided_at');
SELECT is(pg_temp.try('partners.party_onboarding', pg_temp.onb(207, pg_temp.ta(), 800)), '23505', 'one queue row per party -> unique_violation');
SELECT is(pg_temp.try('partners.party_onboarding', pg_temp.onb(208, pg_temp.ta(), 805, '{"party_kind":"franchise"}')), '23514', 'party_kind franchise rejected');
SELECT is(pg_temp.try('partners.party_onboarding', pg_temp.onb(209, pg_temp.ta(), 806, '{"status":"archived"}')), '23514', 'status archived rejected');
-- pending -> approved
SELECT is(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'approved', decided_by = %L, decided_at = now(), version = version + 1 WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(201))), 'ok', 'pending -> approved');
SELECT is((SELECT status FROM partners.party_onboarding WHERE id = pg_temp.uid(201)), 'approved', '201 is approved');
-- approved is final
SELECT isnt(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = %L $$, pg_temp.uid(201))), 'ok', 'approved -> pending refused');
SELECT isnt(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'held', reason = 'Synthetic reason' WHERE id = %L $$, pg_temp.uid(201))), 'ok', 'approved -> held refused');
SELECT isnt(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'rejected', reason = 'Synthetic reason' WHERE id = %L $$, pg_temp.uid(201))), 'ok', 'approved -> rejected refused');
SELECT is((SELECT status FROM partners.party_onboarding WHERE id = pg_temp.uid(201)), 'approved', 'refused moves leave 201 approved');
-- pending -> held (reason needed), held -> approved
SELECT is(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'held', decided_by = %L, decided_at = now() WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(202))), '23514', 'pending -> held without a reason -> check_violation');
SELECT is(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'held', reason = '', decided_by = %L, decided_at = now() WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(202))), '23514', 'an empty reason -> check_violation');
SELECT is(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'held', reason = 'Synthetic: documents missing', decided_by = %L, decided_at = now(), version = version + 1 WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(202))), 'ok', 'pending -> held with a reason');
SELECT isnt(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = %L $$, pg_temp.uid(202))), 'ok', 'held -> pending refused');
SELECT is(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'approved', decided_by = %L, decided_at = now(), version = version + 1 WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(202))), 'ok', 'held -> approved');
-- pending -> rejected, held -> rejected
SELECT is(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'rejected', decided_by = %L, decided_at = now() WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(203))), '23514', 'pending -> rejected without a reason -> check_violation');
SELECT is(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'rejected', reason = 'Synthetic: failed verification', decided_by = %L, decided_at = now(), version = version + 1 WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(203))), 'ok', 'pending -> rejected with a reason');
SELECT isnt(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'approved', decided_by = %L, decided_at = now() WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(203))), 'ok', 'rejected -> approved refused');
SELECT isnt(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'held', reason = 'Synthetic reason' WHERE id = %L $$, pg_temp.uid(203))), 'ok', 'rejected -> held refused');
SELECT is((SELECT status FROM partners.party_onboarding WHERE id = pg_temp.uid(203)), 'rejected', '203 stays rejected');
SELECT is(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'held', reason = 'Synthetic hold', decided_by = %L, decided_at = now() WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(204))), 'ok', 'pending -> held (204)');
SELECT is(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'rejected', reason = 'Synthetic reject after hold', decided_by = %L, decided_at = now() WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(204))), 'ok', 'held -> rejected');
-- state consistency
SELECT is(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET status = 'approved', decided_by = %L, decided_at = NULL WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(205))), '23514', 'approved without decided_at -> check_violation');
SELECT is(pg_temp.upd(format($$ UPDATE partners.party_onboarding SET decided_at = now() WHERE id = %L $$, pg_temp.uid(205))), '23514', 'a pending row cannot carry decided_at -> check_violation');
SELECT is((SELECT status FROM partners.party_onboarding WHERE id = pg_temp.uid(205)), 'pending', '205 is still pending after the refused updates');
SELECT is(pg_temp.a(format($$ UPDATE partners.party_onboarding SET status = 'approved', decided_by = %L, decided_at = now() WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(205))), 'n=1', 'lims_app (tenant A) can decide a queue row of its own tenant');
SELECT is(pg_temp.a(format($$ DELETE FROM partners.party_onboarding WHERE id = %L $$, pg_temp.uid(201))) ~ '^E42501', true, 'lims_app cannot delete a queue row');

-- ===================================================================================================================================== penalties
SELECT is(pg_temp.try('partners.non_compliance_penalty', pg_temp.pen(301, pg_temp.ta(), 'LATE_SAMPLE')), 'ok', 'penalty A301');
SELECT is(pg_temp.try('partners.non_compliance_penalty', pg_temp.pen(302, pg_temp.ta(), 'WRONG_TUBE', '{"amount_paisa":0,"is_active":false}')), 'ok', 'penalty A302 (amount 0, inactive)');
SELECT is(pg_temp.try('partners.non_compliance_penalty', pg_temp.pen(303, pg_temp.tb(), 'LATE_SAMPLE')), 'ok', 'penalty B303 (same code in another tenant)');
SELECT is((SELECT is_active FROM partners.non_compliance_penalty WHERE id = pg_temp.uid(301)), true, 'a penalty is active by default');
SELECT is((SELECT amount_paisa::bigint FROM partners.non_compliance_penalty WHERE id = pg_temp.uid(301)), 50000::bigint, 'the amount is integer paisa');
SELECT is(pg_temp.try('partners.non_compliance_penalty', pg_temp.pen(304, pg_temp.ta(), 'LATE_SAMPLE')), '23505', 'the same code twice in one tenant -> unique_violation');
SELECT is(pg_temp.try('partners.non_compliance_penalty', pg_temp.pen(310 + t.i, pg_temp.ta(), 'P' || t.i, t.o)), '23514', t.lbl)
  FROM (VALUES (1, '{"amount_paisa":-1}'::jsonb, 'negative amount rejected'), (2, '{"name":""}'::jsonb, 'empty name rejected'), (3, jsonb_build_object('name', repeat('n', 121)), 'oversize name rejected')) t(i, o, lbl);
SELECT is(pg_temp.try('partners.non_compliance_penalty', pg_temp.pen(320, pg_temp.ta(), 'late sample')), '23514', 'lower case code with a space rejected');
SELECT is(pg_temp.try('partners.non_compliance_penalty', pg_temp.pen(321, pg_temp.ta(), repeat('A', 21))), '23514', '21 char code rejected');
SELECT is(pg_temp.try('partners.non_compliance_penalty', pg_temp.pen(322, pg_temp.ta(), 'NULL_AMT', '{"amount_paisa":null}')), '23502', 'NULL amount rejected');
SELECT is(pg_temp.a(format($$ UPDATE partners.non_compliance_penalty SET amount_paisa = 75000, version = version + 1 WHERE id = %L $$, pg_temp.uid(301))), 'n=1', 'a penalty amount can change');
SELECT is(pg_temp.a(format($$ UPDATE partners.non_compliance_penalty SET is_active = false, version = version + 1 WHERE id = %L $$, pg_temp.uid(301))), 'n=1', 'a penalty can be deactivated');
SELECT is(pg_temp.a(format($$ DELETE FROM partners.non_compliance_penalty WHERE id = %L $$, pg_temp.uid(301))) ~ '^E42501', true, 'lims_app cannot delete a penalty (deactivate instead)');

-- ===================================================================================================================================== penalty events
SELECT is(pg_temp.try('partners.non_compliance_event', pg_temp.evt(401, pg_temp.ta(), 301, 800)), 'ok', 'event A401 raised');
SELECT is(pg_temp.try('partners.non_compliance_event', pg_temp.evt(402, pg_temp.ta(), 301, 800, '{"reason":"Synthetic: sample arrived late"}')), 'ok', 'event A402 with a reason');
SELECT is(pg_temp.try('partners.non_compliance_event', pg_temp.evt(403, pg_temp.ta(), 302, 801)), 'ok', 'event A403');
SELECT is(pg_temp.try('partners.non_compliance_event', pg_temp.evt(404, pg_temp.ta(), 302, 802)), 'ok', 'event A404');
SELECT is(pg_temp.try('partners.non_compliance_event', pg_temp.evt(405, pg_temp.ta(), 302, 803)), 'ok', 'event A405');
SELECT is(pg_temp.try('partners.non_compliance_event', pg_temp.evt(406, pg_temp.tb(), 303, 800)), 'ok', 'event B406');
SELECT is((SELECT status FROM partners.non_compliance_event WHERE id = pg_temp.uid(401)), 'raised', 'an event starts raised');
SELECT is((SELECT ledger_entry_id FROM partners.non_compliance_event WHERE id = pg_temp.uid(401)), NULL::uuid, 'a raised event has no ledger entry');
SELECT is((SELECT decided_by FROM partners.non_compliance_event WHERE id = pg_temp.uid(401)), NULL::uuid, 'a raised event has no decider');
SELECT is(pg_temp.try('partners.non_compliance_event', pg_temp.evt(407, pg_temp.ta(), 303, 800)), '23503', 'a penalty of another tenant -> foreign_key_violation (composite tenant FK)');
SELECT is(pg_temp.try('partners.non_compliance_event', pg_temp.evt(408, pg_temp.ta(), 9999, 800)), '23503', 'an unknown penalty -> foreign_key_violation');
SELECT is(pg_temp.try('partners.non_compliance_event', pg_temp.evt(420 + t.i, pg_temp.ta(), 301, 800, t.o)), '23514', t.lbl)
  FROM (VALUES (1, '{"amount_paisa":-5}'::jsonb, 'negative amount rejected'), (2, '{"party_kind":"franchise"}'::jsonb, 'party_kind franchise rejected'), (3, '{"status":"voided"}'::jsonb, 'status voided rejected'),
               (4, '{"reason":""}'::jsonb, 'empty reason rejected'), (5, jsonb_build_object('reason', repeat('r', 501)), 'oversize reason rejected'),
               (7, jsonb_build_object('ledger_entry_id', pg_temp.uid(7001)), 'a raised event with a ledger entry rejected'),
               (8, jsonb_build_object('decided_by', pg_temp.sys()), 'a raised event with a decider rejected')) t(i, o, lbl);
SELECT is(pg_temp.try('partners.non_compliance_event', pg_temp.evt(430, pg_temp.ta(), 301, 800, '{"event_date":null}')), '23502', 'NULL event_date rejected');
SELECT is(pg_temp.try('partners.non_compliance_event', pg_temp.evt(431, pg_temp.ta(), 301, 800, '{"party_id":null}')), '23502', 'NULL party_id rejected');
-- raised -> waived
SELECT is(pg_temp.upd(format($$ UPDATE partners.non_compliance_event SET status = 'waived', decided_by = %L, version = version + 1 WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(401))), 'ok', 'raised -> waived');
SELECT is((SELECT status FROM partners.non_compliance_event WHERE id = pg_temp.uid(401)), 'waived', '401 is waived');
SELECT isnt(pg_temp.upd(format($$ UPDATE partners.non_compliance_event SET status = 'charged', ledger_entry_id = %L WHERE id = %L $$, pg_temp.uid(7002), pg_temp.uid(401))), 'ok', 'waived -> charged refused (final)');
SELECT isnt(pg_temp.upd(format($$ UPDATE partners.non_compliance_event SET status = 'raised', decided_by = NULL WHERE id = %L $$, pg_temp.uid(401))), 'ok', 'waived -> raised refused');
SELECT is((SELECT status FROM partners.non_compliance_event WHERE id = pg_temp.uid(401)), 'waived', 'refused moves leave 401 waived');
-- raised -> charged, ledger entry once
SELECT is(pg_temp.upd(format($$ UPDATE partners.non_compliance_event SET status = 'charged', decided_by = %L WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(402))), '23514', 'raised -> charged without a ledger entry -> check_violation');
SELECT is(pg_temp.upd(format($$ UPDATE partners.non_compliance_event SET status = 'charged', ledger_entry_id = %L, decided_by = %L, version = version + 1 WHERE id = %L $$, pg_temp.uid(7003), pg_temp.sys(), pg_temp.uid(402))), 'ok', 'raised -> charged with the ledger entry');
SELECT is((SELECT ledger_entry_id FROM partners.non_compliance_event WHERE id = pg_temp.uid(402)), pg_temp.uid(7003), 'the ledger entry id is stored');
SELECT is(pg_temp.upd(format($$ UPDATE partners.non_compliance_event SET status = 'charged', ledger_entry_id = %L, decided_by = %L WHERE id = %L $$, pg_temp.uid(7003), pg_temp.sys(), pg_temp.uid(403))), '23505', 'one ledger entry cannot be charged twice -> unique_violation');
SELECT isnt(pg_temp.upd(format($$ UPDATE partners.non_compliance_event SET status = 'waived', ledger_entry_id = NULL WHERE id = %L $$, pg_temp.uid(402))), 'ok', 'charged -> waived refused');
SELECT isnt(pg_temp.upd(format($$ UPDATE partners.non_compliance_event SET status = 'raised', ledger_entry_id = NULL, decided_by = NULL WHERE id = %L $$, pg_temp.uid(402))), 'ok', 'charged -> raised refused');
SELECT isnt(pg_temp.upd(format($$ UPDATE partners.non_compliance_event SET ledger_entry_id = %L WHERE id = %L $$, pg_temp.uid(7004), pg_temp.uid(402))), 'ok', 'a charged event cannot be pointed at another ledger entry');
SELECT is((SELECT ledger_entry_id FROM partners.non_compliance_event WHERE id = pg_temp.uid(402)), pg_temp.uid(7003), 'the ledger entry of 402 is unchanged');
SELECT is(pg_temp.upd(format($$ UPDATE partners.non_compliance_event SET status = 'waived', ledger_entry_id = %L, decided_by = %L WHERE id = %L $$, pg_temp.uid(7005), pg_temp.sys(), pg_temp.uid(404))), '23514', 'waived with a ledger entry -> check_violation');
SELECT is(pg_temp.upd(format($$ UPDATE partners.non_compliance_event SET status = 'waived', decided_by = NULL WHERE id = %L $$, pg_temp.uid(404))), '23514', 'waived without a decider -> check_violation');
SELECT is(pg_temp.a(format($$ UPDATE partners.non_compliance_event SET status = 'waived', decided_by = %L WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(405))), 'n=1', 'lims_app (tenant A) can waive an event of its own tenant');
SELECT is(pg_temp.a(format($$ DELETE FROM partners.non_compliance_event WHERE id = %L $$, pg_temp.uid(402))) ~ '^E42501', true, 'lims_app cannot delete an event');

-- ===================================================================================================================================== ICD master
SELECT is(pg_temp.try('catalog.icd_code', pg_temp.icd(501, pg_temp.ta(), 'A09')), 'ok', 'ICD A501 A09');
SELECT is(pg_temp.try('catalog.icd_code', pg_temp.icd(502, pg_temp.ta(), 'E11.9', '{"chapter":"Chapter IV (synthetic)"}')), 'ok', 'ICD A502 E11.9 with a chapter');
SELECT is(pg_temp.try('catalog.icd_code', pg_temp.icd(503, pg_temp.ta(), 'J18.9', '{"is_active":false}')), 'ok', 'ICD A503 inactive');
SELECT is(pg_temp.try('catalog.icd_code', pg_temp.icd(504, pg_temp.tb(), 'A09')), 'ok', 'ICD B504 (same code in another tenant)');
SELECT is((SELECT is_active FROM catalog.icd_code WHERE id = pg_temp.uid(501)), true, 'an ICD code is active by default');
SELECT is((SELECT chapter FROM catalog.icd_code WHERE id = pg_temp.uid(501)), NULL::text, 'chapter is nullable');
SELECT is(pg_temp.try('catalog.icd_code', pg_temp.icd(505, pg_temp.ta(), 'A09')), '23505', 'the same code twice in one tenant -> unique_violation');
SELECT is(pg_temp.try('catalog.icd_code', pg_temp.icd(510 + t.i, pg_temp.ta(), t.c, t.o)), '23514', t.lbl)
  FROM (VALUES (1, 'a09', '{}'::jsonb, 'lower case code rejected'), (2, 'A 09', '{}'::jsonb, 'code with a space rejected'), (3, repeat('A', 17), '{}'::jsonb, '17 char code rejected'), (4, '.A09', '{}'::jsonb, 'code starting with a dot rejected'),
               (5, 'B20', '{"title":""}'::jsonb, 'empty title rejected'), (6, 'B21', jsonb_build_object('title', repeat('t', 501)), 'oversize title rejected'), (7, 'B22', '{"chapter":""}'::jsonb, 'empty chapter rejected (NULL is the only none)'),
               (8, 'B23', jsonb_build_object('chapter', repeat('c', 121)), 'oversize chapter rejected')) t(i, c, o, lbl);
SELECT is(pg_temp.try('catalog.icd_code', pg_temp.icd(520, pg_temp.ta(), 'C34', '{"title":null}')), '23502', 'NULL title rejected');
SELECT is(pg_temp.a(format($$ UPDATE catalog.icd_code SET is_active = false, version = version + 1 WHERE id = %L $$, pg_temp.uid(501))), 'n=1', 'an ICD code can be deactivated');
SELECT is(pg_temp.a(format($$ DELETE FROM catalog.icd_code WHERE id = %L $$, pg_temp.uid(501))) ~ '^E42501', true, 'lims_app cannot delete an ICD code (deactivate instead)');
SELECT is((SELECT count(*)::int FROM pg_class WHERE relname = 'icd_codes' AND relnamespace = 'frontdesk'::regnamespace), 1, 'frontdesk.icd_codes still exists (untouched)');

-- ===================================================================================================================================== tenant isolation (RLS probes)
CREATE TEMP TABLE probe(s, t, a_id, b_id) AS VALUES
  ('partners','party_commercial_setting', pg_temp.uid(101), pg_temp.uid(103)), ('partners','party_onboarding', pg_temp.uid(201), pg_temp.uid(206)),
  ('partners','non_compliance_penalty', pg_temp.uid(301), pg_temp.uid(303)), ('partners','non_compliance_event', pg_temp.uid(401), pg_temp.uid(406)), ('catalog','icd_code', pg_temp.uid(501), pg_temp.uid(504));
SELECT is(pg_temp.a(format('SELECT 1 FROM %s.%s WHERE id = %L', p.s, p.t, p.a_id), 'n'), 'n=1', 'tenant A sees its own row of ' || p.t) FROM probe p;
SELECT is(pg_temp.a(format('SELECT 1 FROM %s.%s WHERE id = %L', p.s, p.t, p.b_id), 'n'), 'n=0', 'tenant A cannot see the tenant B row of ' || p.t) FROM probe p;
SELECT is(pg_temp.b(format('SELECT 1 FROM %s.%s WHERE id = %L', p.s, p.t, p.a_id), 'n'), 'n=0', 'tenant B cannot see the tenant A row of ' || p.t) FROM probe p;
SELECT is(pg_temp.a(format('SELECT 1 FROM %s.%s WHERE tenant_id = %L', p.s, p.t, pg_temp.tb()), 'n'), 'n=0', 'filtering on the other tenant id still returns nothing for ' || p.t) FROM probe p;
SELECT is(pg_temp.a(format($$ UPDATE partners.party_commercial_setting SET priority = 'P1' WHERE id = %L $$, pg_temp.uid(103))), 'n=0', 'tenant A cannot update the tenant B setting (0 rows)');
SELECT is(pg_temp.a(format($$ UPDATE partners.non_compliance_event SET status = 'waived', decided_by = %L WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(406))), 'n=0', 'tenant A cannot waive the tenant B event (0 rows)');
SELECT is(pg_temp.a(format($$ UPDATE catalog.icd_code SET is_active = false WHERE id = %L $$, pg_temp.uid(504))), 'n=0', 'tenant A cannot update the tenant B ICD code (0 rows)');
SELECT alike(pg_temp.a(format($$ INSERT INTO partners.non_compliance_penalty (id, tenant_id, code, name, amount_paisa, created_by) VALUES (%L, %L, 'X', 'x', 1, %L) $$, pg_temp.uid(600), pg_temp.tb(), pg_temp.sys())), 'E42501|%',
  'tenant A cannot insert a penalty for tenant B');
SELECT alike(pg_temp.a(format($$ INSERT INTO catalog.icd_code (id, tenant_id, code, title, created_by) VALUES (%L, %L, 'Z99', 'x', %L) $$, pg_temp.uid(601), pg_temp.tb(), pg_temp.sys())), 'E42501|%',
  'tenant A cannot insert an ICD code for tenant B');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format('SELECT 1 FROM %s.%s', p.s, p.t), 'n'), 'n=0', 'a ' || r.k || '-actor sees 0 rows of ' || p.t) FROM probe p CROSS JOIN (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ INSERT INTO partners.party_commercial_setting (id, tenant_id, party_kind, party_id, auto_release_reports, whatsapp_enabled, insurance_enabled, print_exception,
  auto_block_overdue, billing_cycle, invoice_payment_days, invoice_blocking_days, invoice_warning_days, interest_bp_per_day, commission_bp, priority, header_footer_mode, created_by)
  VALUES (%L, %L, 'doctor', %L, false, false, false, false, false, 'monthly', 30, 60, 45, 0, 0, 'P3', 'both', %L) $$, pg_temp.uid(610), pg_temp.ta(), pg_temp.uid(950), pg_temp.sys()), 'w'), 'E42501|%',
  'a ' || r.k || '-actor cannot write commercial settings') FROM (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ UPDATE partners.party_onboarding SET status = 'approved', decided_by = %L, decided_at = now() WHERE id = %L $$, pg_temp.sys(), pg_temp.uid(205)), 'w'), 'n=0',
  'a ' || r.k || '-actor cannot decide onboarding (0 rows)') FROM (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ INSERT INTO catalog.icd_code (id, tenant_id, code, title, created_by) VALUES (%L, %L, 'Z98', 'x', %L) $$, pg_temp.uid(611), pg_temp.ta(), pg_temp.sys()), 'w'), 'E42501|%',
  'a ' || r.k || '-actor cannot write the ICD master') FROM (VALUES ('patient'),('partner'),('portal')) r(k);

-- ===================================================================================================================================== audit: ID numbers never reach audit.audit_log
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = x.s AND table_name = x.t AND row_id = x.rid AND action = 'INSERT'), 1, 'control: INSERT into ' || x.t || ' is audited')
  FROM (VALUES ('partners','party_commercial_setting', pg_temp.uid(101)), ('partners','party_onboarding', pg_temp.uid(201)), ('partners','non_compliance_penalty', pg_temp.uid(301)),
               ('partners','non_compliance_event', pg_temp.uid(401)), ('catalog','icd_code', pg_temp.uid(501))) x(s, t, rid);
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = to_regclass(n.s || '.' || n.t) AND NOT tgisinternal AND pg_get_triggerdef(oid) ~ 'tg_row_audit'), 1, n.t || ' has one audit trigger') FROM nt n;
SELECT ok(EXISTS (SELECT 1 FROM audit.audit_log WHERE schema_name = 'partners' AND table_name = 'party_onboarding' AND row_id = pg_temp.uid(201) AND action = 'UPDATE' AND 'status' = ANY (changed_columns)),
  'an onboarding decision is recorded as changed (who decided what)');
SELECT ok(EXISTS (SELECT 1 FROM audit.audit_log WHERE schema_name = 'partners' AND table_name = 'non_compliance_event' AND row_id = pg_temp.uid(402) AND action = 'UPDATE' AND 'ledger_entry_id' = ANY (changed_columns)),
  'a penalty charge is recorded as changed (ledger_entry_id)');
SELECT is((SELECT count(*)::int FROM audit.audit_log a WHERE a.schema_name = 'catalog' AND a.table_name = 'doctors' AND a.row_id = pg_temp.uid(2) AND a.action = 'INSERT'), 1, 'control: the doctor with an ID number was audited');
SELECT is((SELECT count(*)::int FROM audit.audit_log a WHERE (coalesce(a.old_values::text, '') || coalesce(a.new_values::text, '')) ~ 'SYN-NID-LEAK'), 0,
  'a national_id_number value is in no audit_log row (INSERT of tenant A and B doctors)');
SELECT is((SELECT count(*)::int FROM audit.audit_log a WHERE a.schema_name = 'catalog' AND a.table_name = 'doctors' AND a.row_id = pg_temp.uid(2) AND a.new_values ? 'national_id_number'), 0, 'the audit row of a doctor has no national_id_number key');
SELECT is(pg_temp.upd(format($$ UPDATE catalog.doctors SET national_id_number = 'SYN-NID-LEAK-CHANGED', speciality = 'Haematology (synthetic)' WHERE id = %L $$, pg_temp.uid(2))), 'ok', 'a doctor ID number can change');
SELECT is((SELECT count(*)::int FROM audit.audit_log a WHERE (coalesce(a.old_values::text, '') || coalesce(a.new_values::text, '')) ~ 'SYN-NID-LEAK'), 0, 'an UPDATE of the ID number leaves no value in audit_log either');
SELECT ok(EXISTS (SELECT 1 FROM audit.audit_log a WHERE a.schema_name = 'catalog' AND a.table_name = 'doctors' AND a.row_id = pg_temp.uid(2) AND a.action = 'UPDATE' AND 'speciality' = ANY (a.changed_columns)),
  'the other changed doctor column (speciality) is still audited');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'catalog.doctors'::regclass AND tgname = 'doctors__audit' AND pg_get_triggerdef(oid) ~ 'tg_row_audit\(''national_id_number''\)'), 1, 'doctors__audit excludes national_id_number');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'partners.partners'::regclass AND tgname = 'partners__audit' AND pg_get_triggerdef(oid) ~ 'tax_number' AND pg_get_triggerdef(oid) ~ 'national_id_number'), 1, 'partners__audit excludes tax_number and national_id_number');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'catalog.credit_parties'::regclass AND tgname = 'credit_parties__audit' AND pg_get_triggerdef(oid) ~ '''pan'''), 1, 'credit_parties__audit excludes pan');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid IN ('catalog.doctors'::regclass, 'partners.partners'::regclass, 'catalog.credit_parties'::regclass) AND NOT tgisinternal AND pg_get_triggerdef(oid) ~ 'tg_row_audit'), 3,
  'each of the three tables still has exactly one audit trigger');

-- ===================================================================================================================================== idempotent re-apply: second run changes nothing
CREATE FUNCTION pg_temp.state() RETURNS text LANGUAGE sql AS $$
  SELECT concat_ws('|',
    (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r' AND c.relnamespace IN ('partners'::regnamespace, 'catalog'::regnamespace)),
    (SELECT count(*) FROM pg_class WHERE relkind = 'r' AND relnamespace IN ('partners'::regnamespace, 'catalog'::regnamespace)),
    (SELECT count(*) FROM pg_constraint WHERE connamespace IN ('partners'::regnamespace, 'catalog'::regnamespace)),
    (SELECT count(*) FROM pg_index WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('partners'::regnamespace, 'catalog'::regnamespace))),
    (SELECT count(*) FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('partners'::regnamespace, 'catalog'::regnamespace))),
    (SELECT string_agg(pg_get_triggerdef(oid), ';' ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('partners'::regnamespace, 'catalog'::regnamespace)) AND NOT tgisinternal),
    (SELECT count(*) FROM partners.party_commercial_setting), (SELECT count(*) FROM partners.party_onboarding), (SELECT count(*) FROM partners.non_compliance_penalty),
    (SELECT count(*) FROM partners.non_compliance_event), (SELECT count(*) FROM catalog.icd_code), (SELECT count(*) FROM catalog.doctors)) $$;
CREATE TEMP TABLE before_state AS SELECT pg_temp.state() AS s;
\ir ../../migrations/20261117220000_partners__add_party_settings_and_penalties.sql
RESET ROLE;
SELECT is(pg_temp.state(), (SELECT s FROM before_state), 're-apply: tables, columns, constraints, indexes, policies, triggers and row counts are unchanged');
SELECT is((SELECT status FROM partners.party_onboarding WHERE id = pg_temp.uid(203)), 'rejected', 're-apply: no data rewrite (onboarding decision intact)');
SELECT is((SELECT ledger_entry_id FROM partners.non_compliance_event WHERE id = pg_temp.uid(402)), pg_temp.uid(7003), 're-apply: no data rewrite (ledger entry intact)');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'catalog.doctors'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ~* 'commission'), 0, 're-apply: catalog.doctors still has no commission column (LD-385)');
SELECT is(has_table_privilege('lims_app', 'partners.non_compliance_event', 'DELETE'), false, 're-apply keeps DELETE revoked');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'catalog.doctors'::regclass AND tgname = 'doctors__audit' AND pg_get_triggerdef(oid) ~ 'national_id_number'), 1, 're-apply keeps the audit exclusion');

SELECT * FROM finish();
ROLLBACK;
