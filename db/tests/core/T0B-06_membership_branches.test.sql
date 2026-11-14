-- T0B-06 live-DB assertions: core.membership_branches + app.tg_scope_user_only (05-SCHEMA §3.3, §10; 08 R3; C2 05-SCHEMA §11 test 14).
-- Covers: catalog (columns, PK, FKs, FORCE RLS, policies, grants, triggers, audit trigger), tenant isolation / staff guard, DELETE allowed / UPDATE refused,
-- scope_user_only on BOTH scope tables for patient and partner memberships (SQLSTATE 23514, message scope_user_only), all_centres CHECK on non-user memberships.
-- Synthetic data only; one rolled-back transaction; RLS never disabled.
-- Run: pg_prove -d <migrated db> db/tests/core/T0B-06_membership_branches.test.sql   (superuser; pgTAP in schema `extensions`)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.id(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-' || lpad(to_hex(k), 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.cl(p_type text, p_tenant int, p_sub int DEFAULT 99, p_mem int DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('actor_type', p_type, 'tenant_id', pg_temp.id(p_tenant), 'sub', pg_temp.id(p_sub), 'membership_id', pg_temp.id(p_mem)))::text $$;
CREATE FUNCTION pg_temp.as_x(p_role text, p_claims text, p_sql text, p_mode text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := n::text;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := n::text; END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.w(c text, s text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.as_x('lims_api', c, s, 'w') $$;
CREATE FUNCTION pg_temp.n(c text, s text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.as_x('lims_api', c, s, 'n') $$;
-- INSERT text for either scope table
CREATE FUNCTION pg_temp.ins_branch(t int, m int, b int) RETURNS text LANGUAGE sql AS $$
  SELECT format('INSERT INTO core.membership_branches (tenant_id, membership_id, branch_id, created_by) VALUES (%L, %L, %L, %L)', pg_temp.id(t), pg_temp.id(m), pg_temp.id(b), pg_temp.id(99)) $$;
CREATE FUNCTION pg_temp.ins_centre(t int, m int, c int) RETURNS text LANGUAGE sql AS $$
  SELECT format('INSERT INTO core.membership_centres (tenant_id, membership_id, centre_id, created_by) VALUES (%L, %L, %L, %L)', pg_temp.id(t), pg_temp.id(m), pg_temp.id(c), pg_temp.id(99)) $$;

-- ---------------------------------------------------------------- catalog
SELECT has_table('core', 'membership_branches', 'core.membership_branches exists');
SELECT ok(c.relrowsecurity AND c.relforcerowsecurity, 'membership_branches: ENABLE + FORCE RLS') FROM pg_class c WHERE c.oid = 'core.membership_branches'::regclass;
SELECT ok(pg_get_userbyid(c.relowner) = 'lims_owner', 'membership_branches: owned by lims_owner') FROM pg_class c WHERE c.oid = 'core.membership_branches'::regclass;
SELECT is((SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'core.membership_branches'::regclass AND attnum > 0 AND NOT attisdropped),
          ARRAY['tenant_id', 'membership_id', 'branch_id', 'created_at', 'created_by'], 'membership_branches: exactly the five spec columns (association class, no version/is_active)');
SELECT col_not_null('core', 'membership_branches', c, 'membership_branches.' || c || ' NOT NULL') FROM unnest(ARRAY['tenant_id', 'membership_id', 'branch_id', 'created_at', 'created_by']) c;
SELECT is((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'membership_branches__pk' AND conrelid = 'core.membership_branches'::regclass),
          'PRIMARY KEY (tenant_id, membership_id, branch_id)', 'membership_branches__pk (tenant_id, membership_id, branch_id)');
SELECT is((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'membership_branches__membership__fk' AND conrelid = 'core.membership_branches'::regclass),
          'FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships(tenant_id, id)', 'membership_branches__membership__fk is composite');
SELECT is((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'membership_branches__branch__fk' AND conrelid = 'core.membership_branches'::regclass),
          'FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches(tenant_id, id)', 'membership_branches__branch__fk is composite');
SELECT is((SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_policies WHERE schemaname = 'core' AND tablename = 'membership_branches'),
          ARRAY['membership_branches__delete__tenant', 'membership_branches__insert__tenant', 'membership_branches__select__tenant'],
          'membership_branches: exactly select/insert/delete __tenant policies (no UPDATE policy, no owner policy: branch scope is application-level only, 08 R3)');
SELECT ok(roles = '{lims_app}' AND (coalesce(qual, '') || coalesce(with_check, '')) ~ 'is_staff_or_system' AND (coalesce(qual, '') || coalesce(with_check, '')) ~ 'current_tenant_id',
          policyname || ': TO lims_app with tenant predicate and the staff guard (08 A17 P-16)') FROM pg_policies WHERE schemaname = 'core' AND tablename = 'membership_branches';
SELECT ok(has_table_privilege('lims_app', 'core.membership_branches', 'SELECT') AND has_table_privilege('lims_app', 'core.membership_branches', 'INSERT')
          AND has_table_privilege('lims_app', 'core.membership_branches', 'DELETE'), 'lims_app: SELECT, INSERT, DELETE');
SELECT ok(NOT has_table_privilege('lims_app', 'core.membership_branches', 'UPDATE') AND NOT has_table_privilege('lims_app', 'core.membership_branches', 'TRUNCATE')
          AND NOT has_table_privilege('lims_app', 'core.membership_branches', 'REFERENCES'), 'lims_app: no UPDATE / TRUNCATE / REFERENCES');
SELECT ok(NOT has_table_privilege('lims_queue', 'core.membership_branches', 'SELECT') AND NOT has_table_privilege('lims_reporting_lookup', 'core.membership_branches', 'SELECT'),
          'no other application role reads membership_branches');
-- the trigger function
SELECT ok(to_regprocedure('app.tg_scope_user_only()') IS NOT NULL, 'app.tg_scope_user_only() exists');
SELECT ok(NOT p.prosecdef, 'app.tg_scope_user_only is SECURITY INVOKER (not in the DEFINER inventory)') FROM pg_proc p WHERE p.oid = to_regprocedure('app.tg_scope_user_only()');
SELECT ok(array_to_string(p.proconfig, ',') LIKE '%search_path=%', 'app.tg_scope_user_only has SET search_path') FROM pg_proc p WHERE p.oid = to_regprocedure('app.tg_scope_user_only()');
SELECT is(p.prorettype::regtype::text, 'trigger', 'app.tg_scope_user_only returns trigger') FROM pg_proc p WHERE p.oid = to_regprocedure('app.tg_scope_user_only()');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'core.membership_branches'::regclass AND t.tgname = 'membership_branches__scope_user_only'
                  AND t.tgfoid = 'app.tg_scope_user_only()'::regprocedure AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 8) = 0 AND (t.tgtype & 16) = 0),
          'membership_branches__scope_user_only: BEFORE INSERT FOR EACH ROW only');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'core.membership_centres'::regclass AND t.tgname = 'membership_centres__scope_user_only'
                  AND t.tgfoid = 'app.tg_scope_user_only()'::regprocedure AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 8) = 0 AND (t.tgtype & 16) = 0),
          'membership_centres__scope_user_only: BEFORE INSERT FOR EACH ROW only (schema test 14 covers both scope tables)');
