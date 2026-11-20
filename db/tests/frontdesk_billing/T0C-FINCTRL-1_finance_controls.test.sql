-- T0C-FINCTRL-1 pgTAP suite (LD-321; founder blanket authority LD-310; priority 2026-11-17 09:18 NPT) for migration 20261117190000_billing__add_finance_controls.sql:
-- four NEW tenant tables in schema billing (discount_reason, party_discount_slab, user_discount_limit, discount_authority), the seed function billing.seed_discount_reasons(tenant, actor),
-- new columns on billing.account_ledger_entries (held_reason, held_by, held_at, released_by, released_at, fiscal_year_label) with the status `held` and a narrow hold / release rule,
-- and new columns on billing.cash_sessions (previous_outstanding_cash_paisa, deposit_paisa). Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written by the
-- superuser test session with system claims (audit context), every isolation assertion runs as SET LOCAL ROLE lims_app. Seeds supply tenants A/B (a001/b001), branches a101/b101, centres a201/b201, memberships a500/b500.
-- Run: bash db/tests/run-suites.sh db/tests/frontdesk_billing/T0C-FINCTRL-1_finance_controls.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (brief gives fields, not column or constraint names; a different choice needs a ruling, not a silent test edit; same style as T0C-ACCT-1 / T0C-PARTYSET-1):
--  - Every new table has id, tenant_id, created_at, updated_at, created_by (uuid NOT NULL, no FK), version integer default 1, is_active boolean default true (the repo word for the brief's `active`); no DEFAULT on id / tenant_id.
--  - discount_reason(code ^[A-Z0-9_]{1,32}$ unique per tenant, name 1..200, display_order integer 0..9999, is_active). The eight reasons the evidence file lists are seeded PER TENANT by billing.seed_discount_reasons(p_tenant_id uuid,
--    p_actor_id uuid) (SECURITY INVOKER, so RLS decides who may seed which tenant; idempotent; ON CONFLICT DO NOTHING). A migration cannot seed tenants that do not exist yet; T0B-FINCTRL-1 calls it on tenant setup.
--  - party_discount_slab(party_kind credit_party|partner|doctor|franchise, party_id uuid polymorphic (no FK), amount_from_paisa / amount_to_paisa bigint >= 0 with to > from, discount_bp integer 0..10000, effective_from date NOT NULL,
--    effective_to date NULL (open ended) >= effective_from, is_active). Amount range is HALF OPEN [from, to); dates inclusive. Two ACTIVE slabs of one (tenant, party_kind, party_id) never overlap in BOTH ranges; the refusal is SQLSTATE
--    23P01 (EXCLUDE) or 23505 (advisory-locked trigger, the 20261117200000 precedent: btree_gist is not assumed); updates and reactivation are checked too. party_kind and party_id never change after insert.
--  - user_discount_limit(user_id uuid (no FK), max_discount_bp 0..10000, max_discount_paisa bigint >= 0 per bill, is_active): one ACTIVE row per (tenant, user) (partial unique index), inactive rows unlimited.
--  - discount_authority(user_id uuid, max_discount_bp 0..10000, max_discount_paisa bigint >= 0, is_active): no uniqueness pinned.
--  - account_ledger_entries: status admits held (five values). status = 'held' needs held_reason (1..500), held_by, held_at and no released_*. fiscal_year_label NULL or ^[0-9]{4}/[0-9]{2}$. lims_app gets a COLUMN level UPDATE
--    grant on status, last_modified_by, updated_at, held_reason, held_by, held_at, released_by, released_at ONLY (no table level UPDATE, no DELETE), an UPDATE policy by tenant (staff or system), and a BEFORE UPDATE guard trigger:
--    the only status changes are submitted -> held (hold) and held -> submitted (release); on hold released_by / released_at are cleared; on release held_* stay as history and released_by / released_at are set;
--    every other column is immutable (amount, party, particular, entry date, entry type, payment mode, texts, receipt numbers, reverses_entry_id, fiscal_year_label, creator). approved / rejected / reversed entries are never held.
--  - cash_sessions: previous_outstanding_cash_paisa and deposit_paisa bigint NOT NULL DEFAULT 0 CHECK >= 0; previous_outstanding_cash_paisa is set at insert only; deposit_paisa stays editable (also after close: the cashier records the
--    deposit on the Daily Payment Collection screen); the mutable column list of cash_sessions__mutable_columns gains deposit_paisa.
--  - Not tested here: who may hold (billing.account.manage, API), statements counting only posted entries (service, T0B-FINCTRL-1), slab resolution, cloud apply (founder, push-cloud).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c4f0-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
CREATE FUNCTION pg_temp.centre(p_tenant uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_tenant = '01a1a98a-ac40-7000-8000-00000000a001'::uuid THEN pg_temp.id('00000000a201') ELSE pg_temp.id('00000000b201') END $$;
CREATE FUNCTION pg_temp.branch(p_tenant uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_tenant = '01a1a98a-ac40-7000-8000-00000000a001'::uuid THEN pg_temp.id('00000000a101') ELSE pg_temp.id('00000000b101') END $$;
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
-- superuser UPDATE with system claims of tenant A; returns 'ok' or SQLSTATE (used for the trigger and CHECK rules: RLS is not the subject)
CREATE FUNCTION pg_temp.upd(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE res text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', pg_temp.cl(pg_temp.ta())::text, true);
  BEGIN EXECUTE p_sql; res := 'ok'; EXCEPTION WHEN OTHERS THEN res := SQLSTATE; END;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN res;
END $f$;
-- row builders (p_over is merged last)
CREATE FUNCTION pg_temp.grp(n int, p_tenant uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'code', 'GRP_' || n, 'name', 'Synthetic group ' || n, 'nature', 'income') $$;
CREATE FUNCTION pg_temp.par(n int, p_tenant uuid, p_group int) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'account_group_id', pg_temp.uid(p_group), 'code', 'PAR_' || n, 'name', 'Synthetic particular ' || n) $$;
CREATE FUNCTION pg_temp.led(n int, p_tenant uuid, p_par int, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'centre_id', pg_temp.centre(p_tenant), 'party_kind', 'credit_party', 'party_id', pg_temp.uid(900),
    'entry_date', '2026-11-17', 'account_particular_id', pg_temp.uid(p_par), 'entry_type', 'credit', 'amount_paisa', 150000, 'payment_mode', 'cash',
    'receipt_no', 'SYN-FIN-' || n, 'receipt_seq', n, 'last_modified_by', pg_temp.sys()) || p_over $$;
CREATE FUNCTION pg_temp.rsn(n int, p_tenant uuid, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'code', 'RSN_' || n, 'name', 'Synthetic reason ' || n, 'display_order', n) || p_over $$;
CREATE FUNCTION pg_temp.slb(n int, p_tenant uuid, p_party int, p_from bigint, p_to bigint, p_dfrom date, p_dto date, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'party_kind', 'credit_party', 'party_id', pg_temp.uid(p_party), 'amount_from_paisa', p_from, 'amount_to_paisa', p_to,
    'discount_bp', 500, 'effective_from', p_dfrom, 'effective_to', p_dto)) || p_over $$;
CREATE FUNCTION pg_temp.lim(n int, p_tenant uuid, p_user int, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'user_id', pg_temp.uid(p_user), 'max_discount_bp', 500, 'max_discount_paisa', 100000) || p_over $$;

CREATE TEMP TABLE nt(t) AS VALUES ('discount_reason'),('party_discount_slab'),('user_discount_limit'),('discount_authority');
CREATE TEMP TABLE reasons(nm) AS VALUES ('Partner Family'),('Partners friend and relatives'),('Prescribed by Doctor'),('Employees and family'),('Employee relatives'),('Regular patient'),('Walking patient'),('Gold membership');

-- ===================================================================================================================================== shape of the four tables
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'billing'::regnamespace AND c.relname = n.t AND c.relkind = 'r'), 1, 'billing.' || n.t || ' exists') FROM nt n;
SELECT is((SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid = to_regclass('billing.' || n.t)), true, 'billing.' || n.t || ' ENABLE + FORCE row level security') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'billing' AND p.tablename = n.t AND p.roles <> ARRAY['lims_app']::name[]), 0, 'every policy on ' || n.t || ' is TO lims_app only') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = to_regclass('billing.' || n.t)
            AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) !~ 'tenant_id = '), 0, 'every ' || n.t || ' policy is tenant_id-scoped') FROM nt n;
