-- T0B-CNTPOL-1 (LD-257, CR-C0-T0B-REVIEW-1-002 / LD-232 item 3; C16 05-SCHEMA s1, s4, s5.1, s5.2) live-DB assertions for
--   migration 20261116030000_engagement__narrow_number_counters_access.sql on engagement.number_counters:
--   3 RESTRICTIVE policies TO lims_app (number_counters__{select,insert,update}__nonstaff_keys): user and system unchanged; patient only on
--   counter_key ~ '^(booking_no:[0-9]{2}|otp_day:[0-9]{8}|linkfail:[0-9a-f-]{36}:[0-9]{10})$'; device and every other actor type: nothing;
--   + a BEFORE UPDATE guard trigger: a patient actor can never LOWER last_value (an equal or higher value is fine).
-- (a) device (and portal / no claims): SELECT 0 rows, INSERT 42501, UPDATE and DELETE 0 rows
-- (b) patient: card_no:26 (staff-issued) is invisible, INSERT / upsert of any card_no key 42501, UPDATE 0 rows
-- (c) patient: the real upserts of the OTP cap (otp_day), the link failure limit (linkfail) and the self-booking number (booking_no) still change 1 row (new and existing key)
-- (d) patient: an UPDATE / upsert that lowers last_value of an own key raises (not 42501: the trigger, after the policies passed) and changes nothing; an equal or higher value still works
-- (e) staff user and system actor unchanged (read, insert, update, also a lowering UPDATE; other tenant 0 rows)
-- (f) DELETE unchanged: only the system actor, only expired rows (the worker purge text), user / patient / device 0 rows
-- (g) catalog: the three RESTRICTIVE policies, the four permissive tenant policies kept, the guard trigger (BEFORE UPDATE row trigger, not SECURITY DEFINER), grants kept
-- (h) settings and cs_* SELECT policies NOT changed (still ANY_T, still readable by patient and device, no RESTRICTIVE policy on them)
-- Not covered here, on purpose (open point in the notes): a patient renaming counter_key of an own row (UPDATE ... SET counter_key = ...) is not stopped by the brief's guard.
-- Synthetic data only; seeded tenants A / B as in db/tests/reporting/T0B-PEVPOL-1_provider_events_update.test.sql; RLS is never disabled for the assertions; one rolled-back transaction.
-- Run: pg_prove -d <migrated db WITH the new migration> db/tests/engagement/T0B-CNTPOL-1_number_counters.test.sql   (superuser; pgTAP in schema `extensions`; seeds loaded; from the repo root)
-- NOT RUN in the lane (no psql / docker): neither this file nor the migration has been run by its author; before the migration (a), (b), (d) and (g) FAIL, as they must.
-- FOUNDER STEP: run db/tests/run-suites.sh BEFORE push-cloud.ps1 applies the migration.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c600-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
SELECT set_config('request.jwt.claims', jsonb_build_object('tenant_id', pg_temp.ta(), 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true);

CREATE FUNCTION pg_temp.ins(p_tbl regclass, p_row jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r jsonb := p_row; a text; cols text; saved text := current_setting('request.jwt.claims', true);
BEGIN
  IF r ? 'tenant_id' THEN PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', r->>'tenant_id', 'sub', pg_temp.sys(), 'actor_type', 'system')::text, true); END IF;
  FOREACH a IN ARRAY ARRAY['created_by', 'updated_by'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_tbl AND attname = a AND NOT attisdropped) AND NOT (r ? a) THEN r := r || jsonb_build_object(a, pg_temp.sys()); END IF;
  END LOOP;
  SELECT string_agg(quote_ident(k), ',') INTO cols FROM jsonb_object_keys(r) k;
  EXECUTE format('INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, %3$L::jsonb)', p_tbl, cols, r::text);
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
END $f$;
-- run p_sql as p_role with p_claims; mode n = count of a query, w = ROW_COUNT of a statement; errors -> 'E' || SQLSTATE || '|' || SQLERRM
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
-- claims of one actor type for tenant p_tenant (membership as in the seeds); a centre only for the device
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text, p_centre uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', pg_temp.uid(77),
    'membership_id', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a500' ELSE '01a1a98a-ac40-7000-8000-00000000b500' END::uuid, 'aal', 'aal1')
    || CASE WHEN p_centre IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('centre_id', p_centre) END $$;
CREATE FUNCTION pg_temp.pat(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'patient'), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.usr(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'user'), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.sya(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'system'), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.dev(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device', '01a1a98a-ac40-7000-8000-00000000a201'), p_sql, p_mode) $$;
CREATE FUNCTION pg_temp.prt(p_sql text, p_mode text DEFAULT 'w') RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal'), p_sql, p_mode) $$;
-- superuser read-back (no RLS): last_value of a key of tenant A / B, '<none>' when absent
CREATE FUNCTION pg_temp.val(p_key text, p_tenant uuid DEFAULT NULL) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce((SELECT last_value::text FROM engagement.number_counters WHERE tenant_id = coalesce(p_tenant, pg_temp.ta()) AND counter_key = p_key), '<none>') $$;
-- the statements the code really runs (otp.repo.ts:28, linkCodes.repo.ts:108, booking.repo.ts:90-91, membership.repo.ts:52-53)
CREATE FUNCTION pg_temp.upsert(p_key text, p_cap int DEFAULT 100) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$INSERT INTO engagement.number_counters (tenant_id, counter_key, last_value, expires_at, created_by) VALUES (%L, %L, 1, now() + interval '48 hours', %L)
    ON CONFLICT (tenant_id, counter_key) DO UPDATE SET last_value = number_counters.last_value + 1, updated_at = now() WHERE number_counters.last_value < %s$q$, pg_temp.ta(), p_key, pg_temp.uid(77), p_cap) $$;
CREATE FUNCTION pg_temp.seed0(p_key text) RETURNS text LANGUAGE sql AS $$
  SELECT format('INSERT INTO engagement.number_counters (tenant_id, counter_key, last_value, created_by) VALUES (%L, %L, 0, %L) ON CONFLICT DO NOTHING', pg_temp.ta(), p_key, pg_temp.uid(77)) $$;
CREATE FUNCTION pg_temp.bump(p_key text) RETURNS text LANGUAGE sql AS $$
  SELECT format('UPDATE engagement.number_counters SET last_value = last_value + 1, updated_at = now() WHERE tenant_id = %L AND counter_key = %L RETURNING last_value', pg_temp.ta(), p_key) $$;
CREATE FUNCTION pg_temp.setv(p_key text, p_set text) RETURNS text LANGUAGE sql AS $$
  SELECT format('UPDATE engagement.number_counters SET %s WHERE tenant_id = %L AND counter_key = %L', p_set, pg_temp.ta(), p_key) $$;
CREATE FUNCTION pg_temp.insk(p_key text) RETURNS text LANGUAGE sql AS $$
  SELECT format('INSERT INTO engagement.number_counters (tenant_id, counter_key, last_value, created_by) VALUES (%L, %L, 1, %L)', pg_temp.ta(), p_key, pg_temp.uid(77)) $$;

-- ===================================================================================================================================== fixtures (superuser session)
-- tenant A: card_no:26 = 5 (staff-issued), booking_no:26 = 7, otp_day:20261116 = 2, linkfail:<uuid>:2026111607 = 3, otp_day:20250101 = 9 (expired: the purge target); tenant B: otp_day:20261116 = 4
SELECT pg_temp.ins('engagement.number_counters', jsonb_build_object('tenant_id', pg_temp.ta(), 'counter_key', 'card_no:26', 'last_value', 5));
SELECT pg_temp.ins('engagement.number_counters', jsonb_build_object('tenant_id', pg_temp.ta(), 'counter_key', 'booking_no:26', 'last_value', 7));
SELECT pg_temp.ins('engagement.number_counters', jsonb_build_object('tenant_id', pg_temp.ta(), 'counter_key', 'otp_day:20261116', 'last_value', 2, 'expires_at', now() + interval '48 hours'));
SELECT pg_temp.ins('engagement.number_counters', jsonb_build_object('tenant_id', pg_temp.ta(), 'counter_key', 'linkfail:01950c16-0000-7000-8000-000000000301:2026111607', 'last_value', 3, 'expires_at', now() + interval '2 hours'));
SELECT pg_temp.ins('engagement.number_counters', jsonb_build_object('tenant_id', pg_temp.ta(), 'counter_key', 'otp_day:20250101', 'last_value', 9, 'expires_at', now() - interval '30 days'));
SELECT pg_temp.ins('engagement.number_counters', jsonb_build_object('tenant_id', pg_temp.tb(), 'counter_key', 'otp_day:20261116', 'last_value', 4, 'expires_at', now() + interval '48 hours'));
SELECT is((SELECT count(*)::int FROM engagement.number_counters WHERE counter_key IN ('card_no:26', 'booking_no:26', 'otp_day:20261116', 'linkfail:01950c16-0000-7000-8000-000000000301:2026111607', 'otp_day:20250101')), 6, 'fixture: six counter rows (5 of tenant A, 1 of tenant B share keys)');

-- ===================================================================================================================================== (g) catalog (first: if the migration is missing nothing below means anything)
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'engagement' AND tablename = 'number_counters' AND permissive = 'RESTRICTIVE'), 3, '(g) catalog: exactly three RESTRICTIVE policies on engagement.number_counters');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'engagement' AND tablename = 'number_counters' AND permissive = 'PERMISSIVE'), 4, '(g) catalog: the four permissive tenant policies (select, insert, update, delete) are kept');
SELECT is((SELECT array_agg(cmd ORDER BY cmd)::text FROM pg_policies WHERE schemaname = 'engagement' AND tablename = 'number_counters' AND permissive = 'RESTRICTIVE'), '{INSERT,SELECT,UPDATE}', '(g) catalog: the restrictive policies are for SELECT, INSERT and UPDATE (no DELETE)');
SELECT is((SELECT roles::text FROM pg_policies WHERE schemaname = 'engagement' AND tablename = 'number_counters' AND policyname = 'number_counters__select__nonstaff_keys'), '{lims_app}', '(g) catalog: number_counters__select__nonstaff_keys is TO lims_app');
SELECT is((SELECT roles::text FROM pg_policies WHERE schemaname = 'engagement' AND tablename = 'number_counters' AND policyname = 'number_counters__insert__nonstaff_keys'), '{lims_app}', '(g) catalog: number_counters__insert__nonstaff_keys is TO lims_app');
SELECT is((SELECT roles::text FROM pg_policies WHERE schemaname = 'engagement' AND tablename = 'number_counters' AND policyname = 'number_counters__update__nonstaff_keys'), '{lims_app}', '(g) catalog: number_counters__update__nonstaff_keys is TO lims_app');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'engagement' AND tablename = 'number_counters' AND policyname LIKE 'number_counters\_\_%\_\_nonstaff\_keys' AND permissive = 'RESTRICTIVE'), 3, '(g) catalog: the three are named number_counters__<cmd>__nonstaff_keys and RESTRICTIVE');
SELECT matches((SELECT qual FROM pg_policies WHERE policyname = 'number_counters__select__nonstaff_keys' AND tablename = 'number_counters'), 'otp_day', '(g) catalog: select USING names the otp_day key');
SELECT matches((SELECT qual FROM pg_policies WHERE policyname = 'number_counters__select__nonstaff_keys' AND tablename = 'number_counters'), 'linkfail', '(g) catalog: select USING names the linkfail key');
SELECT matches((SELECT qual FROM pg_policies WHERE policyname = 'number_counters__select__nonstaff_keys' AND tablename = 'number_counters'), 'booking_no', '(g) catalog: select USING names the booking_no key');
SELECT doesnt_match((SELECT qual FROM pg_policies WHERE policyname = 'number_counters__select__nonstaff_keys' AND tablename = 'number_counters'), 'card_no', '(g) catalog: select USING does not name card_no');
SELECT doesnt_match((SELECT qual FROM pg_policies WHERE policyname = 'number_counters__select__nonstaff_keys' AND tablename = 'number_counters'), 'device', '(g) catalog: select USING does not name device');
SELECT matches((SELECT with_check FROM pg_policies WHERE policyname = 'number_counters__insert__nonstaff_keys' AND tablename = 'number_counters'), 'patient', '(g) catalog: insert WITH CHECK names the patient actor');
SELECT matches((SELECT qual FROM pg_policies WHERE policyname = 'number_counters__update__nonstaff_keys' AND tablename = 'number_counters'), 'patient', '(g) catalog: update USING names the patient actor');
SELECT matches((SELECT with_check FROM pg_policies WHERE policyname = 'number_counters__update__nonstaff_keys' AND tablename = 'number_counters'), 'patient', '(g) catalog: update WITH CHECK names the patient actor');
SELECT is((SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = 'engagement.number_counters'::regclass AND NOT t.tgisinternal AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 16) = 16 AND (t.tgtype & 4) = 0 AND (t.tgtype & 8) = 0), 1,
  '(g) catalog: one BEFORE UPDATE row trigger on engagement.number_counters (not INSERT, not DELETE)');
