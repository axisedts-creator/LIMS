-- T0B-03 live-DB assertions, part 3: audit triggers, enforce_mutable_columns, maintenance + NULL-tenant audit
-- (AC-0B-5.1, 5.2, 5.3; 05-SCHEMA §10 schema tests 18, 20, 25, 28, 32; 08 A12.5, A15.5, A20.3, A25 D-215, A28.5). Synthetic data only.
-- Run: pg_prove -d <db> db/tests/core/T0B-03_audit.test.sql   (pgTAP in schema `extensions`; one rolled-back txn; RLS is never disabled)
-- Stand-in tables (core.t0b03_*) are created as lims_owner with ENABLE + FORCE RLS and the real tenant/staff-guard policies shape.
-- Platform-context audit (test 18) needs identity.platform_staff (C2, T0B-06): a minimal FORCE-RLS stub is created only when the table is absent;
-- when the real table exists those assertions are skipped here (its fixture rows are T0B-06's).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-0000000000' || lpad(k, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.cl(p_type text, p_tenant text DEFAULT NULL, p_sub text DEFAULT '99', p_mem text DEFAULT NULL, p_extra jsonb DEFAULT '{}') RETURNS text
LANGUAGE sql AS $$ SELECT (jsonb_strip_nulls(jsonb_build_object('actor_type', p_type, 'tenant_id', pg_temp.id(p_tenant), 'sub', pg_temp.id(p_sub),
  'membership_id', pg_temp.id(p_mem))) || p_extra)::text $$;
CREATE FUNCTION pg_temp.as_x(p_role text, p_claims text, p_sql text, p_mode text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := 'v=' || coalesce(r, '<null>');
    ELSIF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := 'n=' || n;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := 'n=' || n; END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.w(c text, s text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.as_x('lims_api', c, s, 'w') $$;
CREATE FUNCTION pg_temp.uA() RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.cl('user', '01', '31', '41') $$;
CREATE FUNCTION pg_temp.claims(c text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claims', coalesce(c, ''), true) $$;

-- ---------- fixtures ----------
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id('01'), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active', pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('02'), 'lab_b', 'Lab B Pvt Ltd', 'Lab B', 'active', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.branches (id, tenant_id, branch_code, name, created_by, updated_by) VALUES (pg_temp.id('11'), pg_temp.id('01'), 'BA', 'Branch A', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.collection_centres (id, tenant_id, branch_id, centre_code, name, centre_kind, created_by, updated_by) VALUES
  (pg_temp.id('21'), pg_temp.id('01'), pg_temp.id('11'), 'CA1', 'Centre A1', 'own', pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('22'), pg_temp.id('01'), pg_temp.id('11'), 'CA2', 'Centre A2', 'own', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.users (tenant_id, id, display_name, created_by, updated_by) VALUES
  (pg_temp.id('01'), pg_temp.id('31'), 'User 31', pg_temp.id('99'), pg_temp.id('99')), (pg_temp.id('01'), pg_temp.id('32'), 'User 32', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, all_centres, created_by, updated_by) VALUES
  (pg_temp.id('41'), pg_temp.id('01'), pg_temp.id('31'), 'user', false, pg_temp.id('99'), pg_temp.id('99')),
  (pg_temp.id('42'), pg_temp.id('01'), pg_temp.id('32'), 'user', false, pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.membership_centres (tenant_id, membership_id, centre_id, created_by) VALUES (pg_temp.id('01'), pg_temp.id('41'), pg_temp.id('21'), pg_temp.id('99'));
SET LOCAL session_replication_role = origin;

-- ---------- request context (copied into audit rows) ----------
DO $$ BEGIN PERFORM set_config('app.request_id', pg_temp.id('a0')::text, true), set_config('app.client_ip', '203.0.113.7', true), set_config('app.user_agent', 'pgtap/1.0', true); END $$;

-- ---------- stand-in tables (owner lims_owner, ENABLE + FORCE RLS, staff-guarded tenant policies) ----------
SET LOCAL ROLE lims_owner;
CREATE TABLE core.t0b03_audited   (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, centre_id uuid, note text, secret text,
                                    updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 1);
CREATE TABLE core.t0b03_audited_x (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, note text, secret text,
                                    updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 1);
CREATE TABLE core.t0b03_immutable (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, status text, note text);
CREATE TABLE core.t0b03_mutable_status (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, status text, note text);
CREATE TABLE core.t0b03_mixed     (id uuid PRIMARY KEY, tenant_id uuid, note text);
ALTER TABLE core.t0b03_audited ENABLE ROW LEVEL SECURITY;        ALTER TABLE core.t0b03_audited FORCE ROW LEVEL SECURITY;
ALTER TABLE core.t0b03_audited_x ENABLE ROW LEVEL SECURITY;      ALTER TABLE core.t0b03_audited_x FORCE ROW LEVEL SECURITY;
ALTER TABLE core.t0b03_immutable ENABLE ROW LEVEL SECURITY;      ALTER TABLE core.t0b03_immutable FORCE ROW LEVEL SECURITY;
ALTER TABLE core.t0b03_mutable_status ENABLE ROW LEVEL SECURITY; ALTER TABLE core.t0b03_mutable_status FORCE ROW LEVEL SECURITY;
ALTER TABLE core.t0b03_mixed ENABLE ROW LEVEL SECURITY;          ALTER TABLE core.t0b03_mixed FORCE ROW LEVEL SECURITY;
DO $do$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['t0b03_audited','t0b03_audited_x','t0b03_immutable','t0b03_mutable_status','t0b03_mixed'] LOOP
    EXECUTE format($p$CREATE POLICY %1$s__select__tenant ON core.%1$s FOR SELECT TO lims_app USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$s__insert__tenant ON core.%1$s FOR INSERT TO lims_app WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))$p$, t);
    EXECUTE format($p$CREATE POLICY %1$s__update__tenant ON core.%1$s FOR UPDATE TO lims_app USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
      WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON core.%I TO lims_app', t);
  END LOOP;
END $do$;
-- owner policies for the maintenance DEFINER stand-in (gated on app.maintenance, like the C2 identity_expire_* shape)
CREATE POLICY t0b03_audited__select__owner_only ON core.t0b03_audited FOR SELECT TO lims_owner USING (current_setting('app.maintenance', true) = 't0b03_maint');
CREATE POLICY t0b03_audited__update__owner_only ON core.t0b03_audited FOR UPDATE TO lims_owner
  USING (current_setting('app.maintenance', true) = 't0b03_maint') WITH CHECK (current_setting('app.maintenance', true) = 't0b03_maint');
CREATE TRIGGER t0b03_audited__audit AFTER INSERT OR UPDATE OR DELETE ON core.t0b03_audited FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER t0b03_audited_x__audit AFTER INSERT OR UPDATE OR DELETE ON core.t0b03_audited_x FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit('secret');
CREATE TRIGGER t0b03_mixed__audit AFTER INSERT OR UPDATE OR DELETE ON core.t0b03_mixed FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER t0b03_immutable__guard BEFORE UPDATE ON core.t0b03_immutable FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns();
CREATE TRIGGER t0b03_mutable_status__guard BEFORE UPDATE ON core.t0b03_mutable_status FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns('status');
CREATE FUNCTION core.t0b03_maint_fn() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $m$
DECLARE n integer;
BEGIN
  PERFORM set_config('app.maintenance', 't0b03_maint', true);
  UPDATE core.t0b03_audited SET note = 'maintained' WHERE note IS DISTINCT FROM 'maintained';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('app.maintenance', '', true);
  RETURN n;
END $m$;
REVOKE ALL ON FUNCTION core.t0b03_maint_fn() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.t0b03_maint_fn() TO lims_worker;
RESET ROLE;

-- ================= AC-0B-5.1: INSERT is audited with the full context =================
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.branches (id, tenant_id, branch_code, name, created_by, updated_by) VALUES (%L, %L, 'BN', 'Branch N', %L, %L)$$,
  pg_temp.id('b1'), pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 'n=1', 'branch inserted by tenant-A staff');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), 1, 'AC-0B-5.1: exactly one audit row for the INSERT');
SELECT is((SELECT action FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), 'INSERT', 'action = INSERT');
SELECT is((SELECT schema_name || '.' || table_name FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), 'core.branches', 'schema_name / table_name');
SELECT is((SELECT tenant_id FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), pg_temp.id('01'), 'tenant_id = the audited row''s tenant');
SELECT is((SELECT actor_id FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), pg_temp.id('31'), 'actor_id = claims sub');
SELECT is((SELECT created_by FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), pg_temp.id('31'), 'created_by = actor_id');
SELECT is((SELECT actor_type FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), 'user', 'actor_type = claims actor_type');
SELECT is((SELECT membership_id FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), pg_temp.id('41'), 'membership_id = claims membership_id');
SELECT is((SELECT request_id FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), pg_temp.id('a0'), 'request_id = app.request_id');
SELECT is((SELECT host(client_ip) FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), '203.0.113.7', 'client_ip = app.client_ip');
SELECT is((SELECT user_agent FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), 'pgtap/1.0', 'user_agent = app.user_agent');
SELECT is((SELECT detail FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), NULL::jsonb, 'detail is NULL for a claims-driven row');
SELECT is((SELECT changed_columns FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), '{}'::text[], 'INSERT: changed_columns = {}');
SELECT is((SELECT old_values FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), NULL::jsonb, 'INSERT: old_values NULL');
SELECT is((SELECT new_values ->> 'branch_code' FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), 'BN', 'INSERT: new_values holds the row');
SELECT is((SELECT new_values - ARRAY['created_at','updated_at'] FROM audit.audit_log WHERE row_id = pg_temp.id('b1')),
  (SELECT to_jsonb(b) - ARRAY['created_at','updated_at'] FROM core.branches b WHERE b.id = pg_temp.id('b1')), 'INSERT: new_values = the full new row (schema test 20)');
SELECT is((SELECT occurred_at = created_at FROM audit.audit_log WHERE row_id = pg_temp.id('b1')), true, 'created_at = occurred_at');

-- centre_id is copied when the audited row has one (stand-in with a centre_id column)
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.t0b03_audited (id, tenant_id, centre_id, note, secret) VALUES (%L, %L, %L, 'n0', 's0')$$,
  pg_temp.id('ab'), pg_temp.id('01'), pg_temp.id('21'))), 'n=1', 'stand-in row with centre_id inserted');
