-- T0C-REGPARITY-1 pgTAP suite (LD-310; founder request 2026-11-17 04:49 NPT: all ElabAssist registration fields) for migration
-- 20261117100000_frontdesk__add_patient_parity_fields.sql: additive nullable columns on frontdesk.patients, value constraints, per-tenant unique external id,
-- RLS unchanged and still covering the new columns, government id and structured address kept out of audit.audit_log (08 A13 D-27a), idempotent re-apply.
-- Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written by the superuser test session with system claims (audit context),
-- every isolation assertion runs as SET LOCAL ROLE lims_app. Seeds 010 supply tenant A/B (a001/b001) and centres a201/b201.
-- Run: bash db/tests/run-suites.sh db/tests/frontdesk_billing/T0C-REGPARITY-1_patient_parity.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (brief silent): all 13 new columns are nullable with NO default (no data rewrite); title / government_id_type are text + CHECK or FK to a code table
-- (the frontdesk schema forbids ENUM types, 05-SCHEMA §0.3), stored either as the ElabAssist label or its lower snake_case code (both accepted here);
-- nationality is stored upper case ^[A-Z]{2}$; the six address_* parts are audit-excluded like address_text (D-27a).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.pid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c4f0-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.centre(p_tenant uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_tenant = '01a1a98a-ac40-7000-8000-00000000a001'::uuid THEN '01a1a98a-ac40-7000-8000-00000000a201'::uuid ELSE '01a1a98a-ac40-7000-8000-00000000b201'::uuid END $$;
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'system') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', pg_temp.sys(),
    'membership_id', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a500' ELSE '01a1a98a-ac40-7000-8000-00000000b500' END::uuid) $$;
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
-- superuser fixture insert (system claims of the row's tenant give app.tg_row_audit its context); 'ok' or SQLSTATE. p_cols / p_vals extend the base column list.
CREATE FUNCTION pg_temp.ins(p_n int, p_tenant uuid, p_cols text DEFAULT '', p_vals text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.cl(p_tenant)::text, true);
  BEGIN
    EXECUTE format($q$ INSERT INTO frontdesk.patients (id, tenant_id, patient_code, full_name, name_search, sex, registered_centre_id, created_by, updated_by%s)
                       VALUES (%L, %L, %L, %L, %L, 'female', %L, %L, %L%s) $q$,
      CASE WHEN p_cols = '' THEN '' ELSE ', ' || p_cols END, pg_temp.pid(p_n), p_tenant, 'RP-' || p_n, 'Synthetic Parity ' || p_n, 'synthetic parity ' || p_n,
      pg_temp.centre(p_tenant), pg_temp.sys(), pg_temp.sys(), CASE WHEN p_vals = '' THEN '' ELSE ', ' || p_vals END);
    r := 'ok';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE; END;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;
-- try the ElabAssist label, then its snake_case code: 'ok' when either representation is accepted, else the code of the second failure
CREATE FUNCTION pg_temp.ins_either(p_n int, p_col text, p_label text, p_code text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
  r := pg_temp.ins(p_n, pg_temp.ta(), p_col, quote_literal(p_label));
  IF r <> 'ok' THEN r := pg_temp.ins(p_n, pg_temp.ta(), p_col, quote_literal(p_code)); END IF;
  RETURN r;
END $f$;

CREATE TEMP TABLE newcol(name, typ) AS VALUES
  ('title','text'),('external_patient_id','text'),('nationality','text'),('government_id_type','text'),('government_id_number','text'),
  ('address_province','text'),('address_district','text'),('address_municipality','text'),('address_ward','text'),('address_tole','text'),('address_postal_code','text'),
  ('profile_photo_attachment_id','uuid'),('custom_fields','jsonb');

-- ===================================================================================================================================== (1)(4) additive, nullable, no default
SELECT is((SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = 'frontdesk.patients'::regclass AND a.attname = n.name AND NOT a.attisdropped), n.typ,
  'frontdesk.patients.' || n.name || ' exists as ' || n.typ) FROM newcol n;
SELECT is((SELECT NOT a.attnotnull AND NOT a.atthasdef FROM pg_attribute a WHERE a.attrelid = 'frontdesk.patients'::regclass AND a.attname = n.name AND NOT a.attisdropped), true,
  'frontdesk.patients.' || n.name || ' is nullable with no default (additive, no data rewrite)') FROM newcol n;
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'frontdesk.patients'::regclass AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname IN ('id','tenant_id','patient_code','full_name','name_search','sex','birth_on','is_birth_on_estimated','phone_e164','email','address_text','source','registered_centre_id',
                              'last_visit_at','duplicate_override_reason_code','anonymised_at','anonymised_by','anonymise_reason_code','version','is_active','created_at','created_by','updated_at','updated_by')),
  24, 'all 24 existing patient columns are untouched (address_text stays beside the structured address)');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'frontdesk.patients'::regclass AND a.attnum > 0 AND NOT a.attisdropped), 24 + 13, 'patients has exactly the 24 old + 13 new columns');