SELECT is((SELECT p.prosecdef FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = 'engagement.number_counters'::regclass AND NOT t.tgisinternal LIMIT 1), false, '(g) catalog: the guard function is not SECURITY DEFINER');
SELECT is((SELECT n.nspname FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace WHERE t.tgrelid = 'engagement.number_counters'::regclass AND NOT t.tgisinternal LIMIT 1), 'engagement', '(g) catalog: the guard function lives in schema engagement (like guard_actor_columns)');
SELECT ok(has_table_privilege('lims_app', 'engagement.number_counters', 'SELECT') AND has_table_privilege('lims_app', 'engagement.number_counters', 'INSERT')
  AND has_table_privilege('lims_app', 'engagement.number_counters', 'UPDATE') AND has_table_privilege('lims_app', 'engagement.number_counters', 'DELETE'), '(g) catalog: the lims_app SELECT / INSERT / UPDATE / DELETE grants are unchanged (policies narrow, grants stay)');
SELECT is((SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'engagement.number_counters'::regclass), true, '(g) catalog: RLS is still enabled and forced');

-- ===================================================================================================================================== (a) device and every other actor type: nothing
SELECT is(pg_temp.dev('SELECT 1 FROM engagement.number_counters', 'n'), 'n=0', '(a) device claims: SELECT reads 0 rows');
SELECT is(pg_temp.dev($$SELECT 1 FROM engagement.number_counters WHERE counter_key = 'otp_day:20261116'$$, 'n'), 'n=0', '(a) device claims: the otp_day row is not readable');
SELECT alike(pg_temp.dev(pg_temp.insk('otp_day:20261117')), 'E42501|%', '(a) device claims: INSERT of an otp_day key raises 42501');
SELECT alike(pg_temp.dev(pg_temp.insk('booking_no:27')), 'E42501|%', '(a) device claims: INSERT of a booking_no key raises 42501');
SELECT alike(pg_temp.dev(pg_temp.insk('card_no:27')), 'E42501|%', '(a) device claims: INSERT of a card_no key raises 42501');
SELECT alike(pg_temp.dev(pg_temp.upsert('otp_day:20261116')), 'E42501|%', '(a) device claims: the OTP upsert raises 42501');
SELECT is(pg_temp.dev(pg_temp.setv('otp_day:20261116', 'last_value = last_value + 1')), 'n=0', '(a) device claims: UPDATE of the otp_day row changes 0 rows');
SELECT is(pg_temp.dev(pg_temp.setv('booking_no:26', 'last_value = last_value + 1')), 'n=0', '(a) device claims: UPDATE of the booking_no row changes 0 rows');
SELECT is(pg_temp.dev(pg_temp.setv('card_no:26', 'last_value = last_value + 1')), 'n=0', '(a) device claims: UPDATE of the card_no row changes 0 rows');
SELECT is(pg_temp.dev($$DELETE FROM engagement.number_counters WHERE counter_key = 'otp_day:20250101'$$), 'n=0', '(a) device claims: DELETE of the expired otp_day row changes 0 rows');
SELECT is(pg_temp.prt('SELECT 1 FROM engagement.number_counters', 'n'), 'n=0', '(a) any other actor type (portal): SELECT reads 0 rows');
SELECT alike(pg_temp.prt(pg_temp.insk('otp_day:20261117')), 'E42501|%', '(a) any other actor type (portal): INSERT raises 42501');
SELECT is(pg_temp.prt(pg_temp.setv('otp_day:20261116', 'last_value = last_value + 1')), 'n=0', '(a) any other actor type (portal): UPDATE changes 0 rows');
SELECT is(pg_temp.x('lims_app', NULL, 'SELECT 1 FROM engagement.number_counters', 'n'), 'n=0', '(a) no claims at all: SELECT reads 0 rows');
SELECT is((pg_temp.val('otp_day:20261116'), pg_temp.val('booking_no:26'), pg_temp.val('card_no:26'), pg_temp.val('otp_day:20261117'), pg_temp.val('booking_no:27'), pg_temp.val('card_no:27'))::text,
  '(2,7,5,<none>,<none>,<none>)', '(a) nothing the device / portal tried changed or created a row');

