-- T0C-SALES-1 pgTAP suite (LD-321; founder blanket authority LD-310; priority 2026-11-17 09:18 NPT) for migration 20261117210000_partners__add_sales_hierarchy.sql:
-- four tenant tables in schema partners (sales_designation, sales_representative, party_sales_assignment, service_area) and one in schema homecollection (collector_flags).
-- Covers: shape + CHECKs, designation level 1..8 unique per tenant, representative manager rules (never own manager, chain never loops), overlapping assignment refused,
-- composite tenant FKs, ENABLE + FORCE RLS by tenant, grants (no DELETE: deactivate instead), isolation probes (A/B, patient / partner / portal actors), collector flags default true, audit, idempotent re-apply.
-- Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written by the superuser test session with system claims (audit context),
-- every isolation assertion runs as SET LOCAL ROLE lims_app. Seeds supply tenant A/B (a001/b001), centres a201/b201, memberships a500/b500.
-- Run: bash db/tests/run-suites.sh db/tests/partners/T0C-SALES-1_sales_hierarchy.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (brief gives fields, not column or constraint names; a different choice needs a ruling, not a silent test edit):
--  - Table names are the brief's, singular: partners.sales_designation, partners.sales_representative, partners.party_sales_assignment, partners.service_area.
--    HOMECOLLECTION: the repo has no collector table, so the flags live in the new homecollection.collector_flags (id, tenant_id, membership_id, allow_collection, allow_pickup, ...); an absent row means
--    both flags true, a new row defaults both to true (see the contract test header: the lead rules on the missing collector update operation).
--  - Columns pinned: every table has id, tenant_id, created_at, updated_at, created_by (uuid NOT NULL, no FK), version integer default 1; updated_by is filled when the column exists.
--    sales_designation(name, level smallint|integer 1..8, is_active); sales_representative(name, phone, email, user_id, designation_id, manager_id, joining_date, is_active);
--    party_sales_assignment(party_kind in partner|credit_party|doctor|referrer, party_id, representative_id, effective_from date NOT NULL, effective_to date NULL, last day INCLUSIVE);
--    service_area(name, district, area_text, centre_id, is_active); collector_flags(membership_id, allow_collection, allow_pickup).
--  - ids and tenant_id have no DEFAULT (UUIDv7 in app code). Designation level is unique per tenant over ALL rows (UNIQUE (tenant_id, level)). Texts are 1..N chars (NULL is the only "none").
--  - Manager rules are enforced by the database (trigger or CHECK): manager_id <> id; no chain of manager_id loops back (INSERT and UPDATE); manager must be in the same tenant (composite FK).
--  - Overlap rule: two assignments of the SAME party to the SAME representative may not overlap (inclusive dates, open end = no end). Different representatives for one party are NOT pinned.
--  - lims_app has SELECT, INSERT, UPDATE and NO DELETE on all five tables. Service areas are free text district / area_text (no pincode column); a centre_id of another tenant is refused (composite FK).
--  - Not tested here: tree depth cap (API), client list, deactivate rules (API), offline cache (client).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c4f0-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
CREATE FUNCTION pg_temp.centre(p_tenant uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_tenant = '01a1a98a-ac40-7000-8000-00000000a001'::uuid THEN pg_temp.id('00000000a201') ELSE pg_temp.id('00000000b201') END $$;
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
-- row builders (p_over is merged last)
CREATE FUNCTION pg_temp.des(n int, p_tenant uuid, p_level int, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'name', 'Synthetic designation ' || n, 'level', p_level) || p_over $$;
CREATE FUNCTION pg_temp.rep(n int, p_tenant uuid, p_des int, p_mgr int DEFAULT NULL, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'name', 'Synthetic representative ' || n, 'designation_id', pg_temp.uid(p_des),
    'manager_id', CASE WHEN p_mgr IS NULL THEN NULL ELSE pg_temp.uid(p_mgr) END, 'joining_date', '2026-01-01')) || p_over $$;
CREATE FUNCTION pg_temp.asg(n int, p_tenant uuid, p_rep int, p_party int, p_from text, p_to text DEFAULT NULL, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'party_kind', 'credit_party', 'party_id', pg_temp.uid(p_party), 'representative_id', pg_temp.uid(p_rep),
    'effective_from', p_from, 'effective_to', p_to)) || p_over $$;
CREATE FUNCTION pg_temp.area(n int, p_tenant uuid, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'name', 'Synthetic ward ' || n, 'district', 'Kathmandu', 'area_text', 'Synthetic municipality, ward ' || n) || p_over $$;

