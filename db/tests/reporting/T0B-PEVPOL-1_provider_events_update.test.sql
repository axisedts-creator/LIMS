-- T0B-PEVPOL-1 (LD-257; CR-C0-T0B-REVIEW-1-001 / LD-232 item 2; C0 01-PRD AC-0B-4.3; C6 05-SCHEMA s1, s2.10, s3, s5, s6) live-DB assertions for
--   migration 20261116020000_reporting__narrow_provider_events_update_policy.sql: policy provider_events__update__tenant (lims_app, UPDATE) is
--   USING      tenant_id = current tenant AND app.is_staff_or_system() AND app.current_actor_type() = 'system' AND applied_at IS NULL
--   WITH CHECK the same, with applied_at IS NOT NULL.      The lims_app UPDATE grant stays (the C6-T29 apply task needs it); nothing else changes.
-- (a) the system actor stamps applied_at + delivery_id of an unapplied row: 1 row         (b) a second UPDATE of the same, now applied, row: 0 rows
-- (c) the same UPDATE under user claims and under device claims (and tenant B's system actor): 0 rows
-- (d) a system UPDATE that sets applied_at to NULL on an unapplied row (or leaves it NULL): 42501 (WITH CHECK)
-- (e) no column other than applied_at / delivery_id / ignored_reason can change: the existing provider_events__mutable_columns trigger still raises immutable_row.
-- Same helper shapes and fixtures as T0B-10.C6_behaviour.test.sql (seeded tenants A/B, channel account fixture, RLS never disabled, synthetic data only, one rolled-back transaction).
-- The T0B-10.C6_behaviour.test.sql line 368 expectation (system actor stamps the one unapplied pm-1 row: n=1) stays valid and is not edited.
-- Run: pg_prove -d <migrated db WITH the new migration> db/tests/reporting/T0B-PEVPOL-1_provider_events_update.test.sql   (superuser; pgTAP in schema `extensions`; seeds loaded; from the repo root)
-- NOT RUN in the lane (no psql / docker): neither this file nor the migration has been run by its author; before the migration the (b), (c) and (d) assertions FAIL, as they must.
-- FOUNDER STEP: run db/tests/run-suites.sh BEFORE push-cloud.ps1 applies the migration.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c600-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.by(h text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '\x' || repeat(h, 32) $$;
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
-- run p_sql as p_role with p_claims; mode n = count of a query, w = ROW_COUNT of a statement, s = the single scalar; errors -> 'E' || SQLSTATE || '|' || SQLERRM
CREATE FUNCTION pg_temp.x(p_role text, p_claims jsonb, p_sql text, p_mode text DEFAULT 'n') RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint; saved text := current_setting('request.jwt.claims', true);
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_mode = 's' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSE
      IF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; END IF;
      r := 'n=' || n;
    END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || '|' || SQLERRM; END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', coalesce(saved, ''), true);
  RETURN r;
END $f$;
-- claims of one actor type for tenant p_tenant (membership as in the seeds: tenant A a500, tenant B b500); a centre only for the device
CREATE FUNCTION pg_temp.cl(p_tenant uuid, p_type text DEFAULT 'system', p_centre uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('actor_type', p_type, 'tenant_id', p_tenant, 'sub', pg_temp.sys(),
    'membership_id', CASE WHEN p_tenant = pg_temp.ta() THEN '01a1a98a-ac40-7000-8000-00000000a500' ELSE '01a1a98a-ac40-7000-8000-00000000b500' END::uuid)
    || CASE WHEN p_centre IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('centre_id', p_centre) END $$;
CREATE FUNCTION pg_temp.sysa(p_sql text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta()), p_sql, 'w') $$;
CREATE FUNCTION pg_temp.usra(p_sql text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'user'), p_sql, 'w') $$;
CREATE FUNCTION pg_temp.deva(p_sql text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device', '01a1a98a-ac40-7000-8000-00000000a201'), p_sql, 'w') $$;
CREATE FUNCTION pg_temp.sysb(p_sql text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(pg_temp.tb()), p_sql, 'w') $$;
-- one UPDATE text: the three apply columns stamped on the event p_ev
CREATE FUNCTION pg_temp.stamp(p_ev int, p_delivery int) RETURNS text LANGUAGE sql AS $$
  SELECT format('UPDATE reporting.provider_events SET applied_at = now(), delivery_id = %L WHERE id = %L', pg_temp.uid(p_delivery), pg_temp.uid(p_ev)) $$;

-- ===================================================================================================================================== fixtures (superuser session, system claims set above)
SELECT pg_temp.ins('reporting.channel_accounts', jsonb_build_object('id', pg_temp.uid(871), 'tenant_id', pg_temp.ta(), 'channel', 'sms', 'provider_kind', 'recording', 'secret_ref', 'zz/secret-ref', 'callback_token_sha256', pg_temp.by('45')));
-- 801 (a), 802 (c user), 803 (c device), 804 (d), 805 (c tenant B), 806 (a, with ignored_reason), 807 (e), 808 (d, no applied_at in the SET list) are unapplied; 809 was applied at insert time (b)
SELECT pg_temp.ins('reporting.provider_events', jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', pg_temp.ta(), 'channel_account_id', pg_temp.uid(871), 'provider_kind', 'recording',
    'provider_message_id', 'pev-' || n, 'status_raw', 'ok', 'mapped_status', 'sent'))
  FROM generate_series(801, 808) n;
SELECT pg_temp.ins('reporting.provider_events', jsonb_build_object('id', pg_temp.uid(809), 'tenant_id', pg_temp.ta(), 'channel_account_id', pg_temp.uid(871), 'provider_kind', 'recording',
    'provider_message_id', 'pev-809', 'status_raw', 'ok', 'mapped_status', 'sent', 'applied_at', '2026-01-01T00:00:00Z', 'delivery_id', pg_temp.uid(900)));
SELECT is((SELECT count(*)::int FROM reporting.provider_events WHERE id BETWEEN pg_temp.uid(801) AND pg_temp.uid(809)), 9, 'fixture: nine provider_events rows of tenant A');
SELECT is((SELECT count(*)::int FROM reporting.provider_events WHERE id BETWEEN pg_temp.uid(801) AND pg_temp.uid(808) AND applied_at IS NULL), 8, 'fixture: 801..808 are unapplied');

-- ===================================================================================================================================== catalog: one narrowed UPDATE policy, grant kept
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'reporting' AND tablename = 'provider_events' AND cmd = 'UPDATE'), 1, 'catalog: exactly one UPDATE policy on reporting.provider_events (none added, none dropped)');
SELECT is((SELECT roles::text FROM pg_policies WHERE schemaname = 'reporting' AND tablename = 'provider_events' AND policyname = 'provider_events__update__tenant'), '{lims_app}', 'catalog: provider_events__update__tenant stays TO lims_app');
SELECT matches((SELECT qual FROM pg_policies WHERE schemaname = 'reporting' AND tablename = 'provider_events' AND policyname = 'provider_events__update__tenant'), 'applied_at IS NULL', 'catalog: USING holds applied_at IS NULL');
SELECT matches((SELECT qual FROM pg_policies WHERE schemaname = 'reporting' AND tablename = 'provider_events' AND policyname = 'provider_events__update__tenant'), 'system', 'catalog: USING holds the system actor test');
SELECT matches((SELECT qual FROM pg_policies WHERE schemaname = 'reporting' AND tablename = 'provider_events' AND policyname = 'provider_events__update__tenant'), 'is_staff_or_system', 'catalog: USING keeps is_staff_or_system (T0B-08 policy shape)');
SELECT matches((SELECT with_check FROM pg_policies WHERE schemaname = 'reporting' AND tablename = 'provider_events' AND policyname = 'provider_events__update__tenant'), 'applied_at IS NOT NULL', 'catalog: WITH CHECK holds applied_at IS NOT NULL');
SELECT matches((SELECT with_check FROM pg_policies WHERE schemaname = 'reporting' AND tablename = 'provider_events' AND policyname = 'provider_events__update__tenant'), 'system', 'catalog: WITH CHECK holds the system actor test');
SELECT matches((SELECT with_check FROM pg_policies WHERE schemaname = 'reporting' AND tablename = 'provider_events' AND policyname = 'provider_events__update__tenant'), 'is_staff_or_system', 'catalog: WITH CHECK keeps is_staff_or_system (T0B-08 policy shape)');
SELECT ok(has_table_privilege('lims_app', 'reporting.provider_events', 'UPDATE'), 'catalog: the lims_app UPDATE grant stays (C6-T29 apply task)');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'reporting.provider_events'::regclass AND tgname = 'provider_events__mutable_columns' AND NOT tgisinternal), 1, 'catalog: provider_events__mutable_columns trigger still present');