-- ===================================================================================================================================== (b) patient: card_no is staff-only
SELECT is(pg_temp.pat($$SELECT 1 FROM engagement.number_counters WHERE counter_key LIKE 'card_no:%'$$, 'n'), 'n=0', '(b) patient claims: the card_no:26 row is invisible (SELECT 0 rows)');
SELECT alike(pg_temp.pat(pg_temp.insk('card_no:27')), 'E42501|%', '(b) patient claims: INSERT of card_no:27 raises 42501');
SELECT alike(pg_temp.pat(pg_temp.insk('card_no:26')), 'E42501|%', '(b) patient claims: INSERT of the existing card_no:26 raises 42501');
SELECT alike(pg_temp.pat(pg_temp.upsert('card_no:26')), 'E42501|%', '(b) patient claims: an upsert (ON CONFLICT DO UPDATE) of card_no:26 raises 42501');
SELECT alike(pg_temp.pat(pg_temp.upsert('card_no:99')), 'E42501|%', '(b) patient claims: an upsert of a new card_no key raises 42501');
SELECT is(pg_temp.pat(pg_temp.setv('card_no:26', 'last_value = last_value + 1')), 'n=0', '(b) patient claims: UPDATE of card_no:26 changes 0 rows (the card number cannot be burned or reset)');
SELECT is(pg_temp.pat(pg_temp.setv('card_no:26', 'last_value = 0')), 'n=0', '(b) patient claims: UPDATE card_no:26 SET last_value = 0 changes 0 rows');
SELECT is((pg_temp.val('card_no:26'), pg_temp.val('card_no:27'), pg_temp.val('card_no:99'))::text, '(5,<none>,<none>)', '(b) card_no:26 is still 5 and no other card_no row exists');

