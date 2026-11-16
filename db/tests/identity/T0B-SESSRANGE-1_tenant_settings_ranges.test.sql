-- T0B-SESSRANGE-1 (LD-304, CR-C0-LOGIN-1; 04-consolidated-decisions A8, REQ-SEC-073) live-DB assertions for the new migration (clamp, then the two CHECKs on identity.tenant_settings).
-- Asserted: (1) final state: tenant_settings__idle__ck = BETWEEN 15 AND 30 and tenant_settings__absolute__ck = BETWEEN 1 AND 12, validated, and they reject 14 / 31 / 0 / 13 and accept 15 / 30 / 1 / 12;
--   (2) the migration file itself (found in /repo/db/migrations as the one file newer than 20261116040000 that names both constraints) run against rows OUTSIDE the range
--   (constraints dropped first to build them) clamps 14->15, 31->30, 1440->30, 0->1, 13->12, 168->12, leaves in-range rows untouched, restores both constraints validated, and a second run
--   changes nothing and does not fail (idempotent); (3) sessions__idle__ck and sessions__absolute__ck are NOT changed (no widening, 04 A8).
-- Run: pg_prove -d <migrated db> db/tests/identity/T0B-SESSRANGE-1_tenant_settings_ranges.test.sql   (superuser; pgTAP in schema `extensions`; repo mounted at /repo)  or  db/tests/run-suites.sh
-- NOT run by its author (the lane has no psql / docker): the lead runs it on the machine. Synthetic data (seed tenants A and B). One rolled-back transaction.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);
CREATE FUNCTION pg_temp.st(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$ BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $f$;
CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE cols text := (SELECT string_agg(quote_ident(k), ',') FROM jsonb_object_keys(p_row) k);
BEGIN EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, p_row::text); END $f$;
-- the migration under test: the only file after the T0B-ASYNC-1 grant (20261116040000) that names both settings constraints (BEGIN/COMMIT lines stripped, we are in a transaction)
CREATE FUNCTION pg_temp.mig_sql() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE f text; txt text; found text[] := '{}'; r text;
BEGIN
  FOR f IN SELECT d FROM pg_ls_dir('/repo/db/migrations') d WHERE d ~ '^\d{14}_.*\.sql$' AND substr(d, 1, 14) > '20261116040000' ORDER BY d LOOP
    txt := pg_read_file('/repo/db/migrations/' || f);
    IF txt LIKE '%tenant_settings__idle__ck%' AND txt LIKE '%tenant_settings__absolute__ck%' THEN found := found || f; r := txt; END IF;
  END LOOP;
  IF cardinality(found) <> 1 THEN RAISE EXCEPTION 'expected exactly one migration naming both tenant_settings checks, found %', found; END IF;
  RETURN regexp_replace(r, '^\s*(BEGIN|COMMIT)\s*;\s*$', '', 'gim');
END $f$;

-- ================================================================ the migration file exists (the premise of every test below)
SELECT is(pg_temp.st($$SELECT pg_temp.mig_sql()$$), 'ok', 'exactly one migration after 20261116040000 names tenant_settings__idle__ck and tenant_settings__absolute__ck');

-- ================================================================ sessions checks untouched (04 A8: the session side is right, the settings side is narrowed)
SELECT matches(pg_get_constraintdef(c.oid), 'idle_timeout_minutes >= 15\) AND \(idle_timeout_minutes <= 30\)', 'sessions__idle__ck still holds 15..30 for tenant_staff / platform / partner')
  FROM pg_constraint c WHERE c.conrelid = 'identity.sessions'::regclass AND c.conname = 'sessions__idle__ck';
SELECT matches(pg_get_constraintdef(c.oid), '12:00:00|12 hours', 'sessions__absolute__ck still caps absolute_expires_at at created_at + 12 hours')
  FROM pg_constraint c WHERE c.conrelid = 'identity.sessions'::regclass AND c.conname = 'sessions__absolute__ck';

-- ================================================================ fixtures: two tenants' settings rows (RLS is not disabled; the superuser session bypasses it)
SELECT pg_temp.ins('identity.tenant_settings', jsonb_build_object('tenant_id', pg_temp.ta(), 'legal_name_snapshot', 'Synthetic Lab Alpha', 'display_name', 'Synthetic Lab Alpha', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));
SELECT pg_temp.ins('identity.tenant_settings', jsonb_build_object('tenant_id', pg_temp.tb(), 'legal_name_snapshot', 'Synthetic Lab Beta', 'display_name', 'Synthetic Lab Beta', 'created_by', pg_temp.sys(), 'updated_by', pg_temp.sys()));

-- ================================================================ (1) final state of a migrated database
SELECT is(pg_get_constraintdef(c.oid), 'CHECK (((idle_timeout_minutes >= 15) AND (idle_timeout_minutes <= 30)))', 'tenant_settings__idle__ck is BETWEEN 15 AND 30')
  FROM pg_constraint c WHERE c.conrelid = 'identity.tenant_settings'::regclass AND c.conname = 'tenant_settings__idle__ck';
SELECT is(pg_get_constraintdef(c.oid), 'CHECK (((absolute_session_hours >= 1) AND (absolute_session_hours <= 12)))', 'tenant_settings__absolute__ck is BETWEEN 1 AND 12')
  FROM pg_constraint c WHERE c.conrelid = 'identity.tenant_settings'::regclass AND c.conname = 'tenant_settings__absolute__ck';