SELECT is((SELECT array_agg(cmd ORDER BY cmd) FROM pg_policies WHERE schemaname = 'billing' AND tablename = n.t), ARRAY['INSERT','SELECT','UPDATE']::text[], n.t || ' has exactly the INSERT, SELECT, UPDATE policies') FROM nt n;
SELECT is(has_table_privilege('lims_app', to_regclass('billing.' || n.t), x.priv), x.want, 'lims_app ' || x.priv || ' on ' || n.t || ' = ' || x.want)
  FROM nt n CROSS JOIN (VALUES ('SELECT', true), ('INSERT', true), ('UPDATE', true), ('DELETE', false), ('TRUNCATE', false)) x(priv, want);
SELECT is(coalesce(has_table_privilege(r.role, to_regclass('billing.' || n.t), 'SELECT'), false), false, r.role || ' has no grant on ' || n.t)
  FROM nt n CROSS JOIN (VALUES ('anon'),('authenticated'),('lims_monitor')) r(role) WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role);
SELECT is((SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]), 'tenant_id', '§9 test 2: ' || c.relname || ' index ' || ic.relname || ' leads with tenant_id')
  FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid
 WHERE c.relnamespace = 'billing'::regnamespace AND c.relname IN (SELECT t FROM nt) AND NOT (i.indisprimary AND i.indnatts = 1 AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'id');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass('billing.' || n.t) AND k.contype = 'u' AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) = ARRAY['tenant_id','id']), n.t || ' has UNIQUE (tenant_id, id) next to PRIMARY KEY (id)') FROM nt n;
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass('billing.' || n.t) AND k.contype = 'f' AND k.confrelid = 'core.tenants'::regclass), n.t || ' references core.tenants') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = to_regclass('billing.' || n.t) AND a.attname IN ('id','tenant_id') AND a.atthasdef AND NOT a.attisdropped), 0, n.t || ': no DEFAULT on id / tenant_id (UUIDv7 in app code)') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = to_regclass('billing.' || n.t) AND a.attname IN ('id','tenant_id','created_at','updated_at','created_by') AND a.attnotnull AND NOT a.attisdropped), 5,
  n.t || ': id, tenant_id, created_at, updated_at, created_by are NOT NULL') FROM nt n;
SELECT is((SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = to_regclass('billing.' || m.t) AND a.attname = m.col AND NOT a.attisdropped), m.typ, m.t || '.' || m.col || ' is ' || m.typ)
  FROM (VALUES ('discount_reason','display_order','integer'),('discount_reason','is_active','boolean'),('party_discount_slab','amount_from_paisa','bigint'),('party_discount_slab','amount_to_paisa','bigint'),
               ('party_discount_slab','discount_bp','integer'),('party_discount_slab','effective_from','date'),('party_discount_slab','effective_to','date'),('party_discount_slab','party_id','uuid'),
               ('user_discount_limit','max_discount_bp','integer'),('user_discount_limit','max_discount_paisa','bigint'),('user_discount_limit','user_id','uuid'),
               ('discount_authority','max_discount_bp','integer'),('discount_authority','max_discount_paisa','bigint'),('discount_authority','user_id','uuid'),
               ('account_ledger_entries','held_reason','text'),('account_ledger_entries','held_by','uuid'),('account_ledger_entries','held_at','timestamp with time zone'),
               ('account_ledger_entries','released_by','uuid'),('account_ledger_entries','released_at','timestamp with time zone'),('account_ledger_entries','fiscal_year_label','text'),
               ('cash_sessions','previous_outstanding_cash_paisa','bigint'),('cash_sessions','deposit_paisa','bigint')) m(t, col, typ);
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'billing'::regnamespace AND c.relname IN (SELECT t FROM nt) AND a.attnum > 0 AND NOT a.attisdropped
            AND a.atttypid IN ('float4'::regtype, 'float8'::regtype, 'numeric'::regtype, 'money'::regtype)), 0, 'no float, numeric or money column in the new tables');
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'billing'::regnamespace AND c.relname IN (SELECT t FROM nt) AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname LIKE '%\_paisa' ESCAPE '\' AND format_type(a.atttypid, a.atttypmod) <> 'bigint'), 0, 'every *_paisa column is bigint (never float or numeric)');
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'billing'::regnamespace AND c.relname IN (SELECT t FROM nt) AND a.attnum > 0 AND NOT a.attisdropped
            AND a.attname LIKE '%\_bp' ESCAPE '\' AND format_type(a.atttypid, a.atttypmod) <> 'integer'), 0, 'every *_bp column is integer basis points');
SELECT is((SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = 'billing'::regnamespace AND t.typtype = 'e'), 0, 'no ENUM type in billing');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = to_regclass('billing.' || n.t) AND tgname = n.t || '__audit' AND NOT tgisinternal), 1, n.t || ' has its row audit trigger') FROM nt n;

-- ===================================================================================================================================== fixtures shared below
SELECT is(pg_temp.try('billing.account_groups', pg_temp.grp(1, pg_temp.ta())), 'ok', 'fixture: group A');
SELECT is(pg_temp.try('billing.account_groups', pg_temp.grp(5, pg_temp.tb())), 'ok', 'fixture: group B');
SELECT is(pg_temp.try('billing.account_particulars', pg_temp.par(30, pg_temp.ta(), 1)), 'ok', 'fixture: particular A');
SELECT is(pg_temp.try('billing.account_particulars', pg_temp.par(33, pg_temp.tb(), 5)), 'ok', 'fixture: particular B');

-- ===================================================================================================================================== seeded discount reasons (done_when 2)
SELECT is(pg_temp.a(format('SELECT billing.seed_discount_reasons(%L, %L)', pg_temp.ta(), pg_temp.sys()), 'n'), 'n=1', 'tenant A staff seeds its own reasons');
SELECT is((SELECT array_agg(name ORDER BY name) FROM billing.discount_reason WHERE tenant_id = pg_temp.ta() AND name IN (SELECT nm FROM reasons)), (SELECT array_agg(nm ORDER BY nm) FROM reasons),
  'all eight evidence reasons are seeded for tenant A (Partner Family ... Gold membership)');