-- ===================================================================================================================================== (c) patient: own rate and booking keys still work (the statements of otp.repo / linkCodes.repo / booking.repo)
SELECT is(pg_temp.pat($$SELECT 1 FROM engagement.number_counters WHERE counter_key = 'otp_day:20261116'$$, 'n'), 'n=1', '(c) patient claims: the own otp_day row is readable');
SELECT is(pg_temp.pat($$SELECT 1 FROM engagement.number_counters WHERE counter_key = 'linkfail:01950c16-0000-7000-8000-000000000301:2026111607'$$, 'n'), 'n=1', '(c) patient claims: the own linkfail row is readable');
SELECT is(pg_temp.pat($$SELECT 1 FROM engagement.number_counters WHERE counter_key = 'booking_no:26'$$, 'n'), 'n=1', '(c) patient claims: the booking_no row is readable');
SELECT is(pg_temp.pat(pg_temp.upsert('otp_day:20261116')), 'n=1', '(c) patient claims: OTP cap upsert of the existing otp_day key changes 1 row');
SELECT is(pg_temp.val('otp_day:20261116'), '3', '(c) the otp_day counter went 2 -> 3');
SELECT is(pg_temp.pat(pg_temp.upsert('otp_day:20261117')), 'n=1', '(c) patient claims: OTP cap upsert of a NEW otp_day key inserts 1 row');
SELECT is(pg_temp.val('otp_day:20261117'), '1', '(c) the new otp_day counter starts at 1');
SELECT is(pg_temp.pat(pg_temp.upsert('otp_day:20261116', 3)), 'n=0', '(c) the OTP cap WHERE last_value < cap still stops at the cap (0 rows, no error)');
SELECT is(pg_temp.pat(pg_temp.upsert('linkfail:01950c16-0000-7000-8000-000000000301:2026111607')), 'n=1', '(c) patient claims: link failure upsert of the existing linkfail key changes 1 row');
SELECT is(pg_temp.val('linkfail:01950c16-0000-7000-8000-000000000301:2026111607'), '4', '(c) the linkfail counter went 3 -> 4');
SELECT is(pg_temp.pat(pg_temp.upsert('linkfail:01950c16-0000-7000-8000-000000000302:2026111608')), 'n=1', '(c) patient claims: link failure upsert of a NEW linkfail key inserts 1 row');
SELECT is(pg_temp.pat(pg_temp.seed0('booking_no:27')), 'n=1', '(c) patient claims: self-booking INSERT ... ON CONFLICT DO NOTHING of a new booking_no key inserts 1 row');
SELECT is(pg_temp.pat(pg_temp.bump('booking_no:27')), 'n=1', '(c) patient claims: self-booking UPDATE last_value + 1 of the new booking_no key changes 1 row');
SELECT is(pg_temp.pat(pg_temp.seed0('booking_no:26')), 'n=0', '(c) patient claims: ON CONFLICT DO NOTHING of the existing booking_no:26 changes 0 rows (no error)');
SELECT is(pg_temp.pat(pg_temp.bump('booking_no:26')), 'n=1', '(c) patient claims: self-booking UPDATE last_value + 1 of booking_no:26 changes 1 row');
SELECT is((pg_temp.val('booking_no:26'), pg_temp.val('booking_no:27'))::text, '(8,1)', '(c) booking numbers advanced: booking_no:26 7 -> 8, booking_no:27 0 -> 1');
SELECT is(pg_temp.pat($$SELECT 1 FROM engagement.number_counters WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$$, 'n'), 'n=0', '(c) patient claims of tenant A read nothing of tenant B');
SELECT is(pg_temp.pat(format($$UPDATE engagement.number_counters SET last_value = last_value + 1 WHERE tenant_id = %L AND counter_key = 'otp_day:20261116'$$, pg_temp.tb())), 'n=0', '(c) patient claims of tenant A update 0 rows of tenant B');
SELECT is(pg_temp.val('otp_day:20261116', pg_temp.tb()), '4', '(c) tenant B otp_day is still 4');