SELECT is((SELECT centre_id FROM audit.audit_log WHERE row_id = pg_temp.id('ab') AND action = 'INSERT'), pg_temp.id('21'), 'AC-0B-5.1: centre_id copied from the audited row');

-- ================= AC-0B-5.2 / schema test 20: UPDATE records changed columns only =================
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.branches SET name = 'Renamed', address_text = 'Addr 1' WHERE id = %L$$, pg_temp.id('b1'))), 'n=1', 'two-column UPDATE');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE row_id = pg_temp.id('b1') AND action = 'UPDATE'), 1, 'AC-0B-5.1: exactly one audit row for the UPDATE');
SELECT is((SELECT changed_columns FROM audit.audit_log WHERE row_id = pg_temp.id('b1') AND action = 'UPDATE'), ARRAY['address_text','name'], 'AC-0B-5.2: changed_columns lists exactly the changed columns');
SELECT is((SELECT old_values FROM audit.audit_log WHERE row_id = pg_temp.id('b1') AND action = 'UPDATE'), jsonb_build_object('name', 'Branch N', 'address_text', NULL), 'AC-0B-5.2: old_values = changed columns only');
SELECT is((SELECT new_values FROM audit.audit_log WHERE row_id = pg_temp.id('b1') AND action = 'UPDATE'), jsonb_build_object('name', 'Renamed', 'address_text', 'Addr 1'), 'AC-0B-5.2: new_values = changed columns only');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.branches SET version = version + 1, updated_at = now() + interval '1 second', updated_by = %L WHERE id = %L$$, pg_temp.id('32'), pg_temp.id('b1'))),
  'n=1', 'UPDATE of bookkeeping columns only');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE row_id = pg_temp.id('b1') AND action = 'UPDATE'), 1, 'schema test 20: updated_at / updated_by / version only -> no audit row');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.branches SET name = name WHERE id = %L$$, pg_temp.id('b1'))), 'n=1', 'no-op UPDATE');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE row_id = pg_temp.id('b1') AND action = 'UPDATE'), 1, 'schema test 20: no-op UPDATE -> no audit row');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.t0b03_audited SET secret = 's1' WHERE id = %L$$, pg_temp.id('ab'))), 'n=1', 'argument-less trigger: secret column is audited');