CREATE TEMP TABLE nt(s, t) AS VALUES ('partners','sales_designation'),('partners','sales_representative'),('partners','party_sales_assignment'),('partners','service_area'),('homecollection','collector_flags');

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
 WHERE c.relname IN (SELECT t FROM nt) AND c.relnamespace IN ('partners'::regnamespace, 'homecollection'::regnamespace)
   AND NOT (i.indisprimary AND i.indnatts = 1 AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'id');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass(n.s || '.' || n.t) AND k.contype = 'u' AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) = ARRAY['tenant_id','id']), n.t || ' has UNIQUE (tenant_id, id) next to PRIMARY KEY (id)') FROM nt n;
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass(n.s || '.' || n.t) AND k.contype = 'f' AND k.confrelid = 'core.tenants'::regclass), n.t || ' references core.tenants') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = to_regclass(n.s || '.' || n.t) AND a.attname IN ('id','tenant_id') AND a.atthasdef AND NOT a.attisdropped), 0, n.t || ': no DEFAULT on id / tenant_id') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = to_regclass(n.s || '.' || n.t) AND a.attname IN ('id','tenant_id','created_at','updated_at','created_by') AND a.attnotnull AND NOT a.attisdropped), 5,
  n.t || ': id, tenant_id, created_at, updated_at, created_by are NOT NULL') FROM nt n;
SELECT is((SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = to_regclass(m.s || '.' || m.t) AND a.attname = m.col AND NOT a.attisdropped), m.typ, m.t || '.' || m.col || ' is ' || m.typ)
  FROM (VALUES ('partners','sales_designation','name','text'),('partners','sales_designation','is_active','boolean'),('partners','sales_representative','name','text'),
               ('partners','sales_representative','designation_id','uuid'),('partners','sales_representative','manager_id','uuid'),('partners','sales_representative','user_id','uuid'),
               ('partners','sales_representative','joining_date','date'),('partners','sales_representative','is_active','boolean'),('partners','party_sales_assignment','party_id','uuid'),
               ('partners','party_sales_assignment','representative_id','uuid'),('partners','party_sales_assignment','effective_from','date'),('partners','party_sales_assignment','effective_to','date'),
               ('partners','service_area','name','text'),('partners','service_area','district','text'),('partners','service_area','area_text','text'),('partners','service_area','centre_id','uuid'),
               ('partners','service_area','is_active','boolean'),('homecollection','collector_flags','membership_id','uuid'),('homecollection','collector_flags','allow_collection','boolean'),
               ('homecollection','collector_flags','allow_pickup','boolean')) m(s, t, col, typ);
SELECT is((SELECT format_type(a.atttypid, a.atttypmod) IN ('smallint', 'integer') FROM pg_attribute a WHERE a.attrelid = 'partners.sales_designation'::regclass AND a.attname = 'level' AND NOT a.attisdropped), true, 'sales_designation.level is smallint or integer');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = 'partners.sales_representative'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
            AND a.attname IN ('name','designation_id','is_active')), ARRAY['designation_id','is_active','name'], 'representative: name, designation_id, is_active are NOT NULL');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = 'partners.sales_representative'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
            AND a.attname IN ('phone','email','user_id','manager_id','joining_date')), NULL::text[], 'representative: phone, email, user_id, manager_id, joining_date are nullable');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'partners.service_area'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ~* 'pin|postal|zip'), 0, 'service_area has no pincode style column (free text district and area)');
SELECT is((SELECT count(*)::int FROM pg_class WHERE relkind = 'S' AND relnamespace IN ('partners'::regnamespace, 'homecollection'::regnamespace) AND relname ~ 'sales|service_area|collector'), 0, 'no sequences');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = to_regclass(n.s || '.' || n.t) AND a.attnum > 0 AND NOT a.attisdropped AND a.atttypid IN ('float4'::regtype, 'float8'::regtype, 'numeric'::regtype, 'money'::regtype)), 0,
  'no float, numeric or money column in ' || n.t) FROM nt n;