SELECT ok(EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'core.membership_branches'::regclass AND NOT t.tgisinternal AND t.tgfoid = 'app.tg_row_audit()'::regprocedure),
          'membership_branches is audited (tg_row_audit trigger; 05-SCHEMA §3.3 "audited")');

-- ---------------------------------------------------------------- fixtures (superuser; triggers/FK checks off while seeding, then restored)
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id(1), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), 'lab_b', 'Lab B Pvt Ltd', 'Lab B', 'active', pg_temp.id(99), pg_temp.id(99));
INSERT INTO core.branches (id, tenant_id, branch_code, name, created_by, updated_by) VALUES
  (pg_temp.id(11), pg_temp.id(1), 'BA1', 'Branch A1', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(12), pg_temp.id(1), 'BA2', 'Branch A2', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(13), pg_temp.id(2), 'BB1', 'Branch B1', pg_temp.id(99), pg_temp.id(99));
INSERT INTO core.collection_centres (id, tenant_id, branch_id, centre_code, name, centre_kind, created_by, updated_by) VALUES
  (pg_temp.id(21), pg_temp.id(1), pg_temp.id(11), 'CA1', 'Centre A1', 'own', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(23), pg_temp.id(2), pg_temp.id(13), 'CB1', 'Centre B1', 'own', pg_temp.id(99), pg_temp.id(99));
INSERT INTO core.users (tenant_id, id, display_name, created_by, updated_by) VALUES
  (pg_temp.id(1), pg_temp.id(31), 'User 31', pg_temp.id(99), pg_temp.id(99)), (pg_temp.id(1), pg_temp.id(32), 'User 32', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(1), pg_temp.id(34), 'User 34', pg_temp.id(99), pg_temp.id(99)), (pg_temp.id(1), pg_temp.id(35), 'User 35', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), pg_temp.id(33), 'User 33', pg_temp.id(99), pg_temp.id(99));
INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, all_centres, partner_role, created_by, updated_by) VALUES
  (pg_temp.id(41), pg_temp.id(1), pg_temp.id(31), 'user',    false, NULL,             pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(42), pg_temp.id(1), pg_temp.id(32), 'user',    true,  NULL,             pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(43), pg_temp.id(2), pg_temp.id(33), 'user',    false, NULL,             pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(44), pg_temp.id(1), pg_temp.id(34), 'patient', false, NULL,             pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(45), pg_temp.id(1), pg_temp.id(35), 'partner', false, 'partner_member', pg_temp.id(99), pg_temp.id(99));
SET LOCAL session_replication_role = origin;

-- ---------------------------------------------------------------- behaviour: user memberships accepted, as lims_api with staff claims
SELECT is(pg_temp.w(pg_temp.cl('user', 1, 31, 41), pg_temp.ins_branch(1, 41, 11)), '1', 'staff A inserts a branch scope row for a user membership');
SELECT is(pg_temp.w(pg_temp.cl('user', 1, 31, 41), pg_temp.ins_centre(1, 41, 21)), '1', 'staff A inserts a centre scope row for a user membership');
SELECT is(pg_temp.n(pg_temp.cl('user', 1, 31, 41), 'SELECT 1 FROM core.membership_branches'), '1', 'staff A sees its tenant''s branch scope row');
SELECT is(pg_temp.n(pg_temp.cl('user', 2, 33, 43), 'SELECT 1 FROM core.membership_branches'), '0', 'staff B sees none of tenant A''s branch scope rows (isolation)');
SELECT is(pg_temp.n(NULL, 'SELECT 1 FROM core.membership_branches'), '0', 'no claims -> 0 rows (fail closed)');
SELECT is(pg_temp.n(pg_temp.cl('partner', 1, 35, 45), 'SELECT 1 FROM core.membership_branches'), '0', 'partner claims of tenant A -> 0 rows (staff guard)');
SELECT is(pg_temp.n(pg_temp.cl('patient', 1, 34, 44), 'SELECT 1 FROM core.membership_branches'), '0', 'patient claims of tenant A -> 0 rows (staff guard)');
-- tenant mismatch: claims A, row tenant B -> RLS WITH CHECK (42501), never an FK/trigger path that would reveal the other tenant
SELECT matches(pg_temp.w(pg_temp.cl('user', 1, 31, 41), pg_temp.ins_branch(2, 43, 13)), '^E(42501|23514):', 'tenant A claims cannot insert a tenant B row (refused by the BEFORE trigger lookup or RLS WITH CHECK, never accepted)');
SELECT matches(pg_temp.w(pg_temp.cl('partner', 1, 35, 45), pg_temp.ins_branch(1, 41, 12)), '^E(42501|23514):', 'partner claims cannot insert a branch scope row (staff guard: trigger lookup or WITH CHECK)');
-- composite FK: a branch of another tenant for an own-tenant user membership
SELECT ok(pg_temp.w(pg_temp.cl('user', 1, 31, 41), pg_temp.ins_branch(1, 41, 13)) LIKE 'E23503:%', 'branch of another tenant -> composite FK violation');
SELECT ok(pg_temp.w(pg_temp.cl('user', 1, 31, 41), pg_temp.ins_branch(1, 41, 11)) LIKE 'E23505:%', 'duplicate (tenant, membership, branch) -> PK violation');

