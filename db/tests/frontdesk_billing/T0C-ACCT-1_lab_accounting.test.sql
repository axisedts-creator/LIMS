-- T0C-ACCT-1 pgTAP suite (LD-313; founder blanket authority LD-310; request 2026-11-17 04:57 NPT: "do not leave any function") for migration
-- 20261117120000_billing__add_lab_accounting.sql: six new tenant tables in schema billing:
--   account_groups, account_particulars, expense_types, account_ledger_entries (append only), expenses, cash_transfers.
-- Covers: shape + CHECKs, uniqueness per tenant, composite tenant FKs, ENABLE + FORCE RLS by tenant, grants, isolation probes (A/B, patient / partner / portal actors),
-- ledger append-only (no UPDATE / DELETE for lims_app, reversal rules, receipt numbers per tenant), cash transfer lifecycle, audit, idempotent re-apply.
-- Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written by the superuser test session with system claims (audit context),
-- every isolation assertion runs as SET LOCAL ROLE lims_app. Seeds supply tenant A/B (a001/b001), centres a201/b201, memberships a500/b500.
-- Run: bash db/tests/run-suites.sh db/tests/frontdesk_billing/T0C-ACCT-1_lab_accounting.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (brief gives fields, not column or constraint names; a different choice needs a ruling, not a silent test edit):
--  - NAME COLLISION: billing.ledger_entries (invoice payments, C4) already exists, so the accounting ledger is billing.account_ledger_entries.
--  - Columns pinned (see the fixture builders below): every table has id, tenant_id, created_at, updated_at, created_by; masters + expenses + transfers also have version and (masters) is_active.
--    account_groups(code, name, nature); account_particulars(account_group_id, code, name); expense_types(name, account_particular_id);
--    account_ledger_entries(centre_id, party_kind, party_id, entry_date, account_particular_id, entry_type, amount_paisa, payment_mode, bank_name, reference_no, payment_details, comments,
--      status, reverses_entry_id, receipt_no text, receipt_seq bigint, last_modified_by); expenses(centre_id, expense_at, expense_type_id, amount_paisa, description, ledger_entry_id, cancelled_at);
--    cash_transfers(from_kind, from_id, to_kind, to_id, amount_paisa, status, remark, decided_by, decided_at).
--  - decided_by, last_modified_by, created_by are plain uuids (no FK). Money: bigint paisa, > 0. party_id / from_id / to_id are polymorphic plain uuids (no FK). Texts are 1..N chars (NULL is the only "none"). Codes are upper case [A-Z0-9_], unique per tenant.
--  - account_ledger_entries: lims_app has SELECT, INSERT only (no table level UPDATE, no DELETE; a narrow column grant on status is tolerated only if no other column can change). status defaults to
--    'submitted'. A reversal is a NEW row: reverses_entry_id set, entry_type opposite, same amount / centre / party / particular; one reversal per entry; a reversal cannot be reversed.
--    reference_no and payment_details never hold a 13..19 digit run (card number, REQ-SEC-056 style). receipt_no unique per tenant, receipt_seq > 0 unique per tenant, no sequence objects.
--  - expenses: amount, type, centre immutable after insert (correction = cancel + new row); cancelled_at set once, never cleared. cash_transfers: from != to; non pending rows carry decided_by + decided_at;
--    accepted | rejected need decided_by <> created_by (separation of duties); only pending rows change status; terminal rows and amount / from / to are immutable.
--  - Not tested here (service, T0B-ACCT-*): statement running balances, summary, daily collection, the balanced pair posted on accept, the per tenant receipt counter itself.
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
CREATE FUNCTION pg_temp.grp(n int, p_tenant uuid, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'code', 'GRP_' || n, 'name', 'Synthetic group ' || n, 'nature', 'income') || p_over $$;
CREATE FUNCTION pg_temp.par(n int, p_tenant uuid, p_group int, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'account_group_id', pg_temp.uid(p_group), 'code', 'PAR_' || n, 'name', 'Synthetic particular ' || n) || p_over $$;
CREATE FUNCTION pg_temp.led(n int, p_tenant uuid, p_par int, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'centre_id', pg_temp.centre(p_tenant), 'party_kind', 'credit_party', 'party_id', pg_temp.uid(900),
    'entry_date', '2026-11-17', 'account_particular_id', pg_temp.uid(p_par), 'entry_type', 'credit', 'amount_paisa', 150000, 'payment_mode', 'cash',
    'receipt_no', 'SYN-ACC-' || n, 'receipt_seq', n, 'last_modified_by', pg_temp.sys()) || p_over $$;

CREATE TEMP TABLE nt(t) AS VALUES ('account_groups'),('account_particulars'),('expense_types'),('account_ledger_entries'),('expenses'),('cash_transfers');
-- the billing tables that existed before this task (20261105001700_billing__create_billing_schema.sql): anything else in schema billing is new and must be RLS protected
CREATE TEMP TABLE oldt(t) AS VALUES ('settings'),('fiscal_counters'),('invoices'),('invoice_lines'),('credit_notes'),('credit_note_lines'),('cash_sessions'),('ledger_entries'),('order_balances'),
  ('release_overrides'),('credit_accounts'),('credit_charges'),('credit_note_tasks'),('finance_review_items'),('refund_requests'),('payment_intent_refs'),('print_log'),('activity_log'),
  ('cbms_submissions'),('export_jobs'),('g_cs_payment_methods'),('cs_payment_methods'),('g_cs_reasons'),('cs_reasons'),('event_inbox');

-- ===================================================================================================================================== shape of the six tables
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'billing'::regnamespace AND c.relname = n.t AND c.relkind = 'r'), 1, 'billing.' || n.t || ' exists') FROM nt n;
SELECT is((SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid = to_regclass('billing.' || n.t)), true, 'billing.' || n.t || ' ENABLE + FORCE row level security') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'billing'::regnamespace AND c.relkind = 'r' AND c.relname NOT IN (SELECT t FROM oldt) AND c.relname NOT IN (SELECT t FROM nt)
            AND NOT (c.relrowsecurity AND c.relforcerowsecurity)), 0, 'any other new billing table (for example a receipt counter) also has ENABLE + FORCE row level security');
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'billing' AND p.tablename = n.t AND p.roles <> ARRAY['lims_app']::name[]), 0, 'every policy on ' || n.t || ' is TO lims_app only') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = to_regclass('billing.' || n.t)
            AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) !~ 'tenant_id = '), 0, 'every ' || n.t || ' policy is tenant_id-scoped') FROM nt n;