-- ===================================================================================================================================== (d) patient: a counter can never be lowered
SELECT is(pg_temp.val('otp_day:20261116'), '3', '(d) before: otp_day:20261116 = 3');
SELECT alike(pg_temp.pat(pg_temp.setv('otp_day:20261116', 'last_value = 0')), 'E%', '(d) patient claims: UPDATE otp_day SET last_value = 0 (reset of the OTP cap) raises');
SELECT unalike(pg_temp.pat(pg_temp.setv('otp_day:20261116', 'last_value = 0')), 'E42501|%', '(d) ... and it is the guard that raises, not a policy (the own key passes the policies)');
SELECT alike(pg_temp.pat(pg_temp.setv('otp_day:20261116', 'last_value = last_value - 1')), 'E%', '(d) patient claims: lowering otp_day by 1 raises');
SELECT alike(pg_temp.pat(pg_temp.setv('linkfail:01950c16-0000-7000-8000-000000000301:2026111607', 'last_value = 0')), 'E%', '(d) patient claims: UPDATE linkfail SET last_value = 0 (reset of the link failure limit) raises');
SELECT alike(pg_temp.pat(pg_temp.setv('booking_no:26', 'last_value = last_value - 1')), 'E%', '(d) patient claims: lowering booking_no raises');
SELECT alike(pg_temp.pat(format($q$INSERT INTO engagement.number_counters (tenant_id, counter_key, last_value, expires_at, created_by) VALUES (%L, 'otp_day:20261116', 1, now() + interval '48 hours', %L)
    ON CONFLICT (tenant_id, counter_key) DO UPDATE SET last_value = 0$q$, pg_temp.ta(), pg_temp.uid(77))), 'E%', '(d) patient claims: an upsert whose DO UPDATE sets last_value = 0 raises');