SELECT is((SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = 'frontdesk'::regnamespace AND t.typtype = 'e'), 0, 'no ENUM type in frontdesk (title / government_id_type use CHECK or a code table)');

-- ===================================================================================================================================== value constraints
-- title: the 19 ElabAssist titles are accepted, anything else is not
SELECT is(pg_temp.ins_either(10 + t.i, 'title', t.label, t.code), 'ok', 'title ' || t.label || ' accepted')
  FROM (VALUES (1,'Mr','mr'),(2,'Mrs','mrs'),(3,'Miss','miss'),(4,'Ms','ms'),(5,'Master','master'),(6,'Baby','baby'),(7,'Baby of','baby_of'),(8,'Dr','dr'),(9,'Prof','prof'),(10,'Capt','capt'),
              (11,'Col','col'),(12,'Major','major'),(13,'Sri','sri'),(14,'Smt','smt'),(15,'Kumari','kumari'),(16,'Late','late'),(17,'Sister','sister'),(18,'Reverend','reverend'),(19,'Other','other')) t(i, label, code);
SELECT isnt(pg_temp.ins(40, pg_temp.ta(), 'title', quote_literal('Emperor')), 'ok', 'title outside the 19 is rejected');
SELECT isnt(pg_temp.ins(41, pg_temp.ta(), 'title', quote_literal('')), 'ok', 'empty title is rejected (NULL is the only "none")');
-- nationality: ISO 3166 alpha-2 shape
SELECT is(pg_temp.ins(42, pg_temp.ta(), 'nationality', quote_literal('NP')), 'ok', 'nationality NP accepted');
SELECT is(pg_temp.ins(43, pg_temp.ta(), 'nationality', quote_literal('IN')), 'ok', 'nationality IN accepted');
SELECT isnt(pg_temp.ins(44, pg_temp.ta(), 'nationality', quote_literal('np')), 'ok', 'nationality lower case rejected');
SELECT isnt(pg_temp.ins(45, pg_temp.ta(), 'nationality', quote_literal('NPL')), 'ok', 'nationality alpha-3 rejected');
SELECT isnt(pg_temp.ins(46, pg_temp.ta(), 'nationality', quote_literal('N1')), 'ok', 'nationality with a digit rejected');
SELECT isnt(pg_temp.ins(47, pg_temp.ta(), 'nationality', quote_literal('')), 'ok', 'empty nationality rejected');
-- government id type: the six Nepal types; India-only types are not copied (LD-310 (b))
SELECT is(pg_temp.ins(50 + t.i, pg_temp.ta(), 'government_id_type', quote_literal(t.v)), 'ok', 'government_id_type ' || t.v || ' accepted')
  FROM (VALUES (1,'citizenship'),(2,'national_id'),(3,'passport'),(4,'driving_licence'),(5,'voter_id'),(6,'other')) t(i, v);
SELECT isnt(pg_temp.ins(60, pg_temp.ta(), 'government_id_type', quote_literal('aadhaar')), 'ok', 'aadhaar is not a government_id_type (India-only, LD-310 (b))');
SELECT isnt(pg_temp.ins(61, pg_temp.ta(), 'government_id_type', quote_literal('')), 'ok', 'empty government_id_type rejected');
-- custom_fields: a JSON object or NULL, never an array / scalar
SELECT is(pg_temp.ins(62, pg_temp.ta(), 'custom_fields', quote_literal('{}') || '::jsonb'), 'ok', 'custom_fields {} accepted');
SELECT is(pg_temp.ins(63, pg_temp.ta(), 'custom_fields', quote_literal('{"blood_group":"O+","k":1}') || '::jsonb'), 'ok', 'custom_fields object accepted');
SELECT isnt(pg_temp.ins(64, pg_temp.ta(), 'custom_fields', quote_literal('[]') || '::jsonb'), 'ok', 'custom_fields array rejected');
SELECT isnt(pg_temp.ins(65, pg_temp.ta(), 'custom_fields', quote_literal('"x"') || '::jsonb'), 'ok', 'custom_fields string rejected');
SELECT isnt(pg_temp.ins(66, pg_temp.ta(), 'custom_fields', quote_literal('1') || '::jsonb'), 'ok', 'custom_fields number rejected');
SELECT is(pg_temp.ins(67, pg_temp.ta(), 'custom_fields', 'NULL'), 'ok', 'custom_fields NULL accepted');
-- profile photo reference
SELECT is(pg_temp.ins(68, pg_temp.ta(), 'profile_photo_attachment_id', quote_literal(pg_temp.pid(9999))), 'ok', 'profile_photo_attachment_id takes a uuid');