SELECT is((SELECT changed_columns FROM audit.audit_log WHERE row_id = pg_temp.id('ab') AND action = 'UPDATE'), ARRAY['secret'], 'argument-less trigger records secret in changed_columns');

-- DELETE records the full old row; association tables have no id (row_id NULL)
SELECT is(pg_temp.w(pg_temp.uA(), format($$DELETE FROM core.membership_centres WHERE membership_id = %L AND centre_id = %L$$, pg_temp.id('41'), pg_temp.id('21'))), 'n=1', 'DELETE membership_centres');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE table_name = 'membership_centres' AND action = 'DELETE'), 1, 'one audit row for the DELETE');
SELECT is((SELECT old_values ->> 'centre_id' FROM audit.audit_log WHERE table_name = 'membership_centres' AND action = 'DELETE'), pg_temp.id('21')::text, 'DELETE: old_values holds the full old row');
SELECT is((SELECT new_values FROM audit.audit_log WHERE table_name = 'membership_centres' AND action = 'DELETE'), NULL::jsonb, 'DELETE: new_values NULL');
SELECT is((SELECT row_id FROM audit.audit_log WHERE table_name = 'membership_centres' AND action = 'DELETE'), NULL::uuid, 'association table: row_id NULL');
SELECT is((SELECT changed_columns FROM audit.audit_log WHERE table_name = 'membership_centres' AND action = 'DELETE'), '{}'::text[], 'DELETE: changed_columns = {}');
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.membership_centres (tenant_id, membership_id, centre_id, created_by) VALUES (%L, %L, %L, %L)$$,
  pg_temp.id('01'), pg_temp.id('42'), pg_temp.id('22'), pg_temp.id('31'))), 'n=1', 'INSERT membership_centres');