SELECT is((pg_temp.val('otp_day:20261116'), pg_temp.val('booking_no:26'), pg_temp.val('linkfail:01950c16-0000-7000-8000-000000000301:2026111607'))::text, '(3,8,4)', '(d) no lowering attempt changed a value');
SELECT is(pg_temp.pat(pg_temp.setv('otp_day:20261116', 'updated_at = now()')), 'n=1', '(d) patient claims: an UPDATE that leaves last_value equal still changes 1 row (the guard is "lower", not "not higher")');
SELECT is(pg_temp.pat(pg_temp.setv('otp_day:20261116', 'last_value = last_value + 50')), 'n=1', '(d) patient claims: raising a counter by 50 changes 1 row');
SELECT is(pg_temp.val('otp_day:20261116'), '53', '(d) otp_day:20261116 = 53 after the raise');

-- ===================================================================================================================================== (e) staff user and system actor: unchanged
SELECT is(pg_temp.usr($$SELECT 1 FROM engagement.number_counters WHERE counter_key IN ('card_no:26', 'booking_no:26', 'otp_day:20261116', 'linkfail:01950c16-0000-7000-8000-000000000301:2026111607', 'otp_day:20250101')$$, 'n'), 'n=5', '(e) user claims: read all five key classes of tenant A (card_no included)');
SELECT is(pg_temp.sya($$SELECT 1 FROM engagement.number_counters WHERE counter_key IN ('card_no:26', 'booking_no:26', 'otp_day:20261116', 'linkfail:01950c16-0000-7000-8000-000000000301:2026111607', 'otp_day:20250101')$$, 'n'), 'n=5', '(e) system claims: read all five key classes of tenant A');
SELECT is(pg_temp.usr(pg_temp.seed0('card_no:27')), 'n=1', '(e) user claims: INSERT of a card_no key (membership.repo.ts:52) changes 1 row');
SELECT is(pg_temp.usr(pg_temp.bump('card_no:27')), 'n=1', '(e) user claims: UPDATE last_value + 1 of the card_no key changes 1 row');
SELECT is(pg_temp.usr(pg_temp.bump('card_no:26')), 'n=1', '(e) user claims: UPDATE last_value + 1 of card_no:26 changes 1 row');
SELECT is(pg_temp.val('card_no:26'), '6', '(e) card_no:26 = 6');
SELECT is(pg_temp.usr(pg_temp.setv('card_no:26', 'last_value = 1')), 'n=1', '(e) user claims: a staff UPDATE may still lower a counter (the guard is for the patient actor only)');
SELECT is(pg_temp.val('card_no:26'), '1', '(e) card_no:26 = 1 after the staff lowering');
SELECT is(pg_temp.sya(pg_temp.setv('otp_day:20261116', 'last_value = 0')), 'n=1', '(e) system claims: a system UPDATE may still lower a counter (reset by the platform)');
SELECT is(pg_temp.val('otp_day:20261116'), '0', '(e) otp_day:20261116 = 0 after the system lowering');
SELECT is(pg_temp.sya(pg_temp.upsert('otp_day:20261118')), 'n=1', '(e) system claims: INSERT of an otp_day key changes 1 row');
SELECT is(pg_temp.sya(pg_temp.seed0('card_no:28')), 'n=1', '(e) system claims: INSERT of a card_no key changes 1 row');
SELECT is(pg_temp.usr(format($$UPDATE engagement.number_counters SET last_value = last_value + 1 WHERE tenant_id = %L AND counter_key = 'otp_day:20261116'$$, pg_temp.tb())), 'n=0', '(e) user claims of tenant A update 0 rows of tenant B');
SELECT is(pg_temp.usr($$SELECT 1 FROM engagement.number_counters WHERE tenant_id = '01a1a98a-ac40-7000-8000-00000000b001'$$, 'n'), 'n=0', '(e) user claims of tenant A read nothing of tenant B');