-- ===================================================================================================================================== external_patient_id unique per tenant when present
SELECT is(pg_temp.ins(70, pg_temp.ta(), 'external_patient_id', quote_literal('MR-SYN-0001')), 'ok', 'external_patient_id set');
SELECT is(pg_temp.ins(71, pg_temp.ta(), 'external_patient_id', quote_literal('MR-SYN-0001')), '23505', 'same external_patient_id in the same tenant -> unique_violation');
SELECT is(pg_temp.ins(72, pg_temp.tb(), 'external_patient_id', quote_literal('MR-SYN-0001')), 'ok', 'same external_patient_id in another tenant is allowed');
SELECT is(pg_temp.ins(73, pg_temp.ta()), 'ok', 'patient without external_patient_id (1/2)');
SELECT is(pg_temp.ins(74, pg_temp.ta()), 'ok', 'patient without external_patient_id (2/2): NULLs never collide');
SELECT ok(EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = 'frontdesk.patients'::regclass AND i.indisunique AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = i.indrelid AND attname = 'tenant_id')
            AND i.indkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = i.indrelid AND attname = 'external_patient_id')),
  'a unique index / constraint leads with (tenant_id, external_patient_id) (§9 test 2: tenant_id first)');

-- ===================================================================================================================================== (3) RLS unchanged and covering the new columns
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'frontdesk.patients'::regclass), true, 'patients keeps ENABLE + FORCE row level security');
SELECT is((SELECT array_agg(polname::text ORDER BY polname) FROM pg_policy WHERE polrelid = 'frontdesk.patients'::regclass),
  ARRAY['patients__insert__tenant','patients__select__tenant','patients__update__tenant'], 'the three patients policies are unchanged: no new, dropped or renamed policy');
SELECT is((SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = 'frontdesk.patients'::regclass
            AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) !~ 'tenant_id = '), 0, 'every patients policy is still tenant_id-scoped');
SELECT is(coalesce((SELECT has_column_privilege('lims_app', a.attrelid, a.attnum, p.priv) FROM pg_attribute a WHERE a.attrelid = 'frontdesk.patients'::regclass AND a.attname = n.name AND NOT a.attisdropped), false), true,
  'lims_app ' || p.priv || ' on patients.' || n.name) FROM newcol n CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE')) p(priv);
SELECT is(has_table_privilege('lims_app', 'frontdesk.patients', 'DELETE'), false, 'still no DELETE on patients (anonymise instead)');

SELECT is(pg_temp.ins(80, pg_temp.ta(), 'government_id_type, government_id_number, address_province, external_patient_id, custom_fields',
  quote_literal('citizenship') || ', ' || quote_literal('SYN-CIT-0000-4321') || ', ' || quote_literal('Bagmati') || ', ' || quote_literal('MR-SYN-0080') || ', ' || quote_literal('{"k":"v"}') || '::jsonb'),
  'ok', 'fixture: tenant A patient with all sensitive new columns');
SELECT is(pg_temp.ins(81, pg_temp.tb(), 'government_id_type, government_id_number, address_province, external_patient_id, custom_fields',
  quote_literal('passport') || ', ' || quote_literal('SYN-PAS-0000-8765') || ', ' || quote_literal('Gandaki') || ', ' || quote_literal('MR-SYN-0081') || ', ' || quote_literal('{"k":"w"}') || '::jsonb'),
  'ok', 'fixture: tenant B patient with all sensitive new columns');
SELECT is(pg_temp.a('SELECT government_id_number, address_province, external_patient_id, custom_fields FROM frontdesk.patients WHERE id = ' || quote_literal(pg_temp.pid(80)), 'n'), 'n=1',
  'control: tenant A staff reads its own new columns');