SELECT is((SELECT count(*)::int FROM billing.discount_reason WHERE tenant_id = pg_temp.ta()), 8, 'exactly eight rows, no extra reason');
SELECT is((SELECT count(*)::int FROM billing.discount_reason WHERE tenant_id = pg_temp.ta() AND is_active AND code ~ '^[A-Z0-9_]{1,32}$'), 8, 'every seeded reason is active and has a well formed code');
SELECT is((SELECT count(DISTINCT display_order)::int FROM billing.discount_reason WHERE tenant_id = pg_temp.ta()), 8, 'seeded reasons have distinct display orders (the list order of the evidence)');
SELECT is((SELECT count(*)::int FROM billing.discount_reason WHERE tenant_id = pg_temp.ta() AND created_by = pg_temp.sys()), 8, 'the actor passed to the seed is the creator');
SELECT is(pg_temp.a(format('SELECT billing.seed_discount_reasons(%L, %L)', pg_temp.ta(), pg_temp.sys()), 'n'), 'n=1', 'seeding twice is allowed (idempotent)');
SELECT is((SELECT count(*)::int FROM billing.discount_reason WHERE tenant_id = pg_temp.ta()), 8, 'seeding twice adds nothing');
SELECT is((SELECT count(*)::int FROM billing.discount_reason WHERE tenant_id = pg_temp.tb()), 0, 'tenant B is not seeded by tenant A');
SELECT alike(pg_temp.a(format('SELECT billing.seed_discount_reasons(%L, %L)', pg_temp.tb(), pg_temp.sys()), 'n'), 'E%', 'tenant A staff cannot seed tenant B (row level security refuses the insert)');
SELECT is((SELECT count(*)::int FROM billing.discount_reason WHERE tenant_id = pg_temp.tb()), 0, 'still nothing in tenant B after the refused call');
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format('SELECT billing.seed_discount_reasons(%L, %L)', pg_temp.ta(), pg_temp.sys()), 'n'), 'E%', 'a ' || r.k || '-actor cannot seed reasons')
  FROM (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT is(pg_temp.b(format('SELECT billing.seed_discount_reasons(%L, %L)', pg_temp.tb(), pg_temp.sys()), 'n'), 'n=1', 'tenant B seeds its own');
SELECT is((SELECT count(*)::int FROM billing.discount_reason WHERE tenant_id = pg_temp.tb()), 8, 'tenant B has its own eight');

-- ===================================================================================================================================== discount reasons: values
SELECT is(pg_temp.try('billing.discount_reason', pg_temp.rsn(1001, pg_temp.ta())), 'ok', 'reason A1001 (the repo default of the optional columns)');
SELECT is((SELECT is_active FROM billing.discount_reason WHERE id = pg_temp.uid(1001)), true, 'a reason is active by default');
SELECT is((SELECT version FROM billing.discount_reason WHERE id = pg_temp.uid(1001)), 1, 'a reason starts at version 1');
SELECT is(pg_temp.try('billing.discount_reason', pg_temp.rsn(1002, pg_temp.ta(), '{"code":"RSN_1001"}')), '23505', 'same reason code in the same tenant -> unique_violation');
SELECT isnt(pg_temp.try('billing.discount_reason', pg_temp.rsn(1003, pg_temp.ta(), '{"code":"rsn_1001"}')), 'ok', 'code differing only by case collides (unique or format check)');
SELECT is(pg_temp.try('billing.discount_reason', pg_temp.rsn(1004, pg_temp.tb(), '{"code":"RSN_1001"}')), 'ok', 'the same code in another tenant is allowed');
SELECT isnt(pg_temp.try('billing.discount_reason', pg_temp.rsn(1010 + t.i, pg_temp.ta(), t.o)), 'ok', t.lbl)
  FROM (VALUES (1, '{"code":""}'::jsonb, 'empty code rejected'), (2, jsonb_build_object('code', repeat('C', 40)), 'oversize code rejected'), (3, '{"code":"BAD CODE;--"}'::jsonb, 'code with spaces and punctuation rejected'),
               (4, '{"name":""}'::jsonb, 'empty name rejected'), (5, jsonb_build_object('name', repeat('n', 1000)), 'oversize name rejected'), (6, '{"display_order":-1}'::jsonb, 'negative display_order rejected'),
               (7, '{"display_order":10000}'::jsonb, 'display_order above 9999 rejected'), (8, '{"name":null}'::jsonb, 'NULL name rejected')) t(i, o, lbl);
SELECT is(pg_temp.a('UPDATE billing.discount_reason SET name = ''Renamed'', display_order = 5, is_active = false, version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(1001))), 'n=1', 'lims_app renames, reorders and deactivates a reason');
SELECT alike(pg_temp.a('UPDATE billing.discount_reason SET code = ''CHANGED'' WHERE id = ' || quote_literal(pg_temp.uid(1001))), 'E%', 'the code of a reason is immutable (reports and approvals refer to it)');
SELECT alike(pg_temp.a('DELETE FROM billing.discount_reason WHERE id = ' || quote_literal(pg_temp.uid(1001))), 'E%', 'lims_app cannot DELETE a reason (deactivate, never delete)');

-- ===================================================================================================================================== party discount slabs
SELECT is(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2001, pg_temp.ta(), 910, 0, 100000, '2026-01-01', NULL)), 'ok', 'slab S1 party 910 [0,100000) from 2026-01-01 open ended');
SELECT is((SELECT is_active FROM billing.party_discount_slab WHERE id = pg_temp.uid(2001)), true, 'a slab is active by default');
SELECT is((SELECT effective_to FROM billing.party_discount_slab WHERE id = pg_temp.uid(2001)), NULL::date, 'effective_to is NULL (open ended) when not given');
SELECT is(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2002, pg_temp.ta(), 910, 100000, 500000, '2026-01-01', NULL)), 'ok', 'S2 [100000,500000): adjacent, the upper bound of S1 is excluded, so no overlap');
SELECT is(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2003, pg_temp.ta(), 910, 500000, 9007199254740991, '2026-01-01', NULL, '{"discount_bp":10000}')), 'ok', 'S3 [500000, int64 max): full range and 100 percent');
SELECT ok(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2010, pg_temp.ta(), 910, 50000, 150000, '2026-06-01', NULL)) IN ('23505','23P01'), 'amount overlap with S1 and S2 in an overlapping date range is refused (23P01 or 23505)');
SELECT ok(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2011, pg_temp.ta(), 910, 0, 100000, '2026-01-01', '2026-12-31')) IN ('23505','23P01'), 'the same range again is refused');
SELECT ok(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2012, pg_temp.ta(), 910, 99999, 100001, '2030-01-01', NULL)) IN ('23505','23P01'), 'a range overlapping by one paisa is refused (both open ended in time)');
SELECT is(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2013, pg_temp.ta(), 910, 0, 100000, '2025-01-01', '2025-12-31')), 'ok', 'same amount range in an earlier, disjoint date range is allowed');
SELECT ok(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2014, pg_temp.ta(), 910, 0, 100000, '2025-12-31', '2026-01-01')) IN ('23505','23P01'), 'dates are inclusive: a range ending on 2026-01-01 overlaps S1 starting on 2026-01-01');
SELECT is(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2015, pg_temp.ta(), 911, 0, 100000, '2026-01-01', NULL)), 'ok', 'the same ranges for another party are allowed');
SELECT is(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2016, pg_temp.ta(), 910, 0, 100000, '2026-01-01', NULL, '{"party_kind":"partner"}')), 'ok', 'the same party id under another party kind is another party');
SELECT is(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2017, pg_temp.tb(), 910, 0, 100000, '2026-01-01', NULL)), 'ok', 'the same party id and ranges in another tenant are allowed');
SELECT is(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2018, pg_temp.ta(), 910, 0, 100000, '2026-01-01', NULL, '{"is_active":false}')), 'ok', 'an INACTIVE slab may overlap an active one');
SELECT is(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2019, pg_temp.ta(), 912, 0, 1000, '2026-01-01', NULL, '{"party_kind":"doctor"}')), 'ok', 'doctor slab');
SELECT is(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2020, pg_temp.ta(), 913, 0, 1000, '2026-01-01', NULL, '{"party_kind":"franchise"}')), 'ok', 'franchise slab');
SELECT isnt(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2030 + t.i, pg_temp.ta(), 920 + t.i, t.f, t.tt, '2026-01-01', t.dt, t.o)), 'ok', t.lbl)
  FROM (VALUES (1, 100::bigint, 100::bigint, NULL::date, '{}'::jsonb, 'amount_to equal to amount_from rejected (empty range)'), (2, 100::bigint, 50::bigint, NULL::date, '{}'::jsonb, 'amount_to below amount_from rejected'),
               (3, -1::bigint, 50::bigint, NULL::date, '{}'::jsonb, 'negative amount_from rejected'), (4, 0::bigint, 100::bigint, NULL::date, '{"discount_bp":-1}'::jsonb, 'negative discount_bp rejected'),
               (5, 0::bigint, 100::bigint, NULL::date, '{"discount_bp":10001}'::jsonb, 'discount_bp above 10000 rejected'), (6, 0::bigint, 100::bigint, '2025-12-31'::date, '{}'::jsonb, 'effective_to before effective_from rejected'),
               (7, 0::bigint, 100::bigint, NULL::date, '{"party_kind":"patient"}'::jsonb, 'party_kind outside credit_party|partner|doctor|franchise rejected'),
               (8, 0::bigint, 100::bigint, NULL::date, '{"party_kind":"Credit_Party"}'::jsonb, 'party_kind is case sensitive'), (9, 0::bigint, 100::bigint, NULL::date, '{"discount_bp":null}'::jsonb, 'NULL discount_bp rejected'),
               (10, 0::bigint, 100::bigint, NULL::date, '{"effective_from":null}'::jsonb, 'NULL effective_from rejected')) t(i, f, tt, dt, o, lbl);