-- ===================================================================================================================================== (f) DELETE unchanged: system actor only, expired rows only (worker purge.ts:25)
SELECT is(pg_temp.pat(format($$DELETE FROM engagement.number_counters WHERE tenant_id = %L AND expires_at IS NOT NULL AND expires_at < now()$$, pg_temp.ta())), 'n=0', '(f) patient claims: the purge DELETE changes 0 rows');
SELECT is(pg_temp.usr(format($$DELETE FROM engagement.number_counters WHERE tenant_id = %L AND expires_at IS NOT NULL AND expires_at < now()$$, pg_temp.ta())), 'n=0', '(f) user claims: the purge DELETE changes 0 rows (system only)');
SELECT is(pg_temp.dev(format($$DELETE FROM engagement.number_counters WHERE tenant_id = %L AND expires_at IS NOT NULL AND expires_at < now()$$, pg_temp.ta())), 'n=0', '(f) device claims: the purge DELETE changes 0 rows');
SELECT is(pg_temp.sya(format($$DELETE FROM engagement.number_counters WHERE tenant_id = %L AND counter_key = 'otp_day:20261116'$$, pg_temp.ta())), 'n=0', '(f) system claims: DELETE of an unexpired row changes 0 rows');
SELECT is(pg_temp.sya(format($$DELETE FROM engagement.number_counters WHERE tenant_id = %L AND counter_key = 'card_no:26'$$, pg_temp.ta())), 'n=0', '(f) system claims: DELETE of a numbering row (expires_at NULL) changes 0 rows');
SELECT is(pg_temp.val('otp_day:20250101'), '9', '(f) the expired row is still there before the purge');
SELECT is(pg_temp.sya(format($$DELETE FROM engagement.number_counters WHERE tenant_id = %L AND expires_at IS NOT NULL AND expires_at < now()$$, pg_temp.ta())), 'n=1', '(f) system claims: the purge DELETE (expires_at IS NOT NULL AND expires_at < now()) removes the 1 expired row');
SELECT is(pg_temp.val('otp_day:20250101'), '<none>', '(f) the expired row is gone');
SELECT is(pg_temp.sya(format($$DELETE FROM engagement.number_counters WHERE tenant_id = %L AND expires_at IS NOT NULL AND expires_at < now()$$, pg_temp.ta())), 'n=0', '(f) a second purge changes 0 rows');
SELECT is((pg_temp.val('card_no:26'), pg_temp.val('booking_no:26'))::text, '(1,8)', '(f) the numbering rows survived the purge');