SELECT is(pg_temp.a('SELECT government_id_number FROM frontdesk.patients WHERE id = ' || quote_literal(pg_temp.pid(81)), 'n'), 'n=0', 'tenant A cannot read tenant B government_id_number');
SELECT is(pg_temp.a('SELECT 1 FROM frontdesk.patients WHERE external_patient_id = ''MR-SYN-0081''', 'n'), 'n=0', 'tenant A cannot find tenant B by external_patient_id');
SELECT is(pg_temp.a('SELECT 1 FROM frontdesk.patients WHERE government_id_number = ''SYN-PAS-0000-8765''', 'n'), 'n=0', 'tenant A cannot find tenant B by government_id_number');
SELECT is(pg_temp.b('SELECT 1 FROM frontdesk.patients WHERE government_id_number = ''SYN-CIT-0000-4321''', 'n'), 'n=0', 'tenant B cannot find tenant A by government_id_number');
SELECT is(pg_temp.a('UPDATE frontdesk.patients SET government_id_number = ''SYN-HIJACK'', custom_fields = ''{}''::jsonb WHERE id = ' || quote_literal(pg_temp.pid(81))), 'n=0', 'tenant A updates 0 tenant B rows on the new columns');
SELECT is((SELECT to_jsonb(p) ->> 'government_id_number' FROM frontdesk.patients p WHERE p.id = pg_temp.pid(81)), 'SYN-PAS-0000-8765', 'tenant B government_id_number is unchanged');
SELECT alike(pg_temp.a(format($$ INSERT INTO frontdesk.patients (id, tenant_id, patient_code, full_name, name_search, sex, registered_centre_id, created_by, updated_by, government_id_number)
  VALUES (%L, %L, 'RP-X1', 'Synthetic X', 'synthetic x', 'male', %L, %L, %L, 'SYN-X') $$, pg_temp.pid(90), pg_temp.tb(), pg_temp.centre(pg_temp.tb()), pg_temp.sys(), pg_temp.sys())),
  'E42501|%', 'tenant A cannot insert a patient for tenant B carrying the new columns');
SELECT is(pg_temp.a(format($$ INSERT INTO frontdesk.patients (id, tenant_id, patient_code, full_name, name_search, sex, registered_centre_id, created_by, updated_by, government_id_type, government_id_number)
  VALUES (%L, %L, 'RP-A1', 'Synthetic A', 'synthetic a', 'male', %L, %L, %L, 'national_id', 'SYN-NID-0000-1111') $$, pg_temp.pid(91), pg_temp.ta(), pg_temp.centre(pg_temp.ta()), pg_temp.sys(), pg_temp.sys())), 'n=1',
  'tenant A staff inserts its own patient with the new columns');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), 'SELECT government_id_number FROM frontdesk.patients', 'n'), 'n=0', 'a patient-actor sees 0 patients, new columns included');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner'), 'SELECT government_id_number FROM frontdesk.patients', 'n'), 'n=0', 'a partner-actor sees 0 patients, new columns included');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal'), 'SELECT government_id_number FROM frontdesk.patients', 'n'), 'n=0', 'a portal-actor sees 0 patients, new columns included');

-- ===================================================================================================================================== (2) sensitive: never in audit diffs, no other view or table exposes it
SELECT is(pg_temp.a('UPDATE frontdesk.patients SET government_id_number = ''SYN-CIT-0000-9999'', government_id_type = ''national_id'', address_province = ''Koshi'', address_district = ''Morang'',
  address_municipality = ''Synthetic Municipality'', address_ward = ''7'', address_tole = ''Synthetic Tole'', address_postal_code = ''56613'', last_visit_at = now() WHERE id = ' || quote_literal(pg_temp.pid(80))), 'n=1',
  'update government id and the structured address (+ last_visit_at)');
SELECT is((SELECT count(*)::int FROM audit.audit_log a WHERE a.schema_name = 'frontdesk' AND a.table_name = 'patients' AND a.row_id = pg_temp.pid(80)
            AND (a.changed_columns && ARRAY['government_id_number','address_province','address_district','address_municipality','address_ward','address_tole','address_postal_code']
                 OR a.old_values ?| ARRAY['government_id_number','address_province','address_district','address_municipality','address_ward','address_tole','address_postal_code']
                 OR a.new_values ?| ARRAY['government_id_number','address_province','address_district','address_municipality','address_ward','address_tole','address_postal_code'])), 0,
  'D-27a / LD-310: no government id or structured address column in changed_columns / old_values / new_values of any patients audit row');
SELECT is((SELECT count(*)::int FROM audit.audit_log a WHERE a.schema_name = 'frontdesk' AND a.table_name = 'patients'
            AND (coalesce(a.old_values::text, '') || coalesce(a.new_values::text, '') || coalesce(a.changed_columns::text, '')) ~ 'SYN-CIT-0000|SYN-PAS-0000|SYN-NID-0000|Synthetic Tole|Synthetic Municipality'), 0,
  'no government id or address value appears anywhere in audit.audit_log (INSERT and UPDATE rows of every fixture)');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'frontdesk' AND table_name = 'patients' AND row_id = pg_temp.pid(80) AND action = 'INSERT'), 1, 'control: the INSERT of the fixture was audited (the trigger still fires)');