-- ===================================================================================================================================== (a) the system actor stamps an unapplied row once
SELECT is(pg_temp.sysa(pg_temp.stamp(801, 901)), 'n=1', '(a) system actor UPDATE stamping applied_at and delivery_id of an unapplied row changes 1 row');
SELECT is((SELECT delivery_id FROM reporting.provider_events WHERE id = pg_temp.uid(801)), pg_temp.uid(901), '(a) delivery_id of the stamped row is set');
SELECT isnt((SELECT applied_at FROM reporting.provider_events WHERE id = pg_temp.uid(801)), NULL::timestamptz, '(a) applied_at of the stamped row is set');
SELECT is(pg_temp.sysa(format($$UPDATE reporting.provider_events SET applied_at = now(), ignored_reason = 'duplicate' WHERE id = %L$$, pg_temp.uid(806))), 'n=1',
  '(a) system actor UPDATE stamping applied_at and ignored_reason of an unapplied row changes 1 row (the worker may ignore an event)');
SELECT is((SELECT ignored_reason FROM reporting.provider_events WHERE id = pg_temp.uid(806)), 'duplicate', '(a) ignored_reason of the ignored row is set');

-- ===================================================================================================================================== (b) a second UPDATE of an applied row changes nothing
SELECT is(pg_temp.sysa(pg_temp.stamp(801, 902)), 'n=0', '(b) a second system UPDATE of the same, now applied, row changes 0 rows');
SELECT is((SELECT delivery_id FROM reporting.provider_events WHERE id = pg_temp.uid(801)), pg_temp.uid(901), '(b) delivery_id is not re-pointed');
SELECT is(pg_temp.sysa(format($$UPDATE reporting.provider_events SET ignored_reason = 'backwards' WHERE id = %L$$, pg_temp.uid(801))), 'n=0', '(b) an applied row cannot get an ignored_reason afterwards');
SELECT is(pg_temp.sysa(pg_temp.stamp(809, 902)), 'n=0', '(b) a row applied at insert time cannot be re-stamped either');
SELECT is((SELECT delivery_id FROM reporting.provider_events WHERE id = pg_temp.uid(809)), pg_temp.uid(900), '(b) delivery_id of the row applied at insert time is unchanged');
SELECT is((SELECT applied_at FROM reporting.provider_events WHERE id = pg_temp.uid(809)), '2026-01-01T00:00:00Z'::timestamptz, '(b) applied_at of the row applied at insert time is unchanged');
-- an applied row cannot be un-applied either: it is invisible to the UPDATE, so 0 rows and no error
SELECT is(pg_temp.sysa(format($$UPDATE reporting.provider_events SET applied_at = NULL WHERE id = %L$$, pg_temp.uid(801))), 'n=0', '(b) an applied row cannot be reset to unapplied (0 rows)');
SELECT isnt((SELECT applied_at FROM reporting.provider_events WHERE id = pg_temp.uid(801)), NULL::timestamptz, '(b) applied_at is still set after the reset attempt');