SELECT is((SELECT new_values ->> 'membership_id' FROM audit.audit_log WHERE table_name = 'membership_centres' AND action = 'INSERT'), pg_temp.id('42')::text, 'INSERT of an association row: new_values = full row');

-- excluded-column argument (CR-C15-013): the column never reaches audit_log
SELECT is(pg_temp.w(pg_temp.uA(), format($$INSERT INTO core.t0b03_audited_x (id, tenant_id, note, secret) VALUES (%L, %L, 'x0', 'TOP-SECRET')$$, pg_temp.id('ac'), pg_temp.id('01'))), 'n=1', 'excluded-arg stand-in insert');
SELECT is((SELECT new_values ? 'secret' FROM audit.audit_log WHERE row_id = pg_temp.id('ac') AND action = 'INSERT'), false, 'excluded column absent from new_values');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.t0b03_audited_x SET secret = 'TOP-SECRET-2' WHERE id = %L$$, pg_temp.id('ac'))), 'n=1', 'update of the excluded column only');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE row_id = pg_temp.id('ac') AND action = 'UPDATE'), 0, 'excluded-only update writes no audit row');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.t0b03_audited_x SET note = 'x1', secret = 'TOP-SECRET-3' WHERE id = %L$$, pg_temp.id('ac'))), 'n=1', 'update of note + excluded column');
SELECT is((SELECT changed_columns FROM audit.audit_log WHERE row_id = pg_temp.id('ac') AND action = 'UPDATE'), ARRAY['note'], 'excluded column absent from changed_columns');
SELECT is((SELECT old_values::text || new_values::text FROM audit.audit_log WHERE row_id = pg_temp.id('ac') AND action = 'UPDATE') !~ 'TOP-SECRET', true, 'excluded value absent from old_values / new_values');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE (old_values::text || new_values::text) ~ 'TOP-SECRET'), 0, 'excluded value appears nowhere in audit_log');