SELECT ok((SELECT 'last_visit_at' = ANY (changed_columns) FROM audit.audit_log WHERE schema_name = 'frontdesk' AND table_name = 'patients' AND row_id = pg_temp.pid(80) AND action = 'UPDATE'),
  'control: last_visit_at still recorded as changed (the exclusion list was extended, not replaced by an all-columns filter)');
SELECT is((SELECT count(*)::int FROM audit.audit_log a WHERE a.schema_name = 'frontdesk' AND a.table_name = 'patients' AND a.row_id = pg_temp.pid(80)
            AND (a.changed_columns && ARRAY['full_name','name_search','birth_on','phone_e164','email','address_text'] OR a.old_values ?| ARRAY['full_name','name_search','birth_on','phone_e164','email','address_text']
                 OR a.new_values ?| ARRAY['full_name','name_search','birth_on','phone_e164','email','address_text'])), 0, 'the existing demographic exclusions still hold');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'frontdesk.patients'::regclass AND tgname = 'patients__audit' AND NOT tgisinternal), 1, 'exactly one patients__audit trigger');
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
            WHERE a.attname = 'government_id_number' AND NOT a.attisdropped AND a.attnum > 0 AND c.relkind IN ('v','m')), 0, 'no view or materialised view exposes government_id_number (lists / v_pub_* never carry it)');
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
            WHERE a.attname = 'government_id_number' AND NOT a.attisdropped AND a.attnum > 0 AND c.relkind IN ('r','p') AND c.oid <> 'frontdesk.patients'::regclass), 0, 'government_id_number lives only on frontdesk.patients');

-- ===================================================================================================================================== (4) idempotent re-apply: second run changes nothing
CREATE TEMP TABLE before_state AS
  SELECT (SELECT count(*) FROM pg_attribute WHERE attrelid = 'frontdesk.patients'::regclass AND attnum > 0 AND NOT attisdropped) AS cols,
         (SELECT count(*) FROM pg_constraint WHERE conrelid = 'frontdesk.patients'::regclass) AS cons,
         (SELECT count(*) FROM pg_index WHERE indrelid = 'frontdesk.patients'::regclass) AS idxs,
         (SELECT count(*) FROM pg_policy WHERE polrelid = 'frontdesk.patients'::regclass) AS pols,
         (SELECT string_agg(pg_get_triggerdef(oid), '|' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'frontdesk.patients'::regclass AND NOT tgisinternal) AS trg,
         (SELECT count(*) FROM frontdesk.patients) AS n_rows;
\ir ../../migrations/20261117100000_frontdesk__add_patient_parity_fields.sql
RESET ROLE;
SELECT is((SELECT count(*) FROM pg_attribute WHERE attrelid = 'frontdesk.patients'::regclass AND attnum > 0 AND NOT attisdropped), (SELECT cols FROM before_state), 're-apply: column count unchanged');
SELECT is((SELECT count(*) FROM pg_constraint WHERE conrelid = 'frontdesk.patients'::regclass), (SELECT cons FROM before_state), 're-apply: constraint count unchanged');
SELECT is((SELECT count(*) FROM pg_index WHERE indrelid = 'frontdesk.patients'::regclass), (SELECT idxs FROM before_state), 're-apply: index count unchanged');
SELECT is((SELECT count(*) FROM pg_policy WHERE polrelid = 'frontdesk.patients'::regclass), (SELECT pols FROM before_state), 're-apply: policy count unchanged');
SELECT is((SELECT string_agg(pg_get_triggerdef(oid), '|' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'frontdesk.patients'::regclass AND NOT tgisinternal), (SELECT trg FROM before_state), 're-apply: triggers unchanged');
SELECT is((SELECT count(*) FROM frontdesk.patients), (SELECT n_rows FROM before_state), 're-apply: no row added or removed');
SELECT is((SELECT to_jsonb(p) ->> 'government_id_number' FROM frontdesk.patients p WHERE p.id = pg_temp.pid(80)), 'SYN-CIT-0000-9999', 're-apply: no data rewrite (fixture value intact)');

SELECT * FROM finish();
ROLLBACK;