-- ===================================================================================================================================== designations: level 1..8 unique per tenant
SELECT is(pg_temp.try('partners.sales_designation', pg_temp.des(1, pg_temp.ta(), 1)), 'ok', 'designation A1 level 1');
SELECT is(pg_temp.try('partners.sales_designation', pg_temp.des(2, pg_temp.ta(), 2)), 'ok', 'designation A2 level 2');
SELECT is(pg_temp.try('partners.sales_designation', pg_temp.des(3, pg_temp.ta(), 8)), 'ok', 'designation A3 level 8');
SELECT is(pg_temp.try('partners.sales_designation', pg_temp.des(4, pg_temp.ta(), 5, '{"is_active":false}')), 'ok', 'designation A4 level 5 inactive');
SELECT is(pg_temp.try('partners.sales_designation', pg_temp.des(5, pg_temp.tb(), 1)), 'ok', 'designation B5 level 1 (same level in another tenant is fine)');
SELECT is((SELECT is_active FROM partners.sales_designation WHERE id = pg_temp.uid(1)), true, 'a designation is active by default');
SELECT is((SELECT version FROM partners.sales_designation WHERE id = pg_temp.uid(1)), 1, 'a designation starts at version 1');
SELECT is(pg_temp.try('partners.sales_designation', pg_temp.des(6, pg_temp.ta(), 1)), '23505', 'level 1 twice in the same tenant -> unique_violation');
SELECT isnt(pg_temp.try('partners.sales_designation', pg_temp.des(10 + t.i, pg_temp.ta(), t.lvl, t.o)), 'ok', t.lbl)
  FROM (VALUES (1, 0, '{}'::jsonb, 'level 0 rejected'), (2, 9, '{}'::jsonb, 'level 9 rejected'), (3, -1, '{}'::jsonb, 'negative level rejected'), (4, 3, '{"name":""}'::jsonb, 'empty name rejected'),
               (5, 3, jsonb_build_object('name', repeat('n', 1000)), 'oversize name rejected'), (6, 3, '{"level":null}'::jsonb, 'NULL level rejected'), (7, 3, '{"name":null}'::jsonb, 'NULL name rejected')) t(i, lvl, o, lbl);
SELECT is(pg_temp.try('partners.sales_designation', pg_temp.des(20 + l, pg_temp.ta(), l)), 'ok', 'level ' || l || ' accepted') FROM generate_series(3, 7) l WHERE l <> 5;
SELECT is(pg_temp.a(format($$ UPDATE partners.sales_designation SET level = 9 WHERE id = %L $$, pg_temp.uid(1))) ~ '^E23514', true, 'update to level 9 -> check_violation');
SELECT is(pg_temp.a(format($$ UPDATE partners.sales_designation SET level = 2 WHERE id = %L $$, pg_temp.uid(1))) ~ '^E23505', true, 'update onto a level already used -> unique_violation');
SELECT is(pg_temp.a(format($$ DELETE FROM partners.sales_designation WHERE id = %L $$, pg_temp.uid(1))) ~ '^E42501', true, 'lims_app cannot delete a designation (deactivate instead)');

-- ===================================================================================================================================== representatives: manager tree rules
SELECT is(pg_temp.try('partners.sales_representative', pg_temp.rep(101, pg_temp.ta(), 1)), 'ok', 'root representative 101 (level 1, no manager)');
SELECT is(pg_temp.try('partners.sales_representative', pg_temp.rep(102, pg_temp.ta(), 2, 101)), 'ok', 'representative 102 reports to 101');
SELECT is(pg_temp.try('partners.sales_representative', pg_temp.rep(103, pg_temp.ta(), 3, 102)), 'ok', 'representative 103 reports to 102');
SELECT is(pg_temp.try('partners.sales_representative', pg_temp.rep(104, pg_temp.ta(), 23, 103)), 'ok', 'representative 104 reports to 103 (depth 4)');
SELECT is(pg_temp.try('partners.sales_representative', pg_temp.rep(105, pg_temp.ta(), 2, NULL, '{"phone":"+977 980 000 0000","email":"rep105@example.test","user_id":"0190c4f0-0000-7000-8000-000000000999","is_active":false}')), 'ok',
  'a representative with phone, email, user and inactive');