SELECT is((SELECT array_agg(cmd ORDER BY cmd) FROM pg_policies WHERE schemaname = 'billing' AND tablename = x.t), x.cmds, x.t || ' has exactly the expected policy commands')
  FROM (VALUES ('account_groups', ARRAY['INSERT','SELECT','UPDATE']), ('account_particulars', ARRAY['INSERT','SELECT','UPDATE']), ('expense_types', ARRAY['INSERT','SELECT','UPDATE']),
               ('expenses', ARRAY['INSERT','SELECT','UPDATE']), ('cash_transfers', ARRAY['INSERT','SELECT','UPDATE'])) x(t, cmds);
SELECT ok((SELECT array_agg(cmd ORDER BY cmd) FROM pg_policies WHERE schemaname = 'billing' AND tablename = 'account_ledger_entries') @> ARRAY['INSERT','SELECT']
          AND NOT ((SELECT array_agg(cmd) FROM pg_policies WHERE schemaname = 'billing' AND tablename = 'account_ledger_entries') && ARRAY['DELETE','ALL']), 'account_ledger_entries has INSERT + SELECT policies and no DELETE / ALL policy');
SELECT is(has_table_privilege('lims_app', to_regclass('billing.' || x.t), x.priv), x.want, 'lims_app ' || x.priv || ' on ' || x.t || ' = ' || x.want)
  FROM (VALUES ('account_groups','SELECT',true),('account_groups','INSERT',true),('account_groups','UPDATE',true),('account_groups','DELETE',false),
               ('account_particulars','SELECT',true),('account_particulars','INSERT',true),('account_particulars','UPDATE',true),('account_particulars','DELETE',false),
               ('expense_types','SELECT',true),('expense_types','INSERT',true),('expense_types','UPDATE',true),('expense_types','DELETE',false),
               ('account_ledger_entries','SELECT',true),('account_ledger_entries','INSERT',true),('account_ledger_entries','UPDATE',false),('account_ledger_entries','DELETE',false),
               ('expenses','SELECT',true),('expenses','INSERT',true),('expenses','UPDATE',true),('expenses','DELETE',false),
               ('cash_transfers','SELECT',true),('cash_transfers','INSERT',true),('cash_transfers','UPDATE',true),('cash_transfers','DELETE',false)) x(t, priv, want);
-- append only: if there is any column level UPDATE grant on the ledger it is on status / last_modified_by / updated_at only (never amount, party, type, dates)
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'billing.account_ledger_entries'::regclass AND a.attnum > 0 AND NOT a.attisdropped
            AND has_column_privilege('lims_app', a.attrelid, a.attname, 'UPDATE') AND a.attname NOT IN ('status','last_modified_by','updated_at')), 0, 'no column of the ledger except status / last_modified_by / updated_at can be updated by lims_app');
SELECT is(coalesce(has_table_privilege(r.role, to_regclass('billing.' || n.t), 'SELECT'), false), false, r.role || ' has no grant on ' || n.t) FROM nt n CROSS JOIN (VALUES ('anon'),('authenticated'),('lims_monitor')) r(role) WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role);
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
  FROM (VALUES ('account_ledger_entries','amount_paisa','bigint'),('expenses','amount_paisa','bigint'),('cash_transfers','amount_paisa','bigint'),('account_ledger_entries','entry_date','date'),
               ('account_ledger_entries','receipt_no','text'),('account_ledger_entries','receipt_seq','bigint'),('expenses','expense_at','timestamp with time zone'),('cash_transfers','decided_at','timestamp with time zone'),
               ('expenses','cancelled_at','timestamp with time zone'),('account_ledger_entries','reverses_entry_id','uuid')) m(t, col, typ);
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'billing'::regnamespace AND c.relname IN (SELECT t FROM nt) AND a.attnum > 0 AND NOT a.attisdropped
            AND (a.attname LIKE '%\_paisa' ESCAPE '\') AND format_type(a.atttypid, a.atttypmod) <> 'bigint'), 0, 'every *_paisa column of the new tables is bigint (never float or numeric)');
SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = 'billing'::regnamespace AND c.relname IN (SELECT t FROM nt) AND a.attnum > 0 AND NOT a.attisdropped
            AND a.atttypid IN ('float4'::regtype, 'float8'::regtype, 'numeric'::regtype, 'money'::regtype)), 0, 'no float, numeric or money column in the new tables');
SELECT is((SELECT count(*)::int FROM pg_type t WHERE t.typnamespace = 'billing'::regnamespace AND t.typtype = 'e'), 0, 'no ENUM type in billing');
SELECT is((SELECT count(*)::int FROM pg_class WHERE relkind = 'S' AND relnamespace = 'billing'::regnamespace), 0, 'no sequences in billing (05-SCHEMA §9 test 1): receipt numbers come from a per tenant counter row');

-- ===================================================================================================================================== account groups
SELECT is(pg_temp.try('billing.account_groups', pg_temp.grp(1, pg_temp.ta())), 'ok', 'group A1 (income)');
SELECT is(pg_temp.try('billing.account_groups', pg_temp.grp(2, pg_temp.ta(), '{"nature":"expense"}')), 'ok', 'group A2 (expense)');
SELECT is(pg_temp.try('billing.account_groups', pg_temp.grp(3, pg_temp.ta(), '{"nature":"asset"}')), 'ok', 'group A3 (asset)');
SELECT is(pg_temp.try('billing.account_groups', pg_temp.grp(4, pg_temp.ta(), '{"nature":"liability","is_active":false}')), 'ok', 'group A4 (liability, inactive)');
SELECT is(pg_temp.try('billing.account_groups', pg_temp.grp(5, pg_temp.tb())), 'ok', 'group B5');
SELECT is((SELECT is_active FROM billing.account_groups WHERE id = pg_temp.uid(1)), true, 'a group is active by default');
SELECT is((SELECT version FROM billing.account_groups WHERE id = pg_temp.uid(1)), 1, 'a group starts at version 1');
SELECT isnt(pg_temp.try('billing.account_groups', pg_temp.grp(10 + t.i, pg_temp.ta(), t.o)), 'ok', t.lbl)
  FROM (VALUES (1, '{"nature":"equity"}'::jsonb, 'nature outside income|expense|asset|liability rejected'), (2, '{"nature":"Income"}'::jsonb, 'nature is case sensitive'),
               (3, '{"code":""}'::jsonb, 'empty code rejected'), (4, jsonb_build_object('code', repeat('C', 200)), 'oversize code rejected'), (5, '{"code":"BAD CODE;--"}'::jsonb, 'code with spaces and punctuation rejected'),
               (6, '{"name":""}'::jsonb, 'empty name rejected'), (7, jsonb_build_object('name', repeat('n', 1000)), 'oversize name rejected'), (8, '{"nature":null}'::jsonb, 'NULL nature rejected')) t(i, o, lbl);