-- ===================================================================================================================================== (c) staff user, device and other tenant's system actor change nothing
SELECT is(pg_temp.usra(pg_temp.stamp(802, 903)), 'n=0', '(c) the same UPDATE under user claims changes 0 rows');
SELECT is(pg_temp.deva(pg_temp.stamp(803, 903)), 'n=0', '(c) the same UPDATE under device claims changes 0 rows');
SELECT is(pg_temp.sysb(pg_temp.stamp(805, 903)), 'n=0', '(c) tenant B system actor changes 0 rows of tenant A');
SELECT is(pg_temp.x('lims_app', jsonb_build_object('actor_type', 'portal', 'tenant_id', pg_temp.ta(), 'sub', pg_temp.uid(1)), pg_temp.stamp(802, 903), 'w'), 'n=0', '(c) portal claims change 0 rows');
SELECT is((SELECT count(*)::int FROM reporting.provider_events WHERE id IN (pg_temp.uid(802), pg_temp.uid(803), pg_temp.uid(805)) AND (applied_at IS NOT NULL OR delivery_id IS NOT NULL)), 0, '(c) 802, 803 and 805 are still unapplied');
-- the user and the device still read the rows (SELECT policy unchanged)
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'user'), format('SELECT 1 FROM reporting.provider_events WHERE id = %L', pg_temp.uid(802))), 'n=1', '(c) user claims still read the row (provider_events__select__tenant untouched)');