-- ================= AC-0B-5.3: lims_app / lims_api cannot write audit_log =================
SELECT is(left(pg_temp.w(pg_temp.uA(), format($$INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_id, actor_type, created_by)
  VALUES (%L, %L, 'core', 'branches', 'INSERT', %L, 'user', %L)$$, pg_temp.id('f0'), pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31'))), 6), 'E42501', 'AC-0B-5.3: direct INSERT INTO audit.audit_log fails 42501');
SELECT is(left(pg_temp.w(pg_temp.uA(), $$UPDATE audit.audit_log SET table_name = 'x'$$), 6), 'E42501', 'audit_log UPDATE refused (no grant)');
SELECT is(left(pg_temp.w(pg_temp.uA(), $$DELETE FROM audit.audit_log$$), 6), 'E42501', 'audit_log DELETE refused (no grant)');
SELECT is(left(pg_temp.as_x('lims_worker', pg_temp.uA(), $$INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_type) VALUES (gen_random_uuid(), gen_random_uuid(), 'a', 'b', 'INSERT', 'user')$$, 'w'), 6),
  'E42501', 'lims_worker cannot INSERT into audit_log either');

-- ================= schema test 18: core.tenants audited under its own id =================
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.tenants SET display_name = 'Lab A 2' WHERE id = %L$$, pg_temp.id('01'))), 'n=1', 'tenant-claim UPDATE of the own tenant');
SELECT is((SELECT tenant_id || '|' || row_id FROM audit.audit_log WHERE schema_name = 'core' AND table_name = 'tenants' AND action = 'UPDATE' AND row_id = pg_temp.id('01')),
  pg_temp.id('01') || '|' || pg_temp.id('01'), 'test 18: tenant_id = row_id = the tenant''s id (tenant claims)');
SELECT is((SELECT changed_columns FROM audit.audit_log WHERE schema_name = 'core' AND table_name = 'tenants' AND row_id = pg_temp.id('01')), ARRAY['display_name'], 'test 18: changed_columns');

-- platform context (no tenant claim): stub identity.platform_staff only when C2's table does not exist yet
DO $do$ BEGIN
  IF to_regclass('identity.platform_staff') IS NULL THEN
    EXECUTE 'CREATE TABLE identity.platform_staff (id uuid PRIMARY KEY, user_id uuid NOT NULL, is_active boolean NOT NULL DEFAULT true)';
    EXECUTE 'ALTER TABLE identity.platform_staff OWNER TO lims_owner';
    EXECUTE 'ALTER TABLE identity.platform_staff ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE identity.platform_staff FORCE ROW LEVEL SECURITY';
    EXECUTE 'CREATE POLICY platform_staff__select__owner_only ON identity.platform_staff FOR SELECT TO lims_owner USING (true)';
    EXECUTE format('INSERT INTO identity.platform_staff (id, user_id) VALUES (%L, %L)', pg_temp.id('97'), pg_temp.id('98'));
    PERFORM set_config('t0b03.stub', 'on', true);
  ELSE
    PERFORM set_config('t0b03.stub', 'off', true);
  END IF;
END $do$;
SELECT skip('identity.platform_staff exists (C2/T0B-06): platform-context audit assertions run with its own fixtures there', 5) WHERE current_setting('t0b03.stub') = 'off';
SELECT pg_temp.claims(pg_temp.cl('user', NULL, '98', NULL, jsonb_build_object('scope', 'platform', 'aal', 'aal2', 'platform_staff_id', pg_temp.id('97')))) WHERE current_setting('t0b03.stub') = 'on';
SELECT lives_ok(format($$INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES (%L, 'lab_new', 'New Lab', 'New Lab', 'provisioning', %L, %L)$$,
  pg_temp.id('e1'), pg_temp.id('98'), pg_temp.id('98')), 'test 18: platform-context INSERT of core.tenants succeeds (audit insert admitted by the A12.5 branch)') WHERE current_setting('t0b03.stub') = 'on';
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'core' AND table_name = 'tenants' AND action = 'INSERT' AND tenant_id = pg_temp.id('e1') AND row_id = pg_temp.id('e1')), 1,
  'test 18: one audit row, tenant_id = row_id = the new tenant''s id') WHERE current_setting('t0b03.stub') = 'on';
SELECT lives_ok(format($$UPDATE core.tenants SET legal_name = 'New Lab Pvt' WHERE id = %L$$, pg_temp.id('e1')), 'test 18: platform-context UPDATE of core.tenants succeeds') WHERE current_setting('t0b03.stub') = 'on';
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'core' AND table_name = 'tenants' AND action = 'UPDATE' AND tenant_id = pg_temp.id('e1') AND row_id = pg_temp.id('e1')), 1,
  'test 18: one audit row for the platform UPDATE') WHERE current_setting('t0b03.stub') = 'on';
SELECT pg_temp.claims(pg_temp.cl('user', NULL, '98', NULL, jsonb_build_object('scope', 'platform', 'aal', 'aal1', 'platform_staff_id', pg_temp.id('97')))) WHERE current_setting('t0b03.stub') = 'on';
SELECT throws_ok(format($$UPDATE core.tenants SET legal_name = 'Nope' WHERE id = %L$$, pg_temp.id('e1')), '42501', NULL,
  'test 18 guard: platform claims with aal1 -> the audit insert is refused (is_platform_actor false)') WHERE current_setting('t0b03.stub') = 'on';