SELECT is(pg_temp.try('billing.account_groups', pg_temp.grp(20, pg_temp.ta(), '{"code":"GRP_1"}')), '23505', 'same group code in the same tenant -> unique_violation');
SELECT isnt(pg_temp.try('billing.account_groups', pg_temp.grp(21, pg_temp.ta(), '{"code":"grp_1"}')), 'ok', 'group code differing only by case collides (unique or format check)');
SELECT is(pg_temp.try('billing.account_groups', pg_temp.grp(22, pg_temp.tb(), '{"code":"GRP_1"}')), 'ok', 'the same group code in another tenant is allowed');

-- ===================================================================================================================================== account particulars
SELECT is(pg_temp.try('billing.account_particulars', pg_temp.par(30, pg_temp.ta(), 1)), 'ok', 'particular A30 in group A1');
SELECT is(pg_temp.try('billing.account_particulars', pg_temp.par(31, pg_temp.ta(), 2)), 'ok', 'particular A31 in group A2 (expense)');
SELECT is(pg_temp.try('billing.account_particulars', pg_temp.par(32, pg_temp.ta(), 1)), 'ok', 'particular A32 in group A1');
SELECT is(pg_temp.try('billing.account_particulars', pg_temp.par(33, pg_temp.tb(), 5)), 'ok', 'particular B33 in group B5');
SELECT is((SELECT is_active FROM billing.account_particulars WHERE id = pg_temp.uid(30)), true, 'a particular is active by default');
SELECT is(pg_temp.try('billing.account_particulars', pg_temp.par(34, pg_temp.ta(), 5)), '23503', 'particular in another tenant''s group -> foreign_key_violation (composite tenant FK)');
SELECT is(pg_temp.try('billing.account_particulars', pg_temp.par(35, pg_temp.ta(), 404)), '23503', 'particular in an unknown group -> foreign_key_violation');
SELECT is(pg_temp.try('billing.account_particulars', pg_temp.par(36, pg_temp.ta(), 1, '{"code":"PAR_30"}')), '23505', 'same particular code in the same tenant -> unique_violation');
SELECT isnt(pg_temp.try('billing.account_particulars', pg_temp.par(37, pg_temp.ta(), 1, '{"code":"par_30"}')), 'ok', 'particular code differing only by case collides');
SELECT is(pg_temp.try('billing.account_particulars', pg_temp.par(38, pg_temp.tb(), 5, '{"code":"PAR_30"}')), 'ok', 'the same particular code in another tenant is allowed');
SELECT isnt(pg_temp.try('billing.account_particulars', pg_temp.par(40 + t.i, pg_temp.ta(), 1, t.o)), 'ok', t.lbl)
  FROM (VALUES (1, '{"code":""}'::jsonb, 'empty particular code rejected'), (2, jsonb_build_object('code', repeat('P', 200)), 'oversize particular code rejected'), (3, '{"code":"BAD;CODE"}'::jsonb, 'particular code with punctuation rejected'),
               (4, '{"name":""}'::jsonb, 'empty particular name rejected'), (5, jsonb_build_object('name', repeat('n', 1000)), 'oversize particular name rejected')) t(i, o, lbl);

-- ===================================================================================================================================== expense types
SELECT is(pg_temp.try('billing.expense_types', jsonb_build_object('id', pg_temp.uid(50), 'tenant_id', pg_temp.ta(), 'name', 'Electricity', 'account_particular_id', pg_temp.uid(31))), 'ok', 'expense type A50');
SELECT is(pg_temp.try('billing.expense_types', jsonb_build_object('id', pg_temp.uid(51), 'tenant_id', pg_temp.tb(), 'name', 'Electricity', 'account_particular_id', pg_temp.uid(33))), 'ok', 'the same expense type name in another tenant is allowed');
SELECT is((SELECT is_active FROM billing.expense_types WHERE id = pg_temp.uid(50)), true, 'an expense type is active by default');
SELECT isnt(pg_temp.try('billing.expense_types', jsonb_build_object('id', pg_temp.uid(52), 'tenant_id', pg_temp.ta(), 'name', 'Electricity', 'account_particular_id', pg_temp.uid(31))), 'ok', 'same expense type name in the same tenant rejected');
SELECT isnt(pg_temp.try('billing.expense_types', jsonb_build_object('id', pg_temp.uid(53), 'tenant_id', pg_temp.ta(), 'name', 'ELECTRICITY', 'account_particular_id', pg_temp.uid(31))), 'ok', 'expense type name differing only by case collides');
SELECT is(pg_temp.try('billing.expense_types', jsonb_build_object('id', pg_temp.uid(54), 'tenant_id', pg_temp.ta(), 'name', 'Water', 'account_particular_id', pg_temp.uid(33))), '23503', 'expense type on another tenant''s particular -> foreign_key_violation');
SELECT is(pg_temp.try('billing.expense_types', jsonb_build_object('id', pg_temp.uid(55), 'tenant_id', pg_temp.ta(), 'name', 'Water')), '23502', 'expense type without a particular -> not_null_violation');
SELECT isnt(pg_temp.try('billing.expense_types', jsonb_build_object('id', pg_temp.uid(56), 'tenant_id', pg_temp.ta(), 'name', '', 'account_particular_id', pg_temp.uid(31))), 'ok', 'empty expense type name rejected');
SELECT isnt(pg_temp.try('billing.expense_types', jsonb_build_object('id', pg_temp.uid(57), 'tenant_id', pg_temp.ta(), 'name', repeat('n', 1000), 'account_particular_id', pg_temp.uid(31))), 'ok', 'oversize expense type name rejected');

-- ===================================================================================================================================== account ledger entries: shape and values
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(100, pg_temp.ta(), 30)), 'ok', 'credit entry from a credit party, only the required fields');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(101, pg_temp.ta(), 31, jsonb_build_object('entry_type', 'debit', 'party_kind', 'franchise', 'party_id', pg_temp.uid(901), 'payment_mode', 'bank_transfer', 'bank_name', 'Synthetic Bank',
  'reference_no', 'SYN-REF-0001', 'payment_details', 'SYN-PAYDET-0001 synthetic', 'comments', 'synthetic comment', 'amount_paisa', 2500))), 'ok', 'debit entry for a franchise with every optional field');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(102, pg_temp.ta(), 30, '{"party_kind":"user_pocket"}')), 'ok', 'party_kind user_pocket');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(103, pg_temp.ta(), 30, '{"party_kind":"laboratory"}')), 'ok', 'party_kind laboratory');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(104, pg_temp.tb(), 33)), 'ok', 'fixture: ledger entry B');