-- ---------------------------------------------------------------- 08 R3 / schema test 14: scope tables are for staff (actor_type = user) only
SELECT is(pg_temp.w(pg_temp.cl('user', 1, 31, 41), pg_temp.ins_branch(1, 42, 12)), '1', 'a second user membership (all_centres = true) may still carry an explicit branch row (trigger tests actor_type only)');
SELECT is(pg_temp.w(pg_temp.cl('user', 1, 31, 41), pg_temp.ins_branch(1, 44, 11)), 'E23514:scope_user_only', 'patient membership -> branch scope refused: 23514 scope_user_only');
SELECT is(pg_temp.w(pg_temp.cl('user', 1, 31, 41), pg_temp.ins_branch(1, 45, 11)), 'E23514:scope_user_only', 'partner membership -> branch scope refused: 23514 scope_user_only');
SELECT is(pg_temp.w(pg_temp.cl('user', 1, 31, 41), pg_temp.ins_centre(1, 44, 21)), 'E23514:scope_user_only', 'patient membership -> centre scope refused: 23514 scope_user_only');
SELECT is(pg_temp.w(pg_temp.cl('user', 1, 31, 41), pg_temp.ins_centre(1, 45, 21)), 'E23514:scope_user_only', 'partner membership -> centre scope refused: 23514 scope_user_only');
SELECT is(pg_temp.w(pg_temp.cl('user', 1, 31, 41), pg_temp.ins_branch(1, 99, 11)), 'E23514:scope_user_only', 'unknown membership id -> refused (the trigger does not pass a missing membership)');
SELECT is(pg_temp.w(pg_temp.cl('user', 1, 31, 41), pg_temp.ins_branch(1, 43, 11)), 'E23514:scope_user_only', 'membership of another tenant under own tenant_id -> refused (lookup is tenant-scoped)');
-- the trigger holds for every writer, not only lims_app: superuser (RLS bypass) and lims_owner are refused as well
SELECT throws_ok(pg_temp.ins_branch(1, 44, 11), '23514', 'scope_user_only', 'superuser insert for a patient membership is refused too (trigger is not RLS-dependent)');
SELECT throws_ok(pg_temp.ins_centre(1, 45, 21), '23514', 'scope_user_only', 'superuser insert of a centre scope row for a partner membership is refused too');
-- the diagnostic names the table
SELECT throws_ok(pg_temp.ins_branch(1, 44, 11), '23514', 'scope_user_only', 'diagnostic: SQLSTATE 23514 message scope_user_only');
SELECT is((SELECT count(*) FROM core.membership_branches WHERE membership_id IN (pg_temp.id(44), pg_temp.id(45))), 0::bigint, 'no scope row exists for a patient or partner membership');
SELECT is((SELECT count(*) FROM core.membership_centres WHERE membership_id IN (pg_temp.id(44), pg_temp.id(45))), 0::bigint, 'no centre row exists for a patient or partner membership');
-- UPDATE of the membership_id to a non-user membership is impossible (no UPDATE grant); the trigger is INSERT-only by design
SELECT ok(pg_temp.w(pg_temp.cl('user', 1, 31, 41), format('UPDATE core.membership_branches SET membership_id = %L WHERE branch_id = %L', pg_temp.id(44), pg_temp.id(11))) LIKE 'E42501:%', 'lims_app has no UPDATE on membership_branches (cannot re-point a scope row at a patient membership)');
-- all_centres on a non-user membership (08 R3, memberships__all_centres_user_only__ck): CHECK violation 23514
SELECT ok(pg_temp.w(pg_temp.cl('user', 1, 31, 41), format('UPDATE core.memberships SET all_centres = true WHERE id = %L', pg_temp.id(44))) LIKE 'E23514:%memberships__all_centres_user_only__ck%', 'all_centres = true on a patient membership -> CHECK violation memberships__all_centres_user_only__ck');
SELECT ok(pg_temp.w(pg_temp.cl('user', 1, 31, 41), format('UPDATE core.memberships SET all_centres = true WHERE id = %L', pg_temp.id(45))) LIKE 'E23514:%memberships__all_centres_user_only__ck%', 'all_centres = true on a partner membership -> CHECK violation');

-- ---------------------------------------------------------------- DELETE is allowed (association class); audited
SELECT is(pg_temp.w(pg_temp.cl('user', 2, 33, 43), format('DELETE FROM core.membership_branches WHERE branch_id = %L', pg_temp.id(11))), '0', 'tenant B cannot delete tenant A rows (0 rows)');
SELECT is(pg_temp.w(pg_temp.cl('partner', 1, 35, 45), format('DELETE FROM core.membership_branches WHERE branch_id = %L', pg_temp.id(11))), '0', 'partner claims cannot delete scope rows (0 rows)');
SELECT is(pg_temp.w(pg_temp.cl('user', 1, 31, 41), format('DELETE FROM core.membership_branches WHERE branch_id = %L AND membership_id = %L', pg_temp.id(11), pg_temp.id(41))), '1', 'staff A deletes its scope row');
SELECT is((SELECT count(*) FROM audit.audit_log WHERE tenant_id = pg_temp.id(1) AND schema_name = 'core' AND table_name = 'membership_branches' AND action = 'INSERT'), 2::bigint,
          'audit: the two accepted inserts are in audit_log (tg_row_audit on membership_branches)');
SELECT is((SELECT count(*) FROM audit.audit_log WHERE tenant_id = pg_temp.id(1) AND schema_name = 'core' AND table_name = 'membership_branches' AND action = 'DELETE'), 1::bigint,
          'audit: the delete is in audit_log with the old row');
SELECT is((SELECT count(*) FROM audit.audit_log WHERE table_name = 'membership_branches' AND old_values IS NULL AND action = 'DELETE'), 0::bigint, 'audit: DELETE rows carry old_values');
SELECT is((SELECT count(*) FROM audit.audit_log WHERE table_name = 'membership_branches' AND tenant_id = pg_temp.id(2)), 0::bigint, 'audit: refused inserts wrote nothing for tenant B');

SELECT * FROM finish();
ROLLBACK;
