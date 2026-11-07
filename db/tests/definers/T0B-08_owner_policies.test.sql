-- T0B-08 owner-policy suite, GUC-bound part (08 A10.5, A12.1-A12.7, A15.3; 05-SCHEMA §4.3 GUC rule; §10 schema tests 15, 16(b), 17, 22(tail), 29; AC-0B-2.4).
-- Proves the owner policies are TO lims_owner ONLY: an application session that sets the same GUC directly (app.pre_* / app.maintenance) sees nothing.
-- Objects of later tasks (T0B-05 platform tables, app.cron_tenant_ids, ...) are asserted only when they exist; otherwise an explicit pgTAP skip() is reported.
-- Re-run on the pinned supabase/postgres:17.6.1.136 image by db/tests/run-suites.sh (review C0 m#33). RLS is never disabled in this file.
-- Run from the repo root: pg_prove -d <db> db/tests/definers/T0B-08_owner_policies.test.sql   (superuser; pgTAP in schema `extensions`)
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.id(k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-0000000000' || lpad(k, 2, '0'))::uuid $$;
-- run p_sql as p_role with claims and session GUCs; mode n = count of a SELECT, w = rowcount of a write. Returns 'n=3' or 'E<sqlstate>:<msg>'.
CREATE FUNCTION pg_temp.as_g(p_role text, p_claims text, p_gucs jsonb, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; g record;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    FOR g IN SELECT key, value FROM jsonb_each_text(coalesce(p_gucs, '{}')) LOOP PERFORM set_config(g.key, g.value, true); END LOOP;
    IF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; END IF;
    r := 'n=' || n;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  FOR g IN SELECT key FROM jsonb_each_text(coalesce(p_gucs, '{}')) LOOP PERFORM set_config(g.key, '', true); END LOOP;
  RETURN r;
END $f$;
-- is() when the object exists, else an explicit skip (never a silent pass)
CREATE FUNCTION pg_temp.chk(p_exists boolean, p_got text, p_want text, p_descr text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT p_exists THEN RETURN skip('object not present yet: ' || p_descr, 1); END IF;
  RETURN is(p_got, p_want, p_descr);
END $f$;

-- ---------- fixtures: tenant A with one user / membership / role (core, T0B-03), written with triggers off ----------
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id('01'), 'lab_a', 'Lab A Pvt Ltd', 'Lab A', 'active', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.users (tenant_id, id, display_name, email_hmac, created_by, updated_by) VALUES
  (pg_temp.id('01'), pg_temp.id('31'), 'User 31', decode(repeat('cd', 32), 'hex'), pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, all_centres, created_by, updated_by) VALUES
  (pg_temp.id('41'), pg_temp.id('01'), pg_temp.id('31'), 'user', true, pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.roles (id, tenant_id, role_code, display_name, created_by, updated_by) VALUES
  (pg_temp.id('51'), pg_temp.id('01'), 'admin', 'Admin', pg_temp.id('99'), pg_temp.id('99'));
INSERT INTO core.membership_roles (tenant_id, membership_id, role_id, created_by) VALUES (pg_temp.id('01'), pg_temp.id('41'), pg_temp.id('51'), pg_temp.id('99'));
SET LOCAL session_replication_role = origin;

-- ---------- schema test 17: the five tables exist with FORCE RLS; a lims_api / lims_worker session setting app.pre_* itself sees 0 rows ----------
SELECT is(relforcerowsecurity, true, 'schema test 17: ' || relname || ' has relforcerowsecurity = true')
  FROM pg_class WHERE oid IN ('core.memberships'::regclass, 'core.users'::regclass, 'core.tenants'::regclass, 'core.roles'::regclass, 'core.membership_roles'::regclass);
SELECT is(pg_temp.as_g(r, NULL, jsonb_build_object('app.pre_user_id', pg_temp.id('31'), 'app.pre_tenant_id', pg_temp.id('01')), 'SELECT 1 FROM ' || t),
          'n=0', 'schema test 17: ' || r || ' setting app.pre_user_id / app.pre_tenant_id directly sees 0 rows of ' || t)
  FROM unnest(ARRAY['lims_api','lims_worker']) r, unnest(ARRAY['core.memberships','core.users','core.tenants','core.roles','core.membership_roles']) t;
-- ... also with a tenant-less claims document that is syntactically valid (a stripped token must not unlock the pre-tenant path)
SELECT is(pg_temp.as_g('lims_api', '{"actor_type":"user"}', jsonb_build_object('app.pre_user_id', pg_temp.id('31'), 'app.pre_tenant_id', pg_temp.id('01')), 'SELECT 1 FROM ' || t),
          'n=0', 'schema test 17: tenant-less claims plus GUCs still see 0 rows of ' || t)
  FROM unnest(ARRAY['core.memberships','core.users','core.tenants','core.roles','core.membership_roles']) t;
-- ... and the owner role itself sees them only through its GUC-bound predicate (GUC unset -> nothing)
SELECT is(pg_temp.as_g('lims_owner', NULL, NULL, 'SELECT 1 FROM ' || t), 'n=0', 'schema test 17: lims_owner with no GUC sees 0 rows of ' || t)
  FROM unnest(ARRAY['core.memberships','core.users','core.roles','core.membership_roles']) t;
SELECT is(pg_temp.as_g('lims_owner', NULL, jsonb_build_object('app.pre_user_id', pg_temp.id('31')), 'SELECT 1 FROM core.users'), 'n=1',
  'schema test 17: lims_owner with app.pre_user_id set sees exactly that user (policy is not dead)');
SELECT is(pg_temp.as_g('lims_owner', NULL, jsonb_build_object('app.pre_user_id', pg_temp.id('77')), 'SELECT 1 FROM core.users'), 'n=0',
  'schema test 17: lims_owner with an unknown app.pre_user_id sees 0 users');

-- ---------- app.maintenance set directly by an application session unlocks nothing (08 A12.2, A12.3) ----------
SELECT is(pg_temp.as_g(r, NULL, jsonb_build_object('app.maintenance', m), 'SELECT 1 FROM core.tenants'), 'n=0',
          'schema test 16(b)/22: ' || r || ' setting app.maintenance = ' || m || ' itself sees 0 core.tenants rows')
  FROM unnest(ARRAY['lims_api','lims_worker']) r, unnest(ARRAY['platform_list_tenants','cron_tenant_ids']) m;
SELECT is(pg_temp.as_g('lims_owner', NULL, jsonb_build_object('app.maintenance', 'cron_tenant_ids'), 'SELECT 1 FROM core.tenants'), 'n=1',
  'owner with app.maintenance = cron_tenant_ids sees the tenant (the function path works)');
SELECT is(pg_temp.as_g('lims_owner', NULL, jsonb_build_object('app.maintenance', 'some_other_function'), 'SELECT 1 FROM core.tenants'), 'n=0',
  'owner with another function''s app.maintenance name sees 0 tenants (08 A15.3: the GUC value is the function name)');
SELECT is(pg_temp.as_g('lims_worker', NULL, jsonb_build_object('app.maintenance', 'identity_tenants_for_email_hmacs'), 'SELECT 1 FROM core.users'), 'n=0',
  'schema test 29: lims_worker setting app.maintenance itself sees 0 core.users rows');
SELECT is(pg_temp.as_g('lims_api', NULL, jsonb_build_object('app.pre_tenant_code', 'lab_a'), 'SELECT 1 FROM core.tenants'), 'n=0',
  'schema test 29: lims_api setting app.pre_tenant_code itself sees 0 core.tenants rows');
SELECT is(pg_temp.as_g('lims_owner', NULL, jsonb_build_object('app.pre_tenant_code', 'lab_a'), 'SELECT 1 FROM core.tenants'), 'n=1',
  'schema test 29: owner with app.pre_tenant_code sees the tenant');

-- ---------- schema test 15 (owner SELECT predicates, platform tables of T0B-05) ----------
DO $do$ BEGIN
  IF to_regclass('core.dead_letters') IS NOT NULL AND to_regclass('core.event_log') IS NOT NULL AND to_regclass('core.idempotency_keys') IS NOT NULL THEN
    EXECUTE 'SET LOCAL session_replication_role = replica';
    EXECUTE format($i$INSERT INTO core.dead_letters (id, tenant_id, task_identifier, job_payload, last_error_code, last_error_message_redacted, attempts, first_failed_at, dead_at, state, resolved_by, resolved_at, created_by) VALUES
      (%1$L, NULL, 'core.t', '{}', 'E', 'm', 1, now() - interval '200 days', now() - interval '200 days', 'open', NULL, NULL, %3$L),
      (%2$L, %4$L, 'lab.t', '{}', 'E', 'm', 1, now() - interval '200 days', now() - interval '200 days', 'discarded', %3$L, now() - interval '100 days', %3$L),
      (%5$L, %4$L, 'lab.t', '{}', 'E', 'm', 1, now(), now(), 'open', NULL, NULL, %3$L)$i$,
      pg_temp.id('61'), pg_temp.id('62'), pg_temp.id('99'), pg_temp.id('01'), pg_temp.id('63'));
    EXECUTE format($i$INSERT INTO core.event_log (tenant_id, event_id, event_type, producer, idempotency_key, aggregate_type, aggregate_id, aggregate_seq, occurred_at, envelope, created_at, created_by) VALUES
      (%1$L, %2$L, 't.old', 'p', 'k1', 'x', %2$L, 1, now(), '{}', now() - interval '100 days', %3$L),
      (%1$L, %4$L, 't.new', 'p', 'k2', 'x', %4$L, 1, now(), '{}', now(), %3$L)$i$, pg_temp.id('01'), pg_temp.id('71'), pg_temp.id('99'), pg_temp.id('72'));
    EXECUTE format($i$INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, created_at, expires_at) VALUES
      (%1$L, %2$L, 'old', 'POST', '/x', decode(repeat('00', 32), 'hex'), 'in_progress', now() - interval '3 days', now() - interval '1 day'),
      (%1$L, %2$L, 'new', 'POST', '/x', decode(repeat('00', 32), 'hex'), 'in_progress', now(), now() + interval '1 day')$i$, pg_temp.id('01'), pg_temp.id('99'));
    EXECUTE 'SET LOCAL session_replication_role = origin';
  END IF;
END $do$;

-- GUC unset / '' / another function's name: dead_letters admits NULL-tenant rows only; the other three admit nothing
SELECT pg_temp.chk(to_regclass('core.dead_letters') IS NOT NULL, pg_temp.as_g('lims_owner', NULL, g, 'SELECT 1 FROM core.dead_letters'), 'n=1',
                   'schema test 15: dead_letters owner SELECT with app.maintenance ' || coalesce(g::text, 'unset') || ' admits the NULL-tenant row only')
  FROM unnest(ARRAY[NULL, '{"app.maintenance":""}', '{"app.maintenance":"purge_event_log"}']::jsonb[]) g;
SELECT pg_temp.chk(to_regclass(t) IS NOT NULL, pg_temp.as_g('lims_owner', NULL, g, 'SELECT 1 FROM ' || t), 'n=0',
                   'schema test 15: ' || t || ' owner SELECT with app.maintenance ' || coalesce(g::text, 'unset') || ' admits nothing')
  FROM unnest(ARRAY['core.event_log','core.idempotency_keys']) t, unnest(ARRAY[NULL, '{"app.maintenance":""}', '{"app.maintenance":"purge_dead_letters"}']::jsonb[]) g;
-- with the purge's own name: exactly the expired rows
SELECT pg_temp.chk(to_regclass('core.event_log') IS NOT NULL, pg_temp.as_g('lims_owner', NULL, '{"app.maintenance":"purge_event_log"}', 'SELECT 1 FROM core.event_log'), 'n=1',
                   'schema test 15: event_log owner SELECT with purge_event_log admits exactly the 90-day-old row');
SELECT pg_temp.chk(to_regclass('core.idempotency_keys') IS NOT NULL, pg_temp.as_g('lims_owner', NULL, '{"app.maintenance":"purge_idempotency_keys"}', 'SELECT 1 FROM core.idempotency_keys'), 'n=1',
                   'schema test 15: idempotency_keys owner SELECT with purge_idempotency_keys admits exactly the expired row');
SELECT pg_temp.chk(to_regclass('core.dead_letters') IS NOT NULL, pg_temp.as_g('lims_owner', NULL, '{"app.maintenance":"purge_dead_letters"}', 'SELECT 1 FROM core.dead_letters'), 'n=2',
                   'schema test 15: dead_letters owner SELECT with purge_dead_letters admits the NULL-tenant row plus the resolved-and-old row');
-- the application roles gain nothing from any of those names (test 17 rule)
SELECT pg_temp.chk(to_regclass(t) IS NOT NULL, pg_temp.as_g('lims_worker', NULL, jsonb_build_object('app.maintenance', m), 'SELECT 1 FROM ' || t), 'n=0',
                   'schema test 15: lims_worker with app.maintenance = ' || m || ' sees no expired row of ' || t)
  FROM (VALUES ('core.event_log','purge_event_log'),('core.idempotency_keys','purge_idempotency_keys'),('core.dead_letters','purge_dead_letters')) v(t, m);

SELECT * FROM finish();
ROLLBACK;