SELECT is((SELECT status FROM billing.account_ledger_entries WHERE id = pg_temp.uid(100)), 'submitted', 'status defaults to submitted');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(105, pg_temp.ta(), 30, '{"status":"approved"}')), 'ok', 'status approved accepted at insert');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(106, pg_temp.ta(), 30, '{"status":"rejected"}')), 'ok', 'status rejected accepted at insert');
SELECT isnt(pg_temp.try('billing.account_ledger_entries', pg_temp.led(110 + t.i, pg_temp.ta(), 30, t.o)), 'ok', t.lbl)
  FROM (VALUES (1, '{"amount_paisa":0}'::jsonb, 'zero amount rejected (greater than 0)'), (2, '{"amount_paisa":-1}'::jsonb, 'negative amount rejected'), (3, '{"party_kind":"vendor"}'::jsonb, 'party_kind outside the four rejected'),
               (4, '{"entry_type":"transfer"}'::jsonb, 'entry_type outside credit|debit rejected'), (5, '{"status":"posted"}'::jsonb, 'status outside the four rejected'),
               (6, '{"payment_mode":""}'::jsonb, 'empty payment_mode rejected'), (7, jsonb_build_object('payment_mode', repeat('m', 500)), 'oversize payment_mode rejected'),
               (8, '{"bank_name":""}'::jsonb, 'empty bank_name rejected'), (9, jsonb_build_object('bank_name', repeat('b', 1000)), 'oversize bank_name rejected'),
               (10, '{"reference_no":""}'::jsonb, 'empty reference_no rejected'), (11, jsonb_build_object('reference_no', repeat('r', 500)), 'oversize reference_no rejected'),
               (12, '{"reference_no":"4111111111111111"}'::jsonb, 'reference_no that looks like a card number rejected (REQ-SEC-056)'), (13, '{"payment_details":"card 4111111111111111"}'::jsonb, 'payment_details with a card number rejected'),
               (14, jsonb_build_object('payment_details', repeat('d', 20000)), 'oversize payment_details rejected'), (15, jsonb_build_object('comments', repeat('c', 20000)), 'oversize comments rejected'),
               (16, '{"comments":""}'::jsonb, 'empty comments rejected'), (17, jsonb_build_object('centre_id', pg_temp.centre(pg_temp.tb())), 'centre of another tenant rejected (composite FK)'),
               (18, jsonb_build_object('account_particular_id', pg_temp.uid(33)), 'particular of another tenant rejected (composite FK)'), (19, jsonb_build_object('account_particular_id', pg_temp.uid(404)), 'unknown particular rejected'),
               (20, '{"entry_date":null}'::jsonb, 'NULL entry_date rejected'), (21, '{"party_id":null}'::jsonb, 'NULL party_id rejected'), (22, '{"centre_id":null}'::jsonb, 'NULL centre_id rejected')) t(i, o, lbl);
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(140, pg_temp.ta(), 30, jsonb_build_object('amount_paisa', 9007199254740991))), 'ok', 'the largest wire amount (2^53 - 1 paisa) fits');
-- receipt numbers: unique per tenant, positive, tenant scoped
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(141, pg_temp.ta(), 30, '{"receipt_no":"SYN-ACC-100","receipt_seq":9141}')), '23505', 'same receipt_no in the same tenant -> unique_violation');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(142, pg_temp.ta(), 30, '{"receipt_no":"SYN-ACC-9142","receipt_seq":100}')), '23505', 'same receipt_seq in the same tenant -> unique_violation');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(143, pg_temp.tb(), 33, '{"receipt_no":"SYN-ACC-100","receipt_seq":100}')), 'ok', 'the same receipt number in another tenant is allowed (per tenant counter)');
SELECT isnt(pg_temp.try('billing.account_ledger_entries', pg_temp.led(144, pg_temp.ta(), 30, '{"receipt_no":"SYN-ACC-9144","receipt_seq":0}')), 'ok', 'receipt_seq 0 rejected');
SELECT isnt(pg_temp.try('billing.account_ledger_entries', pg_temp.led(145, pg_temp.ta(), 30, '{"receipt_no":"","receipt_seq":9145}')), 'ok', 'empty receipt_no rejected');
SELECT is((SELECT attnotnull FROM pg_attribute WHERE attrelid = 'billing.account_ledger_entries'::regclass AND attname = 'receipt_no' AND NOT attisdropped), true, 'receipt_no is NOT NULL (every entry has a receipt)');
-- reversals: a NEW row, opposite type, same amount / centre / party / particular, once, never a reversal of a reversal
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(150, pg_temp.ta(), 30, jsonb_build_object('entry_type', 'debit', 'reverses_entry_id', pg_temp.uid(100)))), 'ok', 'reversal of entry 100: new row, opposite type, same amount');
SELECT is(pg_temp.try('billing.account_ledger_entries', pg_temp.led(151, pg_temp.ta(), 30, jsonb_build_object('entry_type', 'debit', 'reverses_entry_id', pg_temp.uid(100)))), '23505', 'a second reversal of the same entry -> unique_violation (one reversal per entry)');
SELECT isnt(pg_temp.try('billing.account_ledger_entries', pg_temp.led(152, pg_temp.ta(), 30, jsonb_build_object('entry_type', 'credit', 'reverses_entry_id', pg_temp.uid(102), 'party_kind', 'user_pocket'))), 'ok', 'a reversal with the SAME type as the original rejected');
SELECT isnt(pg_temp.try('billing.account_ledger_entries', pg_temp.led(153, pg_temp.ta(), 30, jsonb_build_object('entry_type', 'debit', 'reverses_entry_id', pg_temp.uid(102), 'party_kind', 'user_pocket', 'amount_paisa', 149999))), 'ok', 'a reversal with another amount rejected');
SELECT isnt(pg_temp.try('billing.account_ledger_entries', pg_temp.led(154, pg_temp.ta(), 30, jsonb_build_object('entry_type', 'debit', 'reverses_entry_id', pg_temp.uid(102), 'party_kind', 'user_pocket', 'party_id', pg_temp.uid(999)))), 'ok', 'a reversal for another party rejected');
SELECT isnt(pg_temp.try('billing.account_ledger_entries', pg_temp.led(155, pg_temp.ta(), 30, jsonb_build_object('entry_type', 'debit', 'reverses_entry_id', pg_temp.uid(102), 'party_kind', 'user_pocket', 'account_particular_id', pg_temp.uid(31)))), 'ok', 'a reversal on another particular rejected');
SELECT isnt(pg_temp.try('billing.account_ledger_entries', pg_temp.led(156, pg_temp.ta(), 30, jsonb_build_object('entry_type', 'credit', 'reverses_entry_id', pg_temp.uid(150)))), 'ok', 'a reversal of a reversal rejected');
SELECT isnt(pg_temp.try('billing.account_ledger_entries', pg_temp.led(157, pg_temp.ta(), 30, jsonb_build_object('entry_type', 'debit', 'reverses_entry_id', pg_temp.uid(104)))), 'ok', 'reversing another tenant''s entry rejected (guard or composite tenant FK)');
SELECT isnt(pg_temp.try('billing.account_ledger_entries', pg_temp.led(158, pg_temp.ta(), 30, jsonb_build_object('entry_type', 'debit', 'reverses_entry_id', pg_temp.uid(404)))), 'ok', 'reversing an unknown entry rejected');
SELECT isnt(pg_temp.try('billing.account_ledger_entries', pg_temp.led(159, pg_temp.ta(), 30, jsonb_build_object('reverses_entry_id', pg_temp.uid(159)))), 'ok', 'an entry cannot reverse itself');
SELECT is((SELECT count(*)::int FROM billing.account_ledger_entries WHERE id = pg_temp.uid(100) AND amount_paisa = 150000 AND entry_type = 'credit'), 1, 'the original entry is unchanged after its reversal (the reversal is a new row)');
-- balance can be derived from rows alone: credits - debits for one party
SELECT is((SELECT sum(CASE entry_type WHEN 'credit' THEN amount_paisa ELSE -amount_paisa END)::bigint FROM billing.account_ledger_entries WHERE tenant_id = pg_temp.ta() AND party_kind = 'credit_party' AND party_id = pg_temp.uid(900)
            AND account_particular_id = pg_temp.uid(30) AND receipt_no IN ('SYN-ACC-100', 'SYN-ACC-150')), 0::bigint, 'an entry plus its reversal net to zero for the party');