SELECT is(pg_temp.try('partners.sales_representative', pg_temp.rep(106, pg_temp.tb(), 5)), 'ok', 'representative B106');
SELECT is((SELECT is_active FROM partners.sales_representative WHERE id = pg_temp.uid(101)), true, 'a representative is active by default');
SELECT is((SELECT manager_id FROM partners.sales_representative WHERE id = pg_temp.uid(101)), NULL::uuid, 'manager_id is nullable (the top of the tree)');
SELECT isnt(pg_temp.try('partners.sales_representative', pg_temp.rep(110, pg_temp.ta(), 1, 110)), 'ok', 'a representative is never its own manager (INSERT)');
SELECT is(pg_temp.a(format($$ UPDATE partners.sales_representative SET manager_id = id WHERE id = %L $$, pg_temp.uid(101))) ~ '^E(23514|P0001|23P01|2F004|23000)', true, 'a representative is never its own manager (UPDATE)');
SELECT is(pg_temp.a(format($$ UPDATE partners.sales_representative SET manager_id = %L WHERE id = %L $$, pg_temp.uid(102), pg_temp.uid(101))) ~ '^E', true, 'two level loop 101 -> 102 -> 101 refused');
SELECT is(pg_temp.a(format($$ UPDATE partners.sales_representative SET manager_id = %L WHERE id = %L $$, pg_temp.uid(104), pg_temp.uid(101))) ~ '^E', true, 'four level loop 101 -> 104 -> 103 -> 102 -> 101 refused');
SELECT is((SELECT manager_id FROM partners.sales_representative WHERE id = pg_temp.uid(101)), NULL::uuid, 'a refused loop leaves the row unchanged');
SELECT is(pg_temp.a(format($$ UPDATE partners.sales_representative SET manager_id = %L WHERE id = %L $$, pg_temp.uid(101), pg_temp.uid(103))) ~ '^n=1', true, 'moving 103 directly under 101 (shorter chain, no loop) is allowed');
SELECT is((SELECT manager_id FROM partners.sales_representative WHERE id = pg_temp.uid(103)), pg_temp.uid(101), 'the move happened');
SELECT is(pg_temp.a(format($$ UPDATE partners.sales_representative SET manager_id = NULL WHERE id = %L $$, pg_temp.uid(103))) ~ '^n=1', true, 'clearing the manager is allowed');
SELECT is(pg_temp.a(format($$ UPDATE partners.sales_representative SET manager_id = %L WHERE id = %L $$, pg_temp.uid(103), pg_temp.uid(103))) ~ '^E', true, 'self manager by UPDATE refused again');
-- a row inserted pointing at an unrelated row of a loop cannot create a loop either: build 120 -> 121 and try to make 121's manager 120 by insert order
SELECT is(pg_temp.try('partners.sales_representative', pg_temp.rep(120, pg_temp.ta(), 1)), 'ok', 'representative 120');
SELECT is(pg_temp.try('partners.sales_representative', pg_temp.rep(121, pg_temp.ta(), 2, 120)), 'ok', 'representative 121 under 120');
SELECT is(pg_temp.a(format($$ UPDATE partners.sales_representative SET manager_id = %L WHERE id = %L $$, pg_temp.uid(121), pg_temp.uid(120))) ~ '^E', true, 'loop 120 -> 121 -> 120 refused');
SELECT is(pg_temp.try('partners.sales_representative', pg_temp.rep(130, pg_temp.ta(), 1, 106)), '23503', 'a manager of another tenant -> foreign_key_violation (composite tenant FK)');
SELECT is(pg_temp.try('partners.sales_representative', pg_temp.rep(131, pg_temp.ta(), 5)), '23503', 'a designation of another tenant -> foreign_key_violation');
SELECT is(pg_temp.try('partners.sales_representative', pg_temp.rep(132, pg_temp.ta(), 1, NULL, jsonb_build_object('designation_id', pg_temp.uid(9999)))), '23503', 'an unknown designation -> foreign_key_violation');
SELECT isnt(pg_temp.try('partners.sales_representative', pg_temp.rep(140 + t.i, pg_temp.ta(), 1, NULL, t.o)), 'ok', t.lbl)
  FROM (VALUES (1, '{"name":""}'::jsonb, 'empty name rejected'), (2, jsonb_build_object('name', repeat('n', 1000)), 'oversize name rejected'), (3, '{"name":null}'::jsonb, 'NULL name rejected'),
               (4, jsonb_build_object('email', repeat('e', 400)), 'oversize email rejected'), (5, '{"email":""}'::jsonb, 'empty email rejected'), (6, jsonb_build_object('phone', repeat('9', 100)), 'oversize phone rejected'),
               (7, '{"designation_id":null}'::jsonb, 'NULL designation rejected')) t(i, o, lbl);
SELECT is(pg_temp.a(format($$ DELETE FROM partners.sales_representative WHERE id = %L $$, pg_temp.uid(105))) ~ '^E42501', true, 'lims_app cannot delete a representative (deactivate instead)');
SELECT is(pg_temp.a(format($$ UPDATE partners.sales_representative SET is_active = false WHERE id = %L $$, pg_temp.uid(121))) ~ '^n=1', true, 'a representative can be deactivated');