SELECT pg_temp.claims('');

-- ================= schema test 28: NULL-tenant rows of a mixed table are not audited =================
SELECT pg_temp.claims(pg_temp.cl('user', NULL, '98', NULL, jsonb_build_object('scope', 'platform', 'aal', 'aal2', 'platform_staff_id', pg_temp.id('97'))));
SELECT lives_ok(format($$INSERT INTO core.t0b03_mixed (id, tenant_id, note) VALUES (%L, NULL, 'platform row')$$, pg_temp.id('d0')), 'test 28: NULL-tenant INSERT raises nothing');
SELECT lives_ok(format($$UPDATE core.t0b03_mixed SET note = 'changed' WHERE id = %L$$, pg_temp.id('d0')), 'test 28: NULL-tenant UPDATE raises nothing');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE table_name = 't0b03_mixed'), 0, 'test 28: 0 audit rows for the NULL-tenant INSERT + UPDATE');
SELECT pg_temp.claims(pg_temp.uA());
SELECT lives_ok(format($$INSERT INTO core.t0b03_mixed (id, tenant_id, note) VALUES (%L, %L, 'tenant row')$$, pg_temp.id('d1'), pg_temp.id('01')), 'test 28: tenant-row INSERT');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE table_name = 't0b03_mixed'), 1, 'test 28: the tenant-row INSERT writes 1 audit row');
SELECT is((SELECT tenant_id FROM audit.audit_log WHERE table_name = 't0b03_mixed'), pg_temp.id('01'), 'test 28: ... under the row''s tenant');
SELECT pg_temp.claims('');
-- the skip happens before the context check: a NULL-tenant write with neither claims nor maintenance raises nothing
SELECT lives_ok(format($$INSERT INTO core.t0b03_mixed (id, tenant_id, note) VALUES (%L, NULL, 'no ctx')$$, pg_temp.id('d2')), 'D-215: NULL-tenant row with no claims and no maintenance does not raise audit_context_missing');

-- ================= schema test 32: maintenance audit =================
SELECT is(pg_temp.as_x('lims_worker', '', 'SELECT core.t0b03_maint_fn()::text', 'v'), 'v=1', 'maintenance DEFINER called by lims_worker with no claims updates the audited tenant row');
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE table_name = 't0b03_audited' AND detail IS NOT NULL), 1, 'test 32: one maintenance audit row');
SELECT is((SELECT tenant_id FROM audit.audit_log WHERE table_name = 't0b03_audited' AND detail IS NOT NULL), pg_temp.id('01'), 'test 32: the row''s tenant_id');
SELECT is((SELECT actor_type FROM audit.audit_log WHERE table_name = 't0b03_audited' AND detail IS NOT NULL), 'system', 'test 32: actor_type = system');
SELECT is((SELECT actor_id FROM audit.audit_log WHERE table_name = 't0b03_audited' AND detail IS NOT NULL), NULL::uuid, 'test 32: actor_id NULL');
SELECT is((SELECT created_by FROM audit.audit_log WHERE table_name = 't0b03_audited' AND detail IS NOT NULL), NULL::uuid, 'test 32: created_by NULL');
SELECT is((SELECT detail FROM audit.audit_log WHERE table_name = 't0b03_audited' AND detail IS NOT NULL), '{"maintenance": "t0b03_maint"}'::jsonb, 'test 32: detail = {"maintenance": "<function name>"}');
SELECT is((SELECT action FROM audit.audit_log WHERE table_name = 't0b03_audited' AND detail IS NOT NULL), 'UPDATE', 'test 32: action UPDATE');
SELECT is(current_setting('app.maintenance', true), '', 'test 32: app.maintenance is empty after the function returns');
SELECT throws_ok(format($$UPDATE core.t0b03_audited SET note = 'no context' WHERE id = %L$$, pg_temp.id('ab')), 'P0001', 'audit_context_missing', 'test 32: neither claims nor app.maintenance -> audit_context_missing');
SELECT throws_ok(format($$INSERT INTO core.t0b03_audited (id, tenant_id, note) VALUES (%L, %L, 'no context')$$, pg_temp.id('ad'), pg_temp.id('01')), 'P0001', 'audit_context_missing', 'INSERT without context -> audit_context_missing');
SELECT throws_ok(format($$INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_type) VALUES (%L, %L, 'core', 'x', 'INSERT', 'system')$$, pg_temp.id('f1'), pg_temp.id('01')),
  '23514', NULL, 'audit_log__actor__ck: NULL actor_id without detail.maintenance is refused');