-- ===================================================================================================================================== append only for lims_app
SELECT alike(pg_temp.a('UPDATE billing.account_ledger_entries SET amount_paisa = 1 WHERE id = ' || quote_literal(pg_temp.uid(100))), 'E%', 'lims_app cannot UPDATE the amount of a ledger entry');
SELECT alike(pg_temp.a('UPDATE billing.account_ledger_entries SET party_id = ' || quote_literal(pg_temp.uid(998)) || ' WHERE id = ' || quote_literal(pg_temp.uid(100))), 'E%', 'lims_app cannot UPDATE the party of a ledger entry');
SELECT alike(pg_temp.a('UPDATE billing.account_ledger_entries SET entry_type = ''debit'' WHERE id = ' || quote_literal(pg_temp.uid(100))), 'E%', 'lims_app cannot UPDATE the type of a ledger entry');
SELECT alike(pg_temp.a('UPDATE billing.account_ledger_entries SET comments = ''edited'' WHERE id = ' || quote_literal(pg_temp.uid(100))), 'E%', 'lims_app cannot UPDATE the comments of a ledger entry');
SELECT alike(pg_temp.a('UPDATE billing.account_ledger_entries SET receipt_no = ''X'' WHERE id = ' || quote_literal(pg_temp.uid(100))), 'E%', 'lims_app cannot UPDATE the receipt number');
SELECT alike(pg_temp.a('UPDATE billing.account_ledger_entries SET reverses_entry_id = ' || quote_literal(pg_temp.uid(102)) || ' WHERE id = ' || quote_literal(pg_temp.uid(103))), 'E%', 'lims_app cannot turn an entry into a reversal afterwards');
SELECT alike(pg_temp.a('DELETE FROM billing.account_ledger_entries WHERE id = ' || quote_literal(pg_temp.uid(100))), 'E42501|%', 'lims_app cannot DELETE a ledger entry');
SELECT alike(pg_temp.a('TRUNCATE billing.account_ledger_entries'), 'E42501|%', 'lims_app cannot TRUNCATE the ledger');
SELECT isnt(coalesce(pg_temp.a('UPDATE billing.account_ledger_entries SET status = ''reversed'' WHERE id = ' || quote_literal(pg_temp.uid(100))), ''), 'n=0',
  'a status change is either refused or applied (a narrow status rule), never silently skipped by a missing row');
SELECT alike(pg_temp.a('UPDATE billing.account_ledger_entries SET status = ''bogus'' WHERE id = ' || quote_literal(pg_temp.uid(100))), 'E%', 'status can never be set to a value outside the four');
SELECT is((SELECT amount_paisa FROM billing.account_ledger_entries WHERE id = pg_temp.uid(100)), 150000::bigint, 'after every attempt the amount is still 150000 paisa');
SELECT is((SELECT count(*)::int FROM billing.account_ledger_entries WHERE id = pg_temp.uid(100)), 1, 'after every attempt the entry still exists');

-- ===================================================================================================================================== expenses
SELECT is(pg_temp.try('billing.expenses', jsonb_build_object('id', pg_temp.uid(200), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.centre(pg_temp.ta()), 'expense_at', now(), 'expense_type_id', pg_temp.uid(50),
  'amount_paisa', 25000, 'description', 'Synthetic electricity bill')), 'ok', 'expense A200 without a ledger entry');
SELECT is(pg_temp.try('billing.expenses', jsonb_build_object('id', pg_temp.uid(201), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.centre(pg_temp.ta()), 'expense_at', now(), 'expense_type_id', pg_temp.uid(50),
  'amount_paisa', 2500, 'ledger_entry_id', pg_temp.uid(101))), 'ok', 'expense A201 linked to ledger entry 101');
SELECT is(pg_temp.try('billing.expenses', jsonb_build_object('id', pg_temp.uid(202), 'tenant_id', pg_temp.tb(), 'centre_id', pg_temp.centre(pg_temp.tb()), 'expense_at', now(), 'expense_type_id', pg_temp.uid(51), 'amount_paisa', 100)), 'ok', 'fixture: expense B202');
SELECT is((SELECT cancelled_at FROM billing.expenses WHERE id = pg_temp.uid(200)) IS NULL, true, 'a new expense is not cancelled');
SELECT isnt(pg_temp.try('billing.expenses', jsonb_build_object('id', pg_temp.uid(210 + t.i), 'tenant_id', pg_temp.ta(), 'centre_id', pg_temp.centre(pg_temp.ta()), 'expense_at', now(), 'expense_type_id', pg_temp.uid(50), 'amount_paisa', 100) || t.o), 'ok', t.lbl)
  FROM (VALUES (1, '{"amount_paisa":0}'::jsonb, 'zero expense amount rejected'), (2, '{"amount_paisa":-5}'::jsonb, 'negative expense amount rejected'), (3, jsonb_build_object('expense_type_id', pg_temp.uid(51)), 'expense type of another tenant rejected'),
               (4, jsonb_build_object('centre_id', pg_temp.centre(pg_temp.tb())), 'centre of another tenant rejected'), (5, jsonb_build_object('ledger_entry_id', pg_temp.uid(104)), 'ledger entry of another tenant rejected'),
               (6, '{"description":""}'::jsonb, 'empty description rejected'), (7, jsonb_build_object('description', repeat('d', 20000)), 'oversize description rejected'), (8, '{"expense_type_id":null}'::jsonb, 'NULL expense type rejected'),
               (9, '{"expense_at":null}'::jsonb, 'NULL expense_at rejected'), (10, jsonb_build_object('ledger_entry_id', pg_temp.uid(404)), 'unknown ledger entry rejected')) t(i, o, lbl);