-- ===================================================================================================================================== party assignments: overlap refused
SELECT is(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(201, pg_temp.ta(), 101, 900, '2026-01-01', '2026-06-30')), 'ok', 'assignment 201: party 900 -> rep 101, Jan..Jun');
SELECT is(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(202, pg_temp.ta(), 101, 900, '2026-07-01')), 'ok', 'assignment 202: same party and rep, from 1 July, open ended (adjacent, no overlap)');
SELECT is(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(203, pg_temp.ta(), 101, 901, '2026-01-01')), 'ok', 'assignment 203: another party, same rep, same dates');
SELECT is(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(204, pg_temp.tb(), 106, 900, '2026-01-01')), 'ok', 'assignment B204 (tenant B, party id reused)');
SELECT isnt(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(205, pg_temp.ta(), 101, 900, '2026-06-30', '2026-07-05')), 'ok', 'overlap on the shared day 30 June (inclusive end) refused');
SELECT isnt(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(206, pg_temp.ta(), 101, 900, '2026-03-01', '2026-03-31')), 'ok', 'a window inside an existing one refused');
SELECT isnt(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(207, pg_temp.ta(), 101, 900, '2026-12-01')), 'ok', 'an open ended assignment overlapping the open ended 202 refused');
SELECT isnt(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(208, pg_temp.ta(), 101, 900, '2025-01-01')), 'ok', 'an open ended assignment starting before everything overlaps both and is refused');
SELECT is(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(209, pg_temp.ta(), 101, 900, '2025-01-01', '2025-12-31')), 'ok', 'a window entirely before the first one is fine');
SELECT is(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(210, pg_temp.ta(), 102, 900, '2025-01-01', '2025-12-31', '{"party_kind":"doctor"}')), 'ok', 'the same party id as a doctor is a different party (kind is part of the key)');
SELECT is(pg_temp.a(format($$ UPDATE partners.party_sales_assignment SET effective_to = '2026-09-30' WHERE id = %L $$, pg_temp.uid(202))) ~ '^n=1', true, 'closing an open assignment (unassign) is allowed');
SELECT isnt(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(211, pg_temp.ta(), 101, 900, '2026-09-30', '2026-10-31')), 'ok', 'after closing, the shared last day 30 September still overlaps');
SELECT is(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(212, pg_temp.ta(), 101, 900, '2026-10-01')), 'ok', 'after closing, 1 October is free');
SELECT is(pg_temp.a(format($$ UPDATE partners.party_sales_assignment SET effective_from = '2026-06-15' WHERE id = %L $$, pg_temp.uid(202))) ~ '^E', true, 'moving a start date back into the previous window is refused too (UPDATE)');
SELECT isnt(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(213, pg_temp.ta(), 101, 902, '2026-05-01', '2026-04-01')), 'ok', 'effective_to before effective_from rejected');
SELECT isnt(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(214 + t.i, pg_temp.ta(), 101, 903, '2026-01-01', NULL, t.o)), 'ok', t.lbl)
  FROM (VALUES (1, '{"party_kind":"franchise"}'::jsonb, 'party_kind outside partner|credit_party|doctor|referrer rejected'), (2, '{"party_kind":"Doctor"}'::jsonb, 'party_kind is case sensitive'),
               (3, '{"party_kind":null}'::jsonb, 'NULL party_kind rejected'), (4, '{"effective_from":null}'::jsonb, 'NULL effective_from rejected'), (5, '{"party_id":null}'::jsonb, 'NULL party_id rejected')) t(i, o, lbl);
SELECT is(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(220 + k.i, pg_temp.ta(), 101, 910 + k.i, '2026-01-01', NULL, jsonb_build_object('party_kind', k.k))), 'ok', 'party_kind ' || k.k || ' accepted')
  FROM (VALUES (1, 'partner'), (2, 'credit_party'), (3, 'doctor'), (4, 'referrer')) k(i, k);
SELECT is(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(230, pg_temp.ta(), 106, 920, '2026-01-01')), '23503', 'a representative of another tenant -> foreign_key_violation');
SELECT is(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(231, pg_temp.ta(), 9999, 920, '2026-01-01')), '23503', 'an unknown representative -> foreign_key_violation');
SELECT is(pg_temp.a(format($$ DELETE FROM partners.party_sales_assignment WHERE id = %L $$, pg_temp.uid(201))) ~ '^E42501', true, 'lims_app cannot delete an assignment (unassign closes it)');
SELECT is(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(232, pg_temp.ta(), 101, 921, '2026-01-01')), 'ok', 'control: party 921 -> rep 101 open ended');
SELECT is(pg_temp.try('partners.party_sales_assignment', pg_temp.asg(233, pg_temp.ta(), 102, 921, '2026-01-01')), 'ok', 'control: the same party under another representative is not pinned by this task (no assertion on refusal)');