-- ===================================================================================================================================== (h) settings and cs_* SELECT policies are NOT changed
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'engagement' AND tablename IN ('settings', 'cs_booking_cancel_reasons', 'cs_reminder_reasons', 'cs_enquiry_categories') AND permissive = 'RESTRICTIVE'), 0, '(h) catalog: no RESTRICTIVE policy on settings or the cs_* tables');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'engagement' AND policyname IN ('settings__select__tenant', 'cs_booking_cancel_reasons__select__tenant', 'cs_reminder_reasons__select__tenant', 'cs_enquiry_categories__select__tenant') AND permissive = 'PERMISSIVE' AND cmd = 'SELECT'), 4, '(h) catalog: the four ANY_T SELECT policies still exist (permissive)');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'engagement' AND policyname IN ('settings__select__tenant', 'cs_booking_cancel_reasons__select__tenant', 'cs_reminder_reasons__select__tenant', 'cs_enquiry_categories__select__tenant')
  AND qual ~ 'patient' AND qual ~ 'device' AND qual ~ 'user' AND qual ~ 'system' AND qual !~ 'is_staff_or_system'), 4, '(h) catalog: they still read ANY_T (user, system, patient, device; no is_staff_or_system)');
SELECT alike(pg_temp.pat('SELECT 1 FROM engagement.settings', 'n'), 'n=%', '(h) patient claims: settings are still readable (no error)');
SELECT alike(pg_temp.dev('SELECT 1 FROM engagement.settings', 'n'), 'n=%', '(h) device claims: settings are still readable (no error; the queue display reads display.repo.ts:62)');
SELECT alike(pg_temp.pat('SELECT 1 FROM engagement.cs_booking_cancel_reasons', 'n'), 'n=%', '(h) patient claims: cs_booking_cancel_reasons still readable (no error)');
SELECT alike(pg_temp.dev('SELECT 1 FROM engagement.cs_enquiry_categories', 'n'), 'n=%', '(h) device claims: cs_enquiry_categories still readable (no error)');

SELECT * FROM finish();
ROLLBACK;