SELECT is(pg_temp.a('UPDATE billing.expenses SET cancelled_at = now(), version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(200))), 'n=1', 'lims_app cancels an expense (cancelled_at set)');
SELECT alike(pg_temp.a('UPDATE billing.expenses SET cancelled_at = NULL WHERE id = ' || quote_literal(pg_temp.uid(200))), 'E%', 'a cancelled expense cannot be un-cancelled');
SELECT alike(pg_temp.a('UPDATE billing.expenses SET amount_paisa = 1 WHERE id = ' || quote_literal(pg_temp.uid(201))), 'E%', 'the amount of an expense cannot be edited (cancel and re-enter)');
SELECT alike(pg_temp.a('UPDATE billing.expenses SET expense_type_id = ' || quote_literal(pg_temp.uid(50)) || ', centre_id = ' || quote_literal(pg_temp.centre(pg_temp.ta())) || ', amount_paisa = 3 WHERE id = ' || quote_literal(pg_temp.uid(201))), 'E%', 'amount cannot change together with other columns either');
SELECT alike(pg_temp.a('DELETE FROM billing.expenses WHERE id = ' || quote_literal(pg_temp.uid(201))), 'E42501|%', 'lims_app cannot DELETE an expense');

-- ===================================================================================================================================== cash transfers
SELECT is(pg_temp.try('billing.cash_transfers', jsonb_build_object('id', pg_temp.uid(300), 'tenant_id', pg_temp.ta(), 'from_kind', 'user', 'from_id', pg_temp.uid(1000), 'to_kind', 'centre', 'to_id', pg_temp.centre(pg_temp.ta()), 'amount_paisa', 500000, 'remark', 'synthetic')), 'ok', 'transfer A300 user -> centre (pending)');
SELECT is(pg_temp.try('billing.cash_transfers', jsonb_build_object('id', pg_temp.uid(301), 'tenant_id', pg_temp.ta(), 'from_kind', 'centre', 'from_id', pg_temp.centre(pg_temp.ta()), 'to_kind', 'user', 'to_id', pg_temp.uid(1001), 'amount_paisa', 1000)), 'ok', 'transfer A301 centre -> user');
SELECT is(pg_temp.try('billing.cash_transfers', jsonb_build_object('id', pg_temp.uid(302), 'tenant_id', pg_temp.ta(), 'from_kind', 'user', 'from_id', pg_temp.uid(1002), 'to_kind', 'user', 'to_id', pg_temp.uid(1003), 'amount_paisa', 700)), 'ok', 'transfer A302 user -> user');
SELECT is(pg_temp.try('billing.cash_transfers', jsonb_build_object('id', pg_temp.uid(303), 'tenant_id', pg_temp.ta(), 'from_kind', 'user', 'from_id', pg_temp.uid(1004), 'to_kind', 'user', 'to_id', pg_temp.uid(1005), 'amount_paisa', 800)), 'ok', 'transfer A303 (to be cancelled)');
SELECT is(pg_temp.try('billing.cash_transfers', jsonb_build_object('id', pg_temp.uid(304), 'tenant_id', pg_temp.tb(), 'from_kind', 'user', 'from_id', pg_temp.uid(1006), 'to_kind', 'user', 'to_id', pg_temp.uid(1007), 'amount_paisa', 100)), 'ok', 'fixture: transfer B304');
SELECT is((SELECT status FROM billing.cash_transfers WHERE id = pg_temp.uid(300)), 'pending', 'a new transfer is pending');
SELECT is((SELECT decided_by IS NULL AND decided_at IS NULL FROM billing.cash_transfers WHERE id = pg_temp.uid(300)), true, 'a pending transfer has no decision yet');
SELECT isnt(pg_temp.try('billing.cash_transfers', jsonb_build_object('id', pg_temp.uid(310 + t.i), 'tenant_id', pg_temp.ta(), 'from_kind', 'user', 'from_id', pg_temp.uid(1010), 'to_kind', 'user', 'to_id', pg_temp.uid(1011), 'amount_paisa', 100) || t.o), 'ok', t.lbl)
  FROM (VALUES (1, '{"amount_paisa":0}'::jsonb, 'zero transfer amount rejected'), (2, '{"amount_paisa":-9}'::jsonb, 'negative transfer amount rejected'), (3, '{"from_kind":"bank"}'::jsonb, 'from_kind outside user|centre rejected'),
               (4, '{"to_kind":"vendor"}'::jsonb, 'to_kind outside user|centre rejected'), (5, jsonb_build_object('to_id', pg_temp.uid(1010)), 'transfer to the same party rejected (from = to)'),
               (6, '{"status":"posted"}'::jsonb, 'status outside the four rejected'), (7, '{"remark":""}'::jsonb, 'empty remark rejected'), (8, jsonb_build_object('remark', repeat('r', 20000)), 'oversize remark rejected'),
               (9, '{"status":"accepted"}'::jsonb, 'accepted without decided_by / decided_at rejected'), (10, jsonb_build_object('decided_by', pg_temp.uid(1012), 'decided_at', now()), 'a pending transfer with a decision rejected'),
               (11, '{"from_id":null}'::jsonb, 'NULL from_id rejected'), (12, '{"to_id":null}'::jsonb, 'NULL to_id rejected')) t(i, o, lbl);
SELECT is(pg_temp.try('billing.cash_transfers', jsonb_build_object('id', pg_temp.uid(330), 'tenant_id', pg_temp.ta(), 'from_kind', 'user', 'from_id', pg_temp.uid(1010), 'to_kind', 'centre', 'to_id', pg_temp.uid(1010), 'amount_paisa', 100)), 'ok',
  'same uuid but different kinds (user vs centre) is a different party, allowed');
SELECT isnt(pg_temp.try('billing.cash_transfers', jsonb_build_object('id', pg_temp.uid(331), 'tenant_id', pg_temp.ta(), 'from_kind', 'user', 'from_id', pg_temp.uid(1010), 'to_kind', 'user', 'to_id', pg_temp.uid(1011), 'amount_paisa', 100,
  'status', 'accepted', 'decided_by', pg_temp.sys(), 'decided_at', now())), 'ok', 'separation of duties: accepted by the creator (decided_by = created_by) rejected');
-- lifecycle through the application role
SELECT is(pg_temp.a('UPDATE billing.cash_transfers SET status = ''accepted'', decided_by = ' || quote_literal(pg_temp.uid(1020)) || ', decided_at = now(), version = version + 1 WHERE id = ' || quote_literal(pg_temp.uid(300))), 'n=1',
  'pending -> accepted by another user');
SELECT is(pg_temp.a('UPDATE billing.cash_transfers SET status = ''rejected'', decided_by = ' || quote_literal(pg_temp.uid(1020)) || ', decided_at = now() WHERE id = ' || quote_literal(pg_temp.uid(301))), 'n=1', 'pending -> rejected by another user');
SELECT is(pg_temp.a('UPDATE billing.cash_transfers SET status = ''cancelled'', decided_by = ' || quote_literal(pg_temp.sys()) || ', decided_at = now() WHERE id = ' || quote_literal(pg_temp.uid(303))), 'n=1', 'pending -> cancelled by its creator');
SELECT alike(pg_temp.a('UPDATE billing.cash_transfers SET status = ''rejected'', decided_by = ' || quote_literal(pg_temp.uid(1021)) || ', decided_at = now() WHERE id = ' || quote_literal(pg_temp.uid(300))), 'E%', 'accepted -> rejected refused (terminal)');
SELECT alike(pg_temp.a('UPDATE billing.cash_transfers SET status = ''pending'', decided_by = NULL, decided_at = NULL WHERE id = ' || quote_literal(pg_temp.uid(301))), 'E%', 'rejected -> pending refused (terminal)');
SELECT alike(pg_temp.a('UPDATE billing.cash_transfers SET status = ''accepted'', decided_by = ' || quote_literal(pg_temp.uid(1022)) || ', decided_at = now() WHERE id = ' || quote_literal(pg_temp.uid(303))), 'E%', 'cancelled -> accepted refused (terminal)');
SELECT alike(pg_temp.a('UPDATE billing.cash_transfers SET amount_paisa = 1 WHERE id = ' || quote_literal(pg_temp.uid(302))), 'E%', 'the amount of a pending transfer cannot be edited');
SELECT alike(pg_temp.a('UPDATE billing.cash_transfers SET to_id = ' || quote_literal(pg_temp.uid(1030)) || ' WHERE id = ' || quote_literal(pg_temp.uid(302))), 'E%', 'the receiver of a pending transfer cannot be changed');
SELECT alike(pg_temp.a('UPDATE billing.cash_transfers SET status = ''accepted'' WHERE id = ' || quote_literal(pg_temp.uid(302))), 'E%', 'accepted without decided_by / decided_at refused');
SELECT alike(pg_temp.a('UPDATE billing.cash_transfers SET status = ''accepted'', decided_by = ' || quote_literal(pg_temp.sys()) || ', decided_at = now() WHERE id = ' || quote_literal(pg_temp.uid(302))), 'E%', 'the creator cannot accept its own transfer');
SELECT alike(pg_temp.a('DELETE FROM billing.cash_transfers WHERE id = ' || quote_literal(pg_temp.uid(302))), 'E42501|%', 'lims_app cannot DELETE a transfer');
SELECT is((SELECT status || '/' || amount_paisa FROM billing.cash_transfers WHERE id = pg_temp.uid(302)), 'pending/700', 'after every refused attempt the transfer is still pending with its amount');

-- ===================================================================================================================================== isolation: tenant A / B probes on every new table
CREATE TEMP TABLE probe(t, own_a) AS VALUES ('account_groups', pg_temp.uid(1)), ('account_particulars', pg_temp.uid(30)), ('expense_types', pg_temp.uid(50)), ('account_ledger_entries', pg_temp.uid(100)),
  ('expenses', pg_temp.uid(200)), ('cash_transfers', pg_temp.uid(300));
SELECT is(pg_temp.a('SELECT 1 FROM billing.' || p.t || ' WHERE id = ' || quote_literal(p.own_a), 'n'), 'n=1', 'control: tenant A staff reads its own ' || p.t || ' row') FROM probe p;
SELECT cmp_ok((SELECT count(*)::int FROM billing.account_ledger_entries WHERE tenant_id = pg_temp.tb()), '>=', 1, 'fixture: tenant B has ledger entries');
SELECT is(pg_temp.a('SELECT 1 FROM billing.' || p.t || ' WHERE tenant_id = ' || quote_literal(pg_temp.tb()), 'n'), 'n=0', 'tenant A sees 0 tenant B rows in ' || p.t) FROM probe p;
SELECT is(pg_temp.b('SELECT 1 FROM billing.' || p.t || ' WHERE tenant_id = ' || quote_literal(pg_temp.ta()), 'n'), 'n=0', 'tenant B sees 0 tenant A rows in ' || p.t) FROM probe p;
SELECT is(pg_temp.a('UPDATE billing.' || t || ' SET version = version + 1 WHERE tenant_id = ' || quote_literal(pg_temp.tb())), 'n=0', 'tenant A updates 0 tenant B rows in ' || t)
  FROM (VALUES ('account_groups'),('account_particulars'),('expense_types'),('expenses'),('cash_transfers')) v(t);
SELECT alike(pg_temp.a(format($$ INSERT INTO billing.account_groups (id, tenant_id, code, name, nature, created_by) VALUES (%L, %L, 'HIJACK', 'x', 'income', %L) $$, pg_temp.uid(500), pg_temp.tb(), pg_temp.sys())), 'E42501|%', 'tenant A cannot insert a group for tenant B');
SELECT alike(pg_temp.a(format($$ INSERT INTO billing.cash_transfers (id, tenant_id, from_kind, from_id, to_kind, to_id, amount_paisa, created_by) VALUES (%L, %L, 'user', %L, 'user', %L, 5, %L) $$,
  pg_temp.uid(501), pg_temp.tb(), pg_temp.uid(1), pg_temp.uid(2), pg_temp.sys())), 'E42501|%', 'tenant A cannot insert a transfer for tenant B');
SELECT alike(pg_temp.a(format($$ INSERT INTO billing.account_ledger_entries (id, tenant_id, centre_id, party_kind, party_id, entry_date, account_particular_id, entry_type, amount_paisa, payment_mode, receipt_no, receipt_seq, created_by, last_modified_by)
  VALUES (%L, %L, %L, 'credit_party', %L, '2026-11-17', %L, 'credit', 5, 'cash', 'HIJACK-1', 99999, %L, %L) $$, pg_temp.uid(502), pg_temp.tb(), pg_temp.centre(pg_temp.tb()), pg_temp.uid(2), pg_temp.uid(33), pg_temp.sys(), pg_temp.sys())), 'E42501|%',
  'tenant A cannot insert a ledger entry for tenant B');
SELECT is(pg_temp.a(format($$ INSERT INTO billing.account_ledger_entries (id, tenant_id, centre_id, party_kind, party_id, entry_date, account_particular_id, entry_type, amount_paisa, payment_mode, receipt_no, receipt_seq, created_by, last_modified_by)
  VALUES (%L, %L, %L, 'credit_party', %L, '2026-11-17', %L, 'credit', 5, 'cash', 'OWN-1', 99998, %L, %L) $$, pg_temp.uid(503), pg_temp.ta(), pg_temp.centre(pg_temp.ta()), pg_temp.uid(900), pg_temp.uid(30), pg_temp.sys(), pg_temp.sys())), 'n=1',
  'tenant A staff inserts its own ledger entry through lims_app (grant + policy work)');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), 'SELECT 1 FROM billing.' || p.t, 'n') <> 'n=0', true, 'control: a staff actor sees rows of ' || p.t) FROM probe p;
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), 'SELECT 1 FROM billing.' || p.t, 'n'), 'n=0', 'a ' || r.k || '-actor sees 0 rows of ' || p.t) FROM probe p CROSS JOIN (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ INSERT INTO billing.account_groups (id, tenant_id, code, name, nature, created_by) VALUES (%L, %L, 'PORTALX', 'x', 'income', %L) $$,
  pg_temp.uid(510), pg_temp.ta(), pg_temp.sys()), 'w'), 'E42501|%', 'a ' || r.k || '-actor cannot insert a group') FROM (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ INSERT INTO billing.cash_transfers (id, tenant_id, from_kind, from_id, to_kind, to_id, amount_paisa, created_by) VALUES (%L, %L, 'user', %L, 'user', %L, 5, %L) $$,
  pg_temp.uid(511), pg_temp.ta(), pg_temp.uid(1), pg_temp.uid(2), pg_temp.sys()), 'w'), 'E42501|%', 'a ' || r.k || '-actor cannot create a transfer') FROM (VALUES ('patient'),('partner'),('portal')) r(k);