-- ===================================================================================================================================== service areas
SELECT is(pg_temp.try('partners.service_area', pg_temp.area(301, pg_temp.ta(), jsonb_build_object('centre_id', pg_temp.centre(pg_temp.ta())))), 'ok', 'area A301 with a centre');
SELECT is(pg_temp.try('partners.service_area', pg_temp.area(302, pg_temp.ta(), '{"area_text":null}')), 'ok', 'area A302 without area_text (nullable)');
SELECT is(pg_temp.try('partners.service_area', pg_temp.area(303, pg_temp.ta(), '{"is_active":false,"district":"Lalitpur"}')), 'ok', 'area A303 inactive, another district');
SELECT is(pg_temp.try('partners.service_area', pg_temp.area(304, pg_temp.tb())), 'ok', 'area B304');
SELECT is((SELECT is_active FROM partners.service_area WHERE id = pg_temp.uid(301)), true, 'an area is active by default');
SELECT is((SELECT centre_id FROM partners.service_area WHERE id = pg_temp.uid(302)), NULL::uuid, 'centre_id is nullable (area serves the whole tenant)');
SELECT is(pg_temp.try('partners.service_area', pg_temp.area(305, pg_temp.ta(), jsonb_build_object('centre_id', pg_temp.centre(pg_temp.tb())))), '23503', 'a centre of another tenant -> foreign_key_violation');
SELECT isnt(pg_temp.try('partners.service_area', pg_temp.area(310 + t.i, pg_temp.ta(), t.o)), 'ok', t.lbl)
  FROM (VALUES (1, '{"name":""}'::jsonb, 'empty name rejected'), (2, '{"district":""}'::jsonb, 'empty district rejected'), (3, '{"name":null}'::jsonb, 'NULL name rejected'), (4, '{"district":null}'::jsonb, 'NULL district rejected'),
               (5, jsonb_build_object('name', repeat('n', 1000)), 'oversize name rejected'), (6, jsonb_build_object('district', repeat('d', 500)), 'oversize district rejected'),
               (7, jsonb_build_object('area_text', repeat('a', 5000)), 'oversize area_text rejected'), (8, '{"area_text":""}'::jsonb, 'empty area_text rejected (NULL is the only none)')) t(i, o, lbl);
SELECT is(pg_temp.a(format($$ DELETE FROM partners.service_area WHERE id = %L $$, pg_temp.uid(301))) ~ '^E42501', true, 'lims_app cannot delete an area (deactivate instead)');
SELECT is(pg_temp.a(format($$ UPDATE partners.service_area SET is_active = false, version = version + 1 WHERE id = %L $$, pg_temp.uid(301))) ~ '^n=1', true, 'an area can be deactivated');

-- ===================================================================================================================================== collector flags (homecollection)
SELECT is(pg_temp.try('homecollection.collector_flags', jsonb_build_object('id', pg_temp.uid(401), 'tenant_id', pg_temp.ta(), 'membership_id', pg_temp.mem(pg_temp.ta()))), 'ok', 'a flags row without flags');
SELECT is((SELECT allow_collection FROM homecollection.collector_flags WHERE id = pg_temp.uid(401)), true, 'allow_collection defaults to true (nothing existing changes)');
SELECT is((SELECT allow_pickup FROM homecollection.collector_flags WHERE id = pg_temp.uid(401)), true, 'allow_pickup defaults to true');
SELECT is(pg_temp.try('homecollection.collector_flags', jsonb_build_object('id', pg_temp.uid(402), 'tenant_id', pg_temp.ta(), 'membership_id', pg_temp.mem(pg_temp.ta()))), '23505', 'one flags row per membership -> unique_violation');
SELECT is(pg_temp.try('homecollection.collector_flags', jsonb_build_object('id', pg_temp.uid(403), 'tenant_id', pg_temp.tb(), 'membership_id', pg_temp.mem(pg_temp.tb()), 'allow_collection', false, 'allow_pickup', true)), 'ok', 'tenant B row with collection off');
SELECT is(pg_temp.try('homecollection.collector_flags', jsonb_build_object('id', pg_temp.uid(404), 'tenant_id', pg_temp.ta(), 'membership_id', pg_temp.mem(pg_temp.tb()))), '23503', 'a membership of another tenant -> foreign_key_violation');
SELECT is(pg_temp.try('homecollection.collector_flags', jsonb_build_object('id', pg_temp.uid(405), 'tenant_id', pg_temp.ta(), 'membership_id', pg_temp.uid(9999))), '23503', 'an unknown membership -> foreign_key_violation');
SELECT is(pg_temp.a(format($$ UPDATE homecollection.collector_flags SET allow_collection = NULL WHERE id = %L $$, pg_temp.uid(401))) ~ '^E23502', true, 'NULL allow_collection rejected (not_null_violation)');
SELECT is(pg_temp.a(format($$ UPDATE homecollection.collector_flags SET allow_pickup = false WHERE id = %L $$, pg_temp.uid(401))) ~ '^n=1', true, 'lims_app can turn pickup off');
SELECT is((SELECT allow_pickup FROM homecollection.collector_flags WHERE id = pg_temp.uid(401)), false, 'allow_pickup is now false');
SELECT is((SELECT allow_collection FROM homecollection.collector_flags WHERE id = pg_temp.uid(401)), true, 'allow_collection is untouched');
SELECT is(pg_temp.a(format($$ DELETE FROM homecollection.collector_flags WHERE id = %L $$, pg_temp.uid(401))) ~ '^E42501', true, 'lims_app cannot delete a flags row');