-- ===================================================================================================================================== (d) the stamp cannot leave applied_at NULL (WITH CHECK)
SELECT alike(pg_temp.sysa(format($$UPDATE reporting.provider_events SET applied_at = NULL, delivery_id = %L WHERE id = %L$$, pg_temp.uid(904), pg_temp.uid(804))), 'E42501|%',
  '(d) a system UPDATE that sets applied_at to NULL on an unapplied row raises 42501');
SELECT alike(pg_temp.sysa(format($$UPDATE reporting.provider_events SET delivery_id = %L WHERE id = %L$$, pg_temp.uid(904), pg_temp.uid(808))), 'E42501|%',
  '(d) a system UPDATE that leaves applied_at NULL (delivery_id only) raises 42501');
SELECT is((SELECT count(*)::int FROM reporting.provider_events WHERE id IN (pg_temp.uid(804), pg_temp.uid(808)) AND (applied_at IS NOT NULL OR delivery_id IS NOT NULL)), 0, '(d) 804 and 808 are unchanged');

-- ===================================================================================================================================== (e) no other column can change (existing mutable-columns trigger)
SELECT alike(pg_temp.sysa(format('UPDATE reporting.provider_events SET %I = %s WHERE id = %L', c.col, c.val, pg_temp.uid(807))), 'EP0001|immutable_row%', '(e) system UPDATE of ' || c.col || ' raises immutable_row')
  FROM (VALUES ('mapped_status', quote_literal('failed')), ('status_raw', quote_literal('changed')), ('provider_kind', quote_literal('other')), ('provider_message_id', quote_literal('other-id')),
    ('occurred_at', 'now()'), ('received_at', $$now() + interval '1 day'$$), ('created_at', $$now() + interval '1 day'$$), ('created_by', quote_literal(pg_temp.uid(1))),
    ('tenant_id', quote_literal(pg_temp.tb())), ('channel_account_id', quote_literal(pg_temp.uid(872))), ('id', quote_literal(pg_temp.uid(899)))) AS c(col, val);
SELECT alike(pg_temp.sysa(format($$UPDATE reporting.provider_events SET applied_at = now(), mapped_status = 'failed' WHERE id = %L$$, pg_temp.uid(807))), 'EP0001|immutable_row%', '(e) the apply columns plus one other column still raise immutable_row');
SELECT is((SELECT count(*)::int FROM reporting.provider_events WHERE id = pg_temp.uid(807) AND applied_at IS NULL AND mapped_status = 'sent' AND status_raw = 'ok'), 1, '(e) 807 is unchanged');

SELECT * FROM finish();
ROLLBACK;