SELECT is(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2050, pg_temp.ta(), 930, 0, 100, '2026-01-01', '2026-01-01')), 'ok', 'a one day slab (effective_to = effective_from) is valid');
SELECT ok(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2051, pg_temp.ta(), 930, 0, 100, '2026-01-01', NULL, '{"discount_bp":0}')) IN ('23505','23P01'), 'a slab overlapping the one day slab is refused even with discount_bp 0 (0 is itself a valid percentage)');
-- changes after insert
SELECT alike(pg_temp.a('UPDATE billing.party_discount_slab SET party_id = ' || quote_literal(pg_temp.uid(999)) || ' WHERE id = ' || quote_literal(pg_temp.uid(2002))), 'E%', 'the party of a slab never changes');
SELECT alike(pg_temp.a('UPDATE billing.party_discount_slab SET party_kind = ''doctor'' WHERE id = ' || quote_literal(pg_temp.uid(2002))), 'E%', 'the party kind of a slab never changes');
SELECT alike(pg_temp.a('UPDATE billing.party_discount_slab SET amount_from_paisa = 50000, version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(2002))), 'E%', 'moving S2 so that it overlaps S1 is refused on UPDATE');
SELECT is((SELECT amount_from_paisa FROM billing.party_discount_slab WHERE id = pg_temp.uid(2002)), 100000::bigint, 'after the refused update S2 is unchanged');
SELECT alike(pg_temp.a('UPDATE billing.party_discount_slab SET is_active = true WHERE id = ' || quote_literal(pg_temp.uid(2018))), 'E%', 'reactivating an overlapping inactive slab is refused');
SELECT is(pg_temp.a('UPDATE billing.party_discount_slab SET discount_bp = 750, version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(2002))), 'n=1', 'lims_app changes the percentage of a slab (no range change)');
SELECT is(pg_temp.a('UPDATE billing.party_discount_slab SET is_active = false, version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(2001))), 'n=1', 'lims_app deactivates S1');
SELECT is(pg_temp.try('billing.party_discount_slab', pg_temp.slb(2060, pg_temp.ta(), 910, 0, 100000, '2026-01-01', NULL)), 'ok', 'after deactivating S1 the same range can be defined again');
SELECT alike(pg_temp.a('DELETE FROM billing.party_discount_slab WHERE id = ' || quote_literal(pg_temp.uid(2002))), 'E%', 'lims_app cannot DELETE a slab (deactivate, never delete)');

-- ===================================================================================================================================== per user discount limits and authorities
SELECT is(pg_temp.try('billing.user_discount_limit', pg_temp.lim(3001, pg_temp.ta(), 1100)), 'ok', 'limit for user 1100');
SELECT is((SELECT is_active FROM billing.user_discount_limit WHERE id = pg_temp.uid(3001)), true, 'a limit is active by default');
SELECT is(pg_temp.try('billing.user_discount_limit', pg_temp.lim(3002, pg_temp.ta(), 1100)), '23505', 'a second ACTIVE limit for the same user -> unique_violation (one active row per user)');
SELECT is(pg_temp.try('billing.user_discount_limit', pg_temp.lim(3003, pg_temp.ta(), 1100, '{"is_active":false}')), 'ok', 'inactive history rows for the same user are allowed');
SELECT is(pg_temp.try('billing.user_discount_limit', pg_temp.lim(3004, pg_temp.ta(), 1100, '{"is_active":false}')), 'ok', 'several inactive rows are allowed');
SELECT is(pg_temp.try('billing.user_discount_limit', pg_temp.lim(3005, pg_temp.tb(), 1100)), 'ok', 'the same user id in another tenant is another row');
SELECT is(pg_temp.try('billing.user_discount_limit', pg_temp.lim(3006, pg_temp.ta(), 1101, '{"max_discount_bp":0,"max_discount_paisa":0}')), 'ok', 'limit 0 and 0 is valid (no discount allowed)');
SELECT is(pg_temp.try('billing.user_discount_limit', pg_temp.lim(3007, pg_temp.ta(), 1102, '{"max_discount_bp":10000}')), 'ok', 'limit 10000 bp is valid');
SELECT isnt(pg_temp.try('billing.user_discount_limit', pg_temp.lim(3010 + t.i, pg_temp.ta(), 1110 + t.i, t.o)), 'ok', t.lbl)
  FROM (VALUES (1, '{"max_discount_bp":10001}'::jsonb, 'max_discount_bp above 10000 rejected'), (2, '{"max_discount_bp":-1}'::jsonb, 'negative max_discount_bp rejected'), (3, '{"max_discount_paisa":-1}'::jsonb, 'negative max_discount_paisa rejected'),
               (4, '{"max_discount_bp":null}'::jsonb, 'NULL max_discount_bp rejected'), (5, '{"max_discount_paisa":null}'::jsonb, 'NULL max_discount_paisa rejected'), (6, '{"user_id":null}'::jsonb, 'NULL user_id rejected')) t(i, o, lbl);
SELECT is(pg_temp.a('UPDATE billing.user_discount_limit SET is_active = false, version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(3001))), 'n=1', 'lims_app deactivates the limit');
SELECT is(pg_temp.try('billing.user_discount_limit', pg_temp.lim(3020, pg_temp.ta(), 1100, '{"max_discount_bp":900}')), 'ok', 'after that a new active limit for the user can be set');
SELECT alike(pg_temp.a('UPDATE billing.user_discount_limit SET user_id = ' || quote_literal(pg_temp.uid(1199)) || ' WHERE id = ' || quote_literal(pg_temp.uid(3020))), 'E%', 'the user of a limit never changes');
SELECT alike(pg_temp.a('DELETE FROM billing.user_discount_limit WHERE id = ' || quote_literal(pg_temp.uid(3020))), 'E%', 'lims_app cannot DELETE a limit');
SELECT is(pg_temp.try('billing.discount_authority', pg_temp.lim(4001, pg_temp.ta(), 1200, '{"max_discount_bp":2000,"max_discount_paisa":500000}')), 'ok', 'authority for user 1200');
SELECT is(pg_temp.try('billing.discount_authority', pg_temp.lim(4002, pg_temp.tb(), 1200)), 'ok', 'authority in tenant B');
SELECT isnt(pg_temp.try('billing.discount_authority', pg_temp.lim(4010 + t.i, pg_temp.ta(), 1210 + t.i, t.o)), 'ok', t.lbl)
  FROM (VALUES (1, '{"max_discount_bp":10001}'::jsonb, 'authority max_discount_bp above 10000 rejected'), (2, '{"max_discount_bp":-1}'::jsonb, 'negative authority bp rejected'),
               (3, '{"max_discount_paisa":-1}'::jsonb, 'negative authority paisa rejected'), (4, '{"user_id":null}'::jsonb, 'NULL authority user rejected')) t(i, o, lbl);
SELECT is(pg_temp.a('UPDATE billing.discount_authority SET is_active = false, version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(4001))), 'n=1', 'lims_app deactivates an authority');
SELECT alike(pg_temp.a('DELETE FROM billing.discount_authority WHERE id = ' || quote_literal(pg_temp.uid(4001))), 'E%', 'lims_app cannot DELETE an authority');

-- ===================================================================================================================================== ledger: held status, columns, fiscal year label (done_when 3)
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(5100, pg_temp.ta(), 30, '{"fiscal_year_label":"2083/84"}')), 'ok', 'submitted entry with fiscal_year_label 2083/84');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(5101, pg_temp.ta(), 30, '{"status":"approved"}')), 'ok', 'approved entry (no label: NULL stays valid for entries without a year)');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(5102, pg_temp.ta(), 30, '{"status":"rejected"}')), 'ok', 'rejected entry');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(5103, pg_temp.ta(), 30)), 'ok', 'submitted entry, control, never touched');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(5104, pg_temp.ta(), 30)), 'ok', 'submitted entry for the refused transitions');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(5105, pg_temp.ta(), 30, jsonb_build_object('status', 'held', 'held_reason', 'Cheque not cleared', 'held_by', pg_temp.uid(1500), 'held_at', now()))), 'ok', 'an entry inserted already held, with its reason, holder and time');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(5106, pg_temp.ta(), 30)), 'ok', 'submitted entry for the cross tenant attempt');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(5110, pg_temp.tb(), 33)), 'ok', 'fixture: ledger entry B');
SELECT is((SELECT held_reason IS NULL AND held_by IS NULL AND held_at IS NULL AND released_by IS NULL AND released_at IS NULL FROM billing.account_ledger_entries WHERE id = pg_temp.uid(5103)), true, 'a normal entry has no hold columns');
SELECT is((SELECT fiscal_year_label FROM billing.account_ledger_entries WHERE id = pg_temp.uid(5100)), '2083/84', 'the fiscal year label is stored as given');
SELECT isnt(pg_temp.try('billing.account_ledger_entries', pg_temp.led(5120 + t.i, pg_temp.ta(), 30, t.o)), 'ok', t.lbl)
  FROM (VALUES (1, '{"fiscal_year_label":"2083-84"}'::jsonb, 'label with a dash rejected'), (2, '{"fiscal_year_label":"83/84"}'::jsonb, 'two digit first year rejected'), (3, '{"fiscal_year_label":"2083/8"}'::jsonb, 'one digit second year rejected'),
               (4, '{"fiscal_year_label":"2083/844"}'::jsonb, 'three digit second year rejected'), (5, '{"fiscal_year_label":"abcd/ef"}'::jsonb, 'letters rejected'), (6, '{"fiscal_year_label":""}'::jsonb, 'empty label rejected'),
               (7, '{"status":"held"}'::jsonb, 'status held without reason, holder and time rejected'),
               (8, jsonb_build_object('status', 'held', 'held_reason', '', 'held_by', pg_temp.uid(1500), 'held_at', now()), 'status held with an empty reason rejected'),
               (9, jsonb_build_object('status', 'held', 'held_reason', repeat('r', 501), 'held_by', pg_temp.uid(1500), 'held_at', now()), 'a hold reason above 500 characters rejected'),
               (10, jsonb_build_object('status', 'held', 'held_reason', 'x', 'held_by', pg_temp.uid(1500), 'held_at', now(), 'released_by', pg_temp.uid(1501), 'released_at', now()), 'status held with released_* set rejected'),
               (11, '{"status":"posted"}'::jsonb, 'status outside the five rejected')) t(i, o, lbl);