-- ===================================================================================================================================== audit
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'billing' AND table_name = x.t AND row_id = x.rid AND action = 'INSERT'), 1, 'control: INSERT into ' || x.t || ' is audited')
  FROM (VALUES ('account_groups', pg_temp.uid(1)), ('account_particulars', pg_temp.uid(30)), ('expense_types', pg_temp.uid(50)), ('expenses', pg_temp.uid(200)), ('cash_transfers', pg_temp.uid(300))) x(t, rid);
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = to_regclass('billing.account_ledger_entries') AND NOT tgisinternal AND pg_get_triggerdef(oid) ~ 'tg_row_audit'
            AND pg_get_triggerdef(oid) !~ '''payment_details'''), 0, 'an audit trigger on the ledger, if present, excludes payment_details (free text, may hold personal data)');
SELECT is((SELECT count(*)::int FROM audit.audit_log a WHERE (coalesce(a.old_values::text, '') || coalesce(a.new_values::text, '') || coalesce(a.changed_columns::text, '')) ~ 'SYN-PAYDET-0001'), 0,
  'no payment_details value anywhere in audit.audit_log');
SELECT ok(EXISTS (SELECT 1 FROM audit.audit_log WHERE schema_name = 'billing' AND table_name = 'cash_transfers' AND row_id = pg_temp.uid(300) AND action = 'UPDATE' AND 'status' = ANY (changed_columns)),
  'a transfer status change is recorded as changed (decision trail)');

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
         (SELECT count(*) FROM billing.account_groups) AS n_groups, (SELECT count(*) FROM billing.account_ledger_entries) AS n_led, (SELECT count(*) FROM billing.expenses) AS n_exp,
         (SELECT count(*) FROM billing.cash_transfers) AS n_xfer, (SELECT count(*) FROM billing.ledger_entries) AS n_old_led;