SELECT throws_ok(format($$INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_type, detail) VALUES (%L, %L, 'core', 'x', 'INSERT', 'user', '{"maintenance":"x"}')$$, pg_temp.id('f2'), pg_temp.id('01')),
  '23514', NULL, 'audit_log__actor__ck: NULL actor_id with a non-system actor_type is refused');
SELECT lives_ok(format($$INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_type, detail) VALUES (%L, %L, 'core', 'x', 'INSERT', 'system', '{"maintenance":"x"}')$$, pg_temp.id('f3'), pg_temp.id('01')),
  'audit_log__actor__ck: NULL actor_id + system + detail.maintenance is accepted');
SELECT throws_ok(format($$INSERT INTO audit.audit_log (id, tenant_id, schema_name, table_name, action, actor_id, actor_type, created_by) VALUES (%L, %L, 'core', 'x', 'TRUNCATE', %L, 'user', %L)$$,
  pg_temp.id('f4'), pg_temp.id('01'), pg_temp.id('31'), pg_temp.id('31')), '23514', NULL, 'audit_log__action__ck');

-- ================= schema test 25: enforce_mutable_columns with and without arguments =================
SET LOCAL session_replication_role = replica;
INSERT INTO core.t0b03_immutable (id, tenant_id, status, note) VALUES (pg_temp.id('c1'), pg_temp.id('01'), 'open', 'n');
INSERT INTO core.t0b03_mutable_status (id, tenant_id, status, note) VALUES (pg_temp.id('c2'), pg_temp.id('01'), 'open', 'n');
SET LOCAL session_replication_role = origin;
SELECT matches(pg_temp.w(pg_temp.uA(), format($$UPDATE core.t0b03_immutable SET note = 'x' WHERE id = %L$$, pg_temp.id('c1'))), '^EP0001:immutable_row', 'test 25: no arguments -> any change raises immutable_row');
SELECT matches(pg_temp.w(pg_temp.uA(), format($$UPDATE core.t0b03_immutable SET status = 'closed' WHERE id = %L$$, pg_temp.id('c1'))), '^EP0001:immutable_row', 'test 25: no arguments -> status change raises immutable_row');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.t0b03_immutable SET status = status, note = note WHERE id = %L$$, pg_temp.id('c1'))), 'n=1', 'test 25: an UPDATE that changes nothing passes');
SELECT is(pg_temp.w(pg_temp.uA(), format($$UPDATE core.t0b03_mutable_status SET status = 'closed' WHERE id = %L$$, pg_temp.id('c2'))), 'n=1', 'test 25: with argument ''status'' the status may change');
SELECT matches(pg_temp.w(pg_temp.uA(), format($$UPDATE core.t0b03_mutable_status SET note = 'x' WHERE id = %L$$, pg_temp.id('c2'))), '^EP0001:immutable_row', 'test 25: ... but note may not');
SELECT matches(pg_temp.w(pg_temp.uA(), format($$UPDATE core.t0b03_mutable_status SET status = 'again', note = 'y' WHERE id = %L$$, pg_temp.id('c2'))), '^EP0001:immutable_row', 'test 25: status + note together raises');
SELECT is((SELECT status || '/' || note FROM core.t0b03_mutable_status WHERE id = pg_temp.id('c2')), 'closed/n', 'test 25: failed updates changed nothing');

-- hygiene: the stand-ins really are under FORCE RLS
SELECT is(relforcerowsecurity AND relrowsecurity, true, 'stand-in ' || relname || ' is ENABLE + FORCE RLS')
  FROM pg_class WHERE oid IN ('core.t0b03_audited'::regclass, 'core.t0b03_audited_x'::regclass, 'core.t0b03_immutable'::regclass, 'core.t0b03_mutable_status'::regclass, 'core.t0b03_mixed'::regclass);

SELECT * FROM finish();
ROLLBACK;