SELECT ok(c.convalidated, c.conname || ' is validated') FROM pg_constraint c WHERE c.conrelid = 'identity.tenant_settings'::regclass AND c.conname IN ('tenant_settings__idle__ck', 'tenant_settings__absolute__ck');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET idle_timeout_minutes = 14 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'idle 14 rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET idle_timeout_minutes = 31 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'idle 31 rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET idle_timeout_minutes = 1440 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'idle 1440 (the old contract maximum) rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET absolute_session_hours = 0 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'absolute 0 rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET absolute_session_hours = 13 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'absolute 13 rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET absolute_session_hours = 168 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'absolute 168 (the old contract maximum) rejected');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET idle_timeout_minutes = 15, absolute_session_hours = 1 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), 'ok', 'idle 15 and absolute 1 accepted');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET idle_timeout_minutes = 30, absolute_session_hours = 12 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), 'ok', 'idle 30 and absolute 12 accepted');

-- ================================================================ (2) the migration on a database that holds out-of-range rows (a cloud database built before the checks existed)
ALTER TABLE identity.tenant_settings DROP CONSTRAINT tenant_settings__idle__ck, DROP CONSTRAINT tenant_settings__absolute__ck;
UPDATE identity.tenant_settings SET idle_timeout_minutes = 1440, absolute_session_hours = 168 WHERE tenant_id = pg_temp.ta();
UPDATE identity.tenant_settings SET idle_timeout_minutes = 20,   absolute_session_hours = 8   WHERE tenant_id = pg_temp.tb();
SELECT is(count(*)::int, 1, 'setup: tenant A holds idle 1440 / absolute 168 (outside the range)') FROM identity.tenant_settings WHERE tenant_id = pg_temp.ta() AND idle_timeout_minutes = 1440 AND absolute_session_hours = 168;

DO $m$ BEGIN EXECUTE pg_temp.mig_sql(); END $m$;
SELECT is((SELECT idle_timeout_minutes || '/' || absolute_session_hours FROM identity.tenant_settings WHERE tenant_id = pg_temp.ta()), '30/12', 'tenant A (1440 / 168) is clamped to 30 / 12');
SELECT is((SELECT idle_timeout_minutes || '/' || absolute_session_hours FROM identity.tenant_settings WHERE tenant_id = pg_temp.tb()), '20/8', 'tenant B (20 / 8, inside the range) is left untouched');
SELECT is((SELECT count(*)::int FROM pg_constraint c WHERE c.conrelid = 'identity.tenant_settings'::regclass AND c.conname IN ('tenant_settings__idle__ck', 'tenant_settings__absolute__ck') AND c.convalidated), 2, 'both checks are back and validated after the migration');
SELECT is(pg_get_constraintdef(c.oid), 'CHECK (((idle_timeout_minutes >= 15) AND (idle_timeout_minutes <= 30)))', 'idle check definition after the migration')
  FROM pg_constraint c WHERE c.conrelid = 'identity.tenant_settings'::regclass AND c.conname = 'tenant_settings__idle__ck';

-- the low side and the other high values: drop again, plant 14 / 0 and 31 / 13, migrate
ALTER TABLE identity.tenant_settings DROP CONSTRAINT tenant_settings__idle__ck, DROP CONSTRAINT tenant_settings__absolute__ck;
UPDATE identity.tenant_settings SET idle_timeout_minutes = 14, absolute_session_hours = 0  WHERE tenant_id = pg_temp.ta();
UPDATE identity.tenant_settings SET idle_timeout_minutes = 31, absolute_session_hours = 13 WHERE tenant_id = pg_temp.tb();
DO $m$ BEGIN EXECUTE pg_temp.mig_sql(); END $m$;
SELECT is((SELECT idle_timeout_minutes || '/' || absolute_session_hours FROM identity.tenant_settings WHERE tenant_id = pg_temp.ta()), '15/1', 'tenant A (14 / 0) is clamped up to 15 / 1');
SELECT is((SELECT idle_timeout_minutes || '/' || absolute_session_hours FROM identity.tenant_settings WHERE tenant_id = pg_temp.tb()), '30/12', 'tenant B (31 / 13) is clamped down to 30 / 12');

-- idempotent: a second run on the migrated database changes no row and does not fail
CREATE TEMP TABLE before_rerun AS SELECT tenant_id, idle_timeout_minutes, absolute_session_hours, version FROM identity.tenant_settings;
SELECT is(pg_temp.st($q$DO $x$ BEGIN EXECUTE pg_temp.mig_sql(); END $x$$q$), 'ok', 'a second run of the migration does not fail');
SELECT is((SELECT count(*)::int FROM identity.tenant_settings s JOIN before_rerun b USING (tenant_id) WHERE (s.idle_timeout_minutes, s.absolute_session_hours, s.version) IS DISTINCT FROM (b.idle_timeout_minutes, b.absolute_session_hours, b.version)), 0,
          'the second run changes no row (no version bump on rows already inside the range)');
SELECT is((SELECT count(*)::int FROM pg_constraint c WHERE c.conrelid = 'identity.tenant_settings'::regclass AND c.conname IN ('tenant_settings__idle__ck', 'tenant_settings__absolute__ck') AND c.convalidated), 2, 'still exactly the two validated checks after the second run');

-- ================================================================ (3) nothing else moved
SELECT is((SELECT count(*)::int FROM pg_constraint c WHERE c.conrelid = 'identity.tenant_settings'::regclass AND c.conname IN ('tenant_settings__pwlen__ck', 'tenant_settings__timezone__ck')), 2, 'password and timezone checks of tenant_settings are still there');
SELECT is(pg_temp.st($$UPDATE identity.tenant_settings SET password_min_length = 11 WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000a001'$$), '23514', 'password_min_length 11 is still rejected (password rules unchanged)');
SELECT * FROM finish();
ROLLBACK;