\ir ../../migrations/20261117120000_billing__add_lab_accounting.sql
RESET ROLE;
SELECT is((SELECT count(*) FROM pg_class WHERE relnamespace = 'billing'::regnamespace AND relkind = 'r'), (SELECT tbls FROM before_state), 're-apply: table count unchanged');
SELECT is(pg_temp.colcount(), (SELECT cols FROM before_state), 're-apply: column count unchanged');
SELECT is((SELECT count(*) FROM pg_constraint WHERE conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'billing'::regnamespace)), (SELECT cons FROM before_state), 're-apply: constraint count unchanged');
SELECT is((SELECT count(*) FROM pg_index WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'billing'::regnamespace)), (SELECT idxs FROM before_state), 're-apply: index count unchanged');
SELECT is((SELECT count(*) FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'billing'::regnamespace)), (SELECT pols FROM before_state), 're-apply: policy count unchanged');
SELECT is((SELECT string_agg(pg_get_triggerdef(oid), '|' ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'billing'::regnamespace) AND NOT tgisinternal),
  (SELECT trg FROM before_state), 're-apply: triggers unchanged');
SELECT is((SELECT count(*) FROM billing.account_groups), (SELECT n_groups FROM before_state), 're-apply: no group row added or removed');
SELECT is((SELECT count(*) FROM billing.account_ledger_entries), (SELECT n_led FROM before_state), 're-apply: no ledger row added or removed');
SELECT is((SELECT count(*) FROM billing.expenses), (SELECT n_exp FROM before_state), 're-apply: no expense row added or removed');
SELECT is((SELECT count(*) FROM billing.cash_transfers), (SELECT n_xfer FROM before_state), 're-apply: no transfer row added or removed');
SELECT is((SELECT count(*) FROM billing.ledger_entries), (SELECT n_old_led FROM before_state), 're-apply: the old invoice payment ledger is untouched');
SELECT is((SELECT amount_paisa FROM billing.account_ledger_entries WHERE id = pg_temp.uid(100)), 150000::bigint, 're-apply: no data rewrite (ledger amount intact)');
SELECT is((SELECT status FROM billing.cash_transfers WHERE id = pg_temp.uid(300)), 'accepted', 're-apply: no data rewrite (transfer status intact)');
SELECT is(has_table_privilege('lims_app', 'billing.account_ledger_entries', 'UPDATE') OR has_table_privilege('lims_app', 'billing.account_ledger_entries', 'DELETE'), false, 're-apply keeps the ledger append only');
SELECT is(has_table_privilege('lims_app', 'billing.ledger_entries', 'UPDATE') OR has_table_privilege('lims_app', 'billing.ledger_entries', 'DELETE'), false, 're-apply keeps the old payment ledger append only');

SELECT * FROM finish();
ROLLBACK;