-- privileges: the ledger stays append only except the narrow hold / release columns
SELECT is(has_table_privilege('lims_app', 'billing.account_ledger_entries', 'UPDATE'), false, 'lims_app has no table level UPDATE on the ledger');
SELECT is(has_table_privilege('lims_app', 'billing.account_ledger_entries', 'DELETE'), false, 'lims_app has no DELETE on the ledger');
SELECT is(has_column_privilege('lims_app', 'billing.account_ledger_entries', c.col, 'UPDATE'), c.want, 'lims_app UPDATE on ledger column ' || c.col || ' = ' || c.want)
  FROM (VALUES ('status', true), ('held_reason', true), ('held_by', true), ('held_at', true), ('released_by', true), ('released_at', true), ('last_modified_by', true), ('updated_at', true),
               ('amount_paisa', false), ('party_kind', false), ('party_id', false), ('account_particular_id', false), ('entry_date', false), ('entry_type', false), ('payment_mode', false), ('comments', false),
               ('reference_no', false), ('payment_details', false), ('receipt_no', false), ('receipt_seq', false), ('reverses_entry_id', false), ('fiscal_year_label', false), ('centre_id', false),
               ('tenant_id', false), ('created_by', false), ('created_at', false), ('id', false)) c(col, want);
SELECT ok((SELECT array_agg(cmd ORDER BY cmd) FROM pg_policies WHERE schemaname = 'billing' AND tablename = 'account_ledger_entries') @> ARRAY['INSERT','SELECT','UPDATE']::text[]
          AND NOT ((SELECT array_agg(cmd) FROM pg_policies WHERE schemaname = 'billing' AND tablename = 'account_ledger_entries') && ARRAY['DELETE','ALL']::text[]), 'the ledger has INSERT, SELECT and UPDATE policies and no DELETE / ALL policy');
SELECT is((SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = 'billing.account_ledger_entries'::regclass AND p.polcmd = 'w' AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) !~ 'tenant_id = '), 0,
  'the ledger UPDATE policy is tenant scoped');
-- hold (lims_app: column grant + policy + guard trigger)
SELECT is(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''held'', held_reason = %L, held_by = %L, held_at = now(), last_modified_by = %L, updated_at = now() WHERE id = %L',
  'Cheque not cleared', pg_temp.uid(1500), pg_temp.uid(1500), pg_temp.uid(5100))), 'n=1', 'lims_app HOLDS a submitted entry (submitted -> held)');