-- ===================================================================================================================================== tenant isolation (RLS probes)
CREATE TEMP TABLE probe(s, t, a_id, b_id) AS VALUES
  ('partners','sales_designation', pg_temp.uid(1), pg_temp.uid(5)), ('partners','sales_representative', pg_temp.uid(101), pg_temp.uid(106)),
  ('partners','party_sales_assignment', pg_temp.uid(201), pg_temp.uid(204)), ('partners','service_area', pg_temp.uid(301), pg_temp.uid(304)),
  ('homecollection','collector_flags', pg_temp.uid(401), pg_temp.uid(403));
SELECT is(pg_temp.a(format('SELECT 1 FROM %s.%s WHERE id = %L', p.s, p.t, p.a_id), 'n'), 'n=1', 'tenant A sees its own row of ' || p.t) FROM probe p;
SELECT is(pg_temp.a(format('SELECT 1 FROM %s.%s WHERE id = %L', p.s, p.t, p.b_id), 'n'), 'n=0', 'tenant A cannot see the tenant B row of ' || p.t) FROM probe p;
SELECT is(pg_temp.b(format('SELECT 1 FROM %s.%s WHERE id = %L', p.s, p.t, p.a_id), 'n'), 'n=0', 'tenant B cannot see the tenant A row of ' || p.t) FROM probe p;
SELECT is(pg_temp.a(format('SELECT 1 FROM %s.%s WHERE tenant_id = %L', p.s, p.t, pg_temp.tb()), 'n'), 'n=0', 'filtering on the other tenant id still returns nothing for ' || p.t) FROM probe p;
SELECT is(pg_temp.a(format($$ UPDATE partners.sales_designation SET name = 'hijack' WHERE id = %L $$, pg_temp.uid(5))), 'n=0', 'tenant A cannot update the tenant B designation (0 rows)');
SELECT is(pg_temp.a(format($$ UPDATE partners.service_area SET is_active = false WHERE id = %L $$, pg_temp.uid(304))), 'n=0', 'tenant A cannot update the tenant B area (0 rows)');
SELECT alike(pg_temp.a(format($$ INSERT INTO partners.sales_designation (id, tenant_id, name, level, created_by) VALUES (%L, %L, 'x', 7, %L) $$, pg_temp.uid(500), pg_temp.tb(), pg_temp.sys())), 'E42501|%',
  'tenant A cannot insert a designation for tenant B');
SELECT alike(pg_temp.a(format($$ INSERT INTO partners.service_area (id, tenant_id, name, district, created_by) VALUES (%L, %L, 'x', 'y', %L) $$, pg_temp.uid(501), pg_temp.tb(), pg_temp.sys())), 'E42501|%',
  'tenant A cannot insert an area for tenant B');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format('SELECT 1 FROM %s.%s', p.s, p.t), 'n'), 'n=0', 'a ' || r.k || '-actor sees 0 rows of ' || p.t) FROM probe p CROSS JOIN (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ INSERT INTO partners.sales_designation (id, tenant_id, name, level, created_by) VALUES (%L, %L, 'x', 6, %L) $$,
  pg_temp.uid(510), pg_temp.ta(), pg_temp.sys()), 'w'), 'E42501|%', 'a ' || r.k || '-actor cannot insert a designation') FROM (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ INSERT INTO partners.party_sales_assignment (id, tenant_id, party_kind, party_id, representative_id, effective_from, created_by)
  VALUES (%L, %L, 'doctor', %L, %L, '2027-01-01', %L) $$, pg_temp.uid(511), pg_temp.ta(), pg_temp.uid(950), pg_temp.uid(101), pg_temp.sys()), 'w'), 'E42501|%', 'a ' || r.k || '-actor cannot assign a party') FROM (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ UPDATE homecollection.collector_flags SET allow_collection = false WHERE id = %L $$, pg_temp.uid(401)), 'w'), 'n=0',
  'a ' || r.k || '-actor cannot change collector flags (0 rows)') FROM (VALUES ('patient'),('partner'),('portal')) r(k);