SELECT is((SELECT status || '|' || held_reason FROM billing.account_ledger_entries WHERE id = pg_temp.uid(5100)), 'held|Cheque not cleared', 'the entry is held with its reason');
SELECT is((SELECT amount_paisa::text || '|' || party_kind || '|' || entry_type || '|' || entry_date::text || '|' || fiscal_year_label FROM billing.account_ledger_entries WHERE id = pg_temp.uid(5100)), '150000|credit_party|credit|2026-11-17|2083/84', 'holding changed no money, party, type, date or label');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''held'', held_reason = %L, held_by = %L, held_at = now() WHERE id = %L', 'again', pg_temp.uid(1500), pg_temp.uid(5100))), 'E%', 'holding a held entry again is refused (held -> held is no transition)');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''approved'' WHERE id = %L', pg_temp.uid(5100))), 'E%', 'held -> approved is refused (release goes back to submitted)');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''rejected'' WHERE id = %L', pg_temp.uid(5100))), 'E%', 'held -> rejected is refused');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''reversed'' WHERE id = %L', pg_temp.uid(5100))), 'E%', 'held -> reversed is refused (reversal is a new row)');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET amount_paisa = 1 WHERE id = %L', pg_temp.uid(5100))), 'E%', 'a held entry keeps its amount: UPDATE refused');
SELECT is(pg_temp.upd(format('UPDATE billing.account_ledger_entries SET amount_paisa = 1 WHERE id = %L', pg_temp.uid(5100))) <> 'ok', true, 'even the owner session cannot change the amount of a held entry (trigger)');
-- release
SELECT is(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''submitted'', released_by = %L, released_at = now(), last_modified_by = %L, updated_at = now() WHERE id = %L',
  pg_temp.uid(1501), pg_temp.uid(1501), pg_temp.uid(5100))), 'n=1', 'lims_app RELEASES the held entry (held -> submitted)');
SELECT is((SELECT status || '|' || held_reason || '|' || (released_by IS NOT NULL AND released_at IS NOT NULL)::text FROM billing.account_ledger_entries WHERE id = pg_temp.uid(5100)), 'submitted|Cheque not cleared|true', 'released: back to submitted, the hold reason stays as history, released_by / released_at are set');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''submitted'', released_by = %L, released_at = now() WHERE id = %L', pg_temp.uid(1501), pg_temp.uid(5100))), 'E%', 'releasing an entry that is not held is refused (submitted -> submitted with release columns)');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET released_by = %L, released_at = now() WHERE id = %L', pg_temp.uid(1502), pg_temp.uid(5100))), 'E%', 'the release columns of a released entry cannot be rewritten');
SELECT is(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''held'', held_reason = %L, held_by = %L, held_at = now(), released_by = NULL, released_at = NULL, last_modified_by = %L, updated_at = now() WHERE id = %L',
  'Second review', pg_temp.uid(1500), pg_temp.uid(1500), pg_temp.uid(5100))), 'n=1', 'a released entry can be held again (new reason, release columns cleared)');