-- ===================================================================================================================================== audit
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = x.s AND table_name = x.t AND row_id = x.rid AND action = 'INSERT'), 1, 'control: INSERT into ' || x.t || ' is audited')
  FROM (VALUES ('partners','sales_designation', pg_temp.uid(1)), ('partners','sales_representative', pg_temp.uid(101)), ('partners','party_sales_assignment', pg_temp.uid(201)),
               ('partners','service_area', pg_temp.uid(301)), ('homecollection','collector_flags', pg_temp.uid(401))) x(s, t, rid);
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = to_regclass(n.s || '.' || n.t) AND NOT tgisinternal AND pg_get_triggerdef(oid) ~ 'tg_row_audit'), 1, n.t || ' has one audit trigger') FROM nt n;
SELECT ok(EXISTS (SELECT 1 FROM audit.audit_log WHERE schema_name = 'partners' AND table_name = 'party_sales_assignment' AND row_id = pg_temp.uid(202) AND action = 'UPDATE' AND 'effective_to' = ANY (changed_columns)),
  'closing an assignment is recorded as changed (who unassigned whom)');
SELECT is((SELECT count(*)::int FROM audit.audit_log a WHERE a.schema_name = 'partners' AND a.table_name = 'sales_representative' AND (coalesce(a.old_values::text, '') || coalesce(a.new_values::text, '')) ~ 'rep105@example.test'), 0,
  'the representative e-mail and phone are not copied into the audit log (personal data; audit keeps ids and changed column names)');

-- ===================================================================================================================================== idempotent re-apply: second run changes nothing
CREATE FUNCTION pg_temp.state() RETURNS text LANGUAGE sql AS $$
  SELECT concat_ws('|',
    (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r' AND c.relnamespace IN ('partners'::regnamespace, 'homecollection'::regnamespace)),
    (SELECT count(*) FROM pg_class WHERE relkind = 'r' AND relnamespace IN ('partners'::regnamespace, 'homecollection'::regnamespace)),
    (SELECT count(*) FROM pg_constraint WHERE connamespace IN ('partners'::regnamespace, 'homecollection'::regnamespace)),
    (SELECT count(*) FROM pg_index WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('partners'::regnamespace, 'homecollection'::regnamespace))),
    (SELECT count(*) FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('partners'::regnamespace, 'homecollection'::regnamespace))),
    (SELECT string_agg(pg_get_triggerdef(oid), ';' ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN ('partners'::regnamespace, 'homecollection'::regnamespace)) AND NOT tgisinternal),
    (SELECT count(*) FROM partners.sales_designation), (SELECT count(*) FROM partners.sales_representative), (SELECT count(*) FROM partners.party_sales_assignment),
    (SELECT count(*) FROM partners.service_area), (SELECT count(*) FROM homecollection.collector_flags)) $$;
CREATE TEMP TABLE before_state AS SELECT pg_temp.state() AS s;
\ir ../../migrations/20261117210000_partners__add_sales_hierarchy.sql
RESET ROLE;
SELECT is(pg_temp.state(), (SELECT s FROM before_state), 're-apply: tables, columns, constraints, indexes, policies, triggers and row counts are unchanged');
SELECT is((SELECT allow_pickup FROM homecollection.collector_flags WHERE id = pg_temp.uid(401)), false, 're-apply: no data rewrite (flag value intact)');
SELECT is((SELECT effective_to FROM partners.party_sales_assignment WHERE id = pg_temp.uid(202)), '2026-09-30'::date, 're-apply: no data rewrite (assignment window intact)');
SELECT is(has_table_privilege('lims_app', 'partners.sales_representative', 'DELETE'), false, 're-apply keeps DELETE revoked');

SELECT * FROM finish();
ROLLBACK;