SELECT is((SELECT status || '|' || held_reason || '|' || (released_by IS NULL AND released_at IS NULL)::text FROM billing.account_ledger_entries WHERE id = pg_temp.uid(5100)), 'held|Second review|true', 'second hold recorded, release columns cleared');
-- the already held fixture entry
SELECT is(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''submitted'', released_by = %L, released_at = now() WHERE id = %L', pg_temp.uid(1501), pg_temp.uid(5105))), 'n=1', 'a held entry inserted as held can be released');
-- refused transitions on the other statuses
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''held'', held_reason = ''x'', held_by = %L, held_at = now() WHERE id = %L', pg_temp.uid(1500), pg_temp.uid(5101))), 'E%', 'an approved entry cannot be held (a correction is a reversal)');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''held'', held_reason = ''x'', held_by = %L, held_at = now() WHERE id = %L', pg_temp.uid(1500), pg_temp.uid(5102))), 'E%', 'a rejected entry cannot be held');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''approved'' WHERE id = %L', pg_temp.uid(5104))), 'E%', 'submitted -> approved is not a transition (status is set at insert)');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''rejected'' WHERE id = %L', pg_temp.uid(5104))), 'E%', 'submitted -> rejected is not a transition');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''reversed'' WHERE id = %L', pg_temp.uid(5104))), 'E%', 'submitted -> reversed is not a transition (reversed is derived from the reversal row)');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''submitted'' WHERE id = %L', pg_temp.uid(5101))), 'E%', 'approved -> submitted is refused');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''held'' WHERE id = %L', pg_temp.uid(5104))), 'E%', 'hold without reason, holder and time is refused');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''held'', held_reason = '''', held_by = %L, held_at = now() WHERE id = %L', pg_temp.uid(1500), pg_temp.uid(5104))), 'E%', 'hold with an empty reason is refused');
SELECT alike(pg_temp.a(format('UPDATE billing.account_ledger_entries SET status = ''held'', held_reason = ''x'', held_by = %L, held_at = now(), amount_paisa = 7 WHERE id = %L', pg_temp.uid(1500), pg_temp.uid(5104))), 'E%', 'a hold that also changes the amount is refused as a whole');
SELECT is((SELECT status || '|' || amount_paisa FROM billing.account_ledger_entries WHERE id = pg_temp.uid(5104)), 'submitted|150000', 'after the refused attempts the entry is untouched');
SELECT is(pg_temp.upd(format('UPDATE billing.account_ledger_entries SET %I = %s WHERE id = %L', c.col, c.val, pg_temp.uid(5103))) <> 'ok', true, 'immutable even for the owner session: ' || c.col)
  FROM (VALUES ('amount_paisa', '1'), ('party_id', quote_literal(pg_temp.uid(998))), ('party_kind', '''franchise'''), ('entry_type', '''debit'''), ('entry_date', '''2026-01-01'''),
               ('account_particular_id', quote_literal(pg_temp.uid(30))), ('payment_mode', '''online'''), ('comments', '''edited'''), ('receipt_no', '''X'''), ('receipt_seq', '99999'),
               ('fiscal_year_label', '''2084/85'''), ('centre_id', quote_literal(pg_temp.id('00000000a202'))), ('created_by', quote_literal(pg_temp.uid(1)))) c(col, val);
SELECT is((SELECT amount_paisa::text || party_kind || entry_type || entry_date::text || receipt_no FROM billing.account_ledger_entries WHERE id = pg_temp.uid(5103)), '150000credit_partycredit2026-11-17SYN-FIN-5103', 'after every refused edit the control entry is intact');
SELECT is(pg_temp.upd(format('UPDATE billing.account_ledger_entries SET updated_at = now() WHERE id = %L', pg_temp.uid(5103))), 'ok', 'touching updated_at alone is allowed');
-- isolation of the new UPDATE policy
SELECT is(pg_temp.b(format('UPDATE billing.account_ledger_entries SET status = ''held'', held_reason = ''x'', held_by = %L, held_at = now() WHERE id = %L', pg_temp.uid(1500), pg_temp.uid(5106))), 'n=0', 'tenant B cannot hold a tenant A entry (0 rows)');
SELECT is((SELECT status FROM billing.account_ledger_entries WHERE id = pg_temp.uid(5106)), 'submitted', 'the tenant A entry is still submitted');
SELECT ok(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format('UPDATE billing.account_ledger_entries SET status = ''held'', held_reason = ''x'', held_by = %L, held_at = now() WHERE id = %L', pg_temp.uid(1500), pg_temp.uid(5106)), 'w') ~ '^(n=0|E)',
  'a ' || r.k || '-actor cannot hold an entry') FROM (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT is((SELECT status FROM billing.account_ledger_entries WHERE id = pg_temp.uid(5106)), 'submitted', 'still submitted after the actor-type attempts');
SELECT alike(pg_temp.a('DELETE FROM billing.account_ledger_entries WHERE id = ' || quote_literal(pg_temp.uid(5103))), 'E%', 'lims_app still cannot DELETE a ledger entry');
-- a reversal row of a held entry still obeys the reversal rules (guard unchanged)
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(5130, pg_temp.ta(), 30, jsonb_build_object('entry_type', 'debit', 'reverses_entry_id', pg_temp.uid(5100)))), 'ok', 'a reversal row of a held entry is a normal new row (opposite type, same amount)');
SELECT isnt(pg_temp.try('billing.account_ledger_entries', pg_temp.led(5131, pg_temp.ta(), 30, jsonb_build_object('entry_type', 'debit', 'amount_paisa', 5, 'reverses_entry_id', pg_temp.uid(5103)))), 'ok', 'a mismatching reversal is still refused (reversal_mismatch)');

-- ===================================================================================================================================== cash: carried forward cash and deposit (done_when 4)
SELECT is(pg_temp.try('billing.cash_sessions', jsonb_build_object('id', pg_temp.uid(7000), 'tenant_id', pg_temp.ta(), 'branch_id', pg_temp.branch(pg_temp.ta()), 'centre_id', pg_temp.centre(pg_temp.ta()),
  'membership_id', pg_temp.mem(pg_temp.ta()), 'opened_at', now())), 'ok', 'open cash session (the new columns take their defaults)');
SELECT is((SELECT previous_outstanding_cash_paisa || '|' || deposit_paisa FROM billing.cash_sessions WHERE id = pg_temp.uid(7000)), '0|0', 'both new columns default to 0 (NOT NULL)');
SELECT is((SELECT count(*)::int FROM pg_attribute WHERE attrelid = 'billing.cash_sessions'::regclass AND attname IN ('previous_outstanding_cash_paisa','deposit_paisa') AND attnotnull AND atthasdef AND NOT attisdropped), 2, 'both columns are NOT NULL with a default');
SELECT is(pg_temp.try('billing.cash_sessions', jsonb_build_object('id', pg_temp.uid(7001), 'tenant_id', pg_temp.ta(), 'branch_id', pg_temp.branch(pg_temp.ta()), 'centre_id', pg_temp.centre(pg_temp.ta()),
  'membership_id', pg_temp.mem(pg_temp.ta()), 'opened_at', now(), 'status', 'closed', 'closed_at', now(), 'counted', '[]'::jsonb, 'expected', '[]'::jsonb,
  'previous_outstanding_cash_paisa', 500000, 'deposit_paisa', 300000)), 'ok', 'a closed session with carried forward 5000.00 and deposit 3000.00 (paisa)');
SELECT isnt(pg_temp.try('billing.cash_sessions', jsonb_build_object('id', pg_temp.uid(7002 + t.i), 'tenant_id', pg_temp.ta(), 'branch_id', pg_temp.branch(pg_temp.ta()), 'centre_id', pg_temp.centre(pg_temp.ta()),
  'membership_id', pg_temp.mem(pg_temp.ta()), 'opened_at', now(), 'status', 'closed', 'closed_at', now(), 'counted', '[]'::jsonb, 'expected', '[]'::jsonb) || t.o), 'ok', t.lbl)
  FROM (VALUES (1, '{"previous_outstanding_cash_paisa":-1}'::jsonb, 'negative previous_outstanding_cash_paisa rejected'), (2, '{"deposit_paisa":-1}'::jsonb, 'negative deposit_paisa rejected'),
               (3, '{"previous_outstanding_cash_paisa":null}'::jsonb, 'NULL previous_outstanding_cash_paisa rejected'), (4, '{"deposit_paisa":null}'::jsonb, 'NULL deposit_paisa rejected')) t(i, o, lbl);
SELECT is(pg_temp.upd(format('UPDATE billing.cash_sessions SET deposit_paisa = 250000, updated_at = now() WHERE id = %L', pg_temp.uid(7000))), 'ok', 'the cashier records the deposit on an open session (deposit_paisa is a mutable column)');
SELECT is((SELECT deposit_paisa FROM billing.cash_sessions WHERE id = pg_temp.uid(7000)), 250000::bigint, 'deposit stored');
SELECT is(pg_temp.upd(format('UPDATE billing.cash_sessions SET deposit_paisa = 260000, updated_at = now() WHERE id = %L', pg_temp.uid(7001))), 'ok', 'the deposit stays editable after the session is closed');
SELECT isnt(pg_temp.upd(format('UPDATE billing.cash_sessions SET previous_outstanding_cash_paisa = 1 WHERE id = %L', pg_temp.uid(7000))), 'ok', 'previous_outstanding_cash_paisa is set at insert only (immutable afterwards)');
SELECT isnt(pg_temp.upd(format('UPDATE billing.cash_sessions SET deposit_paisa = -5 WHERE id = %L', pg_temp.uid(7000))), 'ok', 'a negative deposit is refused on UPDATE');
SELECT is((SELECT previous_outstanding_cash_paisa FROM billing.cash_sessions WHERE id = pg_temp.uid(7000)), 0::bigint, 'previous_outstanding_cash_paisa is intact after the refused update');
SELECT is(pg_temp.upd(format('UPDATE billing.cash_sessions SET status = ''closed'', closed_at = now(), counted = ''[]''::jsonb, expected = ''[]''::jsonb WHERE id = %L', pg_temp.uid(7000))), 'ok', 'the old lifecycle still works: open -> closed');
SELECT isnt(pg_temp.upd(format('UPDATE billing.cash_sessions SET status = ''open'', closed_at = NULL WHERE id = %L', pg_temp.uid(7000))), 'ok', 'the old lifecycle still refuses closed -> open');
SELECT is(has_table_privilege('lims_app', 'billing.cash_sessions', 'DELETE'), false, 'lims_app still cannot DELETE a cash session');

-- ===================================================================================================================================== isolation: tenant A / B probes on every new table
CREATE TEMP TABLE probe(t, own_a, own_b) AS VALUES ('discount_reason', pg_temp.uid(1001), pg_temp.uid(1004)), ('party_discount_slab', pg_temp.uid(2002), pg_temp.uid(2017)), ('user_discount_limit', pg_temp.uid(3020), pg_temp.uid(3005)),
  ('discount_authority', pg_temp.uid(4001), pg_temp.uid(4002));
SELECT is(pg_temp.a('SELECT 1 FROM billing.' || p.t || ' WHERE id = ' || quote_literal(p.own_a), 'n'), 'n=1', 'control: tenant A staff reads its own ' || p.t || ' row') FROM probe p;
SELECT is(pg_temp.b('SELECT 1 FROM billing.' || p.t || ' WHERE id = ' || quote_literal(p.own_b), 'n'), 'n=1', 'control: tenant B staff reads its own ' || p.t || ' row') FROM probe p;
SELECT is(pg_temp.a('SELECT 1 FROM billing.' || p.t || ' WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 'n'), 'n=0', 'tenant A sees 0 tenant B rows in ' || p.t) FROM probe p;
SELECT is(pg_temp.b('SELECT 1 FROM billing.' || p.t || ' WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'tenant B sees 0 tenant A rows in ' || p.t) FROM probe p;
SELECT is(pg_temp.a('UPDATE billing.' || p.t || ' SET version = version + 1 WHERE tenant_id = ' || quote_literal(pg_temp.tb())), 'n=0', 'tenant A updates 0 tenant B rows in ' || p.t) FROM probe p;
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), 'SELECT 1 FROM billing.' || p.t, 'n'), 'n=0', 'a ' || r.k || '-actor sees 0 rows of ' || p.t) FROM probe p CROSS JOIN (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT alike(pg_temp.a(format($$ INSERT INTO billing.discount_reason (id, tenant_id, code, name, display_order, created_by) VALUES (%L, %L, 'HIJACK', 'x', 1, %L) $$, pg_temp.uid(8001), pg_temp.tb(), pg_temp.sys())), 'E42501|%', 'tenant A cannot insert a reason for tenant B');
SELECT alike(pg_temp.a(format($$ INSERT INTO billing.user_discount_limit (id, tenant_id, user_id, max_discount_bp, max_discount_paisa, created_by) VALUES (%L, %L, %L, 1, 1, %L) $$, pg_temp.uid(8002), pg_temp.tb(), pg_temp.uid(5), pg_temp.sys())), 'E42501|%', 'tenant A cannot insert a limit for tenant B');
SELECT alike(pg_temp.a(format($$ INSERT INTO billing.discount_authority (id, tenant_id, user_id, max_discount_bp, max_discount_paisa, created_by) VALUES (%L, %L, %L, 1, 1, %L) $$, pg_temp.uid(8003), pg_temp.tb(), pg_temp.uid(5), pg_temp.sys())), 'E42501|%', 'tenant A cannot insert an authority for tenant B');
SELECT alike(pg_temp.a(format($$ INSERT INTO billing.party_discount_slab (id, tenant_id, party_kind, party_id, amount_from_paisa, amount_to_paisa, discount_bp, effective_from, created_by) VALUES (%L, %L, 'credit_party', %L, 0, 1, 1, '2026-01-01', %L) $$,
  pg_temp.uid(8004), pg_temp.tb(), pg_temp.uid(5), pg_temp.sys())), 'E42501|%', 'tenant A cannot insert a slab for tenant B');
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ INSERT INTO billing.discount_reason (id, tenant_id, code, name, display_order, created_by) VALUES (%L, %L, 'PORTALX', 'x', 1, %L) $$, pg_temp.uid(8010), pg_temp.ta(), pg_temp.sys()), 'w'), 'E42501|%',
  'a ' || r.k || '-actor cannot insert a reason') FROM (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ INSERT INTO billing.user_discount_limit (id, tenant_id, user_id, max_discount_bp, max_discount_paisa, created_by) VALUES (%L, %L, %L, 1, 1, %L) $$, pg_temp.uid(8011), pg_temp.ta(), pg_temp.uid(5), pg_temp.sys()), 'w'), 'E42501|%',
  'a ' || r.k || '-actor cannot insert a limit') FROM (VALUES ('patient'),('partner'),('portal')) r(k);

-- ===================================================================================================================================== audit
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'billing' AND table_name = x.t AND row_id = x.rid AND action = 'INSERT'), 1, 'control: INSERT into ' || x.t || ' is audited')
  FROM (VALUES ('discount_reason', pg_temp.uid(1001)), ('party_discount_slab', pg_temp.uid(2002)), ('user_discount_limit', pg_temp.uid(3020)), ('discount_authority', pg_temp.uid(4001))) x(t, rid);
SELECT ok(EXISTS (SELECT 1 FROM audit.audit_log WHERE schema_name = 'billing' AND table_name = 'party_discount_slab' AND row_id = pg_temp.uid(2002) AND action = 'UPDATE' AND 'discount_bp' = ANY (changed_columns)),
  'a slab percentage change is recorded as changed (who changed a discount is answerable)');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = to_regclass('billing.account_ledger_entries') AND NOT tgisinternal AND pg_get_triggerdef(oid) ~ 'tg_row_audit'
            AND pg_get_triggerdef(oid) !~ '''payment_details'''), 0, 'an audit trigger on the ledger, if present, still excludes payment_details (free text, may hold personal data)');

-- ===================================================================================================================================== idempotent re-apply: second run changes nothing
CREATE FUNCTION pg_temp.colcount() RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relnamespace = 'billing'::regnamespace AND c.relkind = 'r' $$;
CREATE TEMP TABLE before_state AS
  SELECT pg_temp.colcount() AS cols,
         (SELECT count(*) FROM pg_class WHERE relnamespace = 'billing'::regnamespace AND relkind = 'r') AS tbls,
         (SELECT count(*) FROM pg_constraint WHERE conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'billing'::regnamespace)) AS cons,
         (SELECT count(*) FROM pg_index WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'billing'::regnamespace)) AS idxs,
         (SELECT count(*) FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'billing'::regnamespace)) AS pols,
         (SELECT string_agg(pg_get_triggerdef(oid), '|' ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'billing'::regnamespace) AND NOT tgisinternal) AS trg,
         (SELECT count(*) FROM billing.discount_reason) AS n_rsn, (SELECT count(*) FROM billing.party_discount_slab) AS n_slab, (SELECT count(*) FROM billing.account_ledger_entries) AS n_led,
         (SELECT count(*) FROM billing.cash_sessions) AS n_cash;
\ir ../../migrations/20261117190000_billing__add_finance_controls.sql
RESET ROLE;
SELECT is((SELECT count(*) FROM pg_class WHERE relnamespace = 'billing'::regnamespace AND relkind = 'r'), (SELECT tbls FROM before_state), 're-apply: table count unchanged');
SELECT is(pg_temp.colcount(), (SELECT cols FROM before_state), 're-apply: column count unchanged');
SELECT is((SELECT count(*) FROM pg_constraint WHERE conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'billing'::regnamespace)), (SELECT cons FROM before_state), 're-apply: constraint count unchanged');
SELECT is((SELECT count(*) FROM pg_index WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'billing'::regnamespace)), (SELECT idxs FROM before_state), 're-apply: index count unchanged');
SELECT is((SELECT count(*) FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'billing'::regnamespace)), (SELECT pols FROM before_state), 're-apply: policy count unchanged');
SELECT is((SELECT string_agg(pg_get_triggerdef(oid), '|' ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'billing'::regnamespace) AND NOT tgisinternal),
  (SELECT trg FROM before_state), 're-apply: triggers unchanged');
SELECT is((SELECT count(*) FROM billing.discount_reason), (SELECT n_rsn FROM before_state), 're-apply: no reason row added or removed (the migration seeds nothing)');
SELECT is((SELECT count(*) FROM billing.party_discount_slab), (SELECT n_slab FROM before_state), 're-apply: no slab row added or removed');
SELECT is((SELECT count(*) FROM billing.account_ledger_entries), (SELECT n_led FROM before_state), 're-apply: no ledger row added or removed');
SELECT is((SELECT count(*) FROM billing.cash_sessions), (SELECT n_cash FROM before_state), 're-apply: no cash session row added or removed');
SELECT is((SELECT status || '|' || held_reason FROM billing.account_ledger_entries WHERE id = pg_temp.uid(5100)), 'held|Second review', 're-apply: no data rewrite (a held entry stays held)');
SELECT is((SELECT amount_paisa FROM billing.account_ledger_entries WHERE id = pg_temp.uid(5103)), 150000::bigint, 're-apply: no data rewrite (ledger amount intact)');
SELECT is((SELECT deposit_paisa FROM billing.cash_sessions WHERE id = pg_temp.uid(7000)), 250000::bigint, 're-apply: no data rewrite (deposit intact)');
SELECT is(has_table_privilege('lims_app', 'billing.account_ledger_entries', 'UPDATE') OR has_table_privilege('lims_app', 'billing.account_ledger_entries', 'DELETE'), false, 're-apply keeps the ledger without table level UPDATE or DELETE');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'billing.account_ledger_entries'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege('lims_app', a.attrelid, a.attname, 'UPDATE')), 8,
  're-apply keeps exactly eight updatable ledger columns (status, last_modified_by, updated_at, held_*, released_*)');
SELECT is(has_table_privilege('lims_app', 'billing.ledger_entries', 'UPDATE') OR has_table_privilege('lims_app', 'billing.ledger_entries', 'DELETE'), false, 're-apply keeps the old payment ledger append only');

SELECT * FROM finish();
ROLLBACK;
