-- T0C-SYNC-1 pgTAP suite (LD-322; founder blanket authority LD-310; offline requirement 2026-11-17 09:19 NPT; design C:/LIMS-state/offline-design-20261117.md sections 4 and 6) for migration
-- 20261117250000_core__add_sync_devices_and_number_blocks.sql: two tenant tables in schema core (sync_device, number_block) and the widened g_permissions__code__ck (sync.use has two segments).
-- Covers: shape + CHECKs, platform / status / series enums, offline_retention_days default 14, the number block overlap rule (inclusive bounds, per tenant and series, any centre, INSERT and UPDATE),
-- composite tenant FKs, ENABLE + FORCE RLS by tenant, grants (no DELETE), isolation probes (A/B, patient / partner / portal actors), audit, the widened permission code check and seed, idempotent re-apply.
-- Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written by the superuser test session with system claims (audit context),
-- every isolation assertion runs as SET LOCAL ROLE lims_app. Seeds supply tenant A/B (a001/b001), users a300/b300, centres a201/b201, memberships a500/b500.
-- Run: bash db/tests/run-suites.sh db/tests/core/T0C-SYNC-1_sync_devices_blocks.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (brief gives fields, not constraint names; a different choice needs a ruling, not a silent test edit):
--  - Tables core.sync_device and core.number_block with the brief's columns; every table has id, tenant_id, created_at, updated_at NOT NULL; created_by / updated_by are filled when the column exists.
--    sync_device(user_id, device_label, platform web|android|ios, app_version, status active|revoked|wipe_requested default active, first_seen_at, last_seen_at, last_sync_at, wipe_requested_at,
--    wipe_acked_at, last_clock_skew_ms, offline_retention_days default 14 and >= 1); number_block(device_id, series lab_code|patient_id, centre_id, from_value, to_value, issued_at, exhausted_at,
--    skipped_count default 0 and >= 0); from_value / to_value are integer or bigint, 1 <= from_value <= to_value; both ends INCLUSIVE.
--  - ids and tenant_id have no DEFAULT (UUIDv7 in app code). first_seen_at / last_seen_at / issued_at default to now(). The same device id cannot exist twice (PRIMARY KEY (id)); user and device and centre
--    references are composite tenant FKs (a row of another tenant -> 23503).
--  - Overlap: two blocks of one tenant and one series never overlap, whatever the device or centre (trigger or exclusion constraint). Other series and other tenants are independent.
--  - lims_app has SELECT, INSERT, UPDATE and NO DELETE on both tables (revoked and wiped devices stay for the audit trail).
--  - The permission check g_permissions__code__ck accepts 2 or 3 lowercase segments (^[a-z_]+\.[a-z_]+(\.[a-z_]+)?$) and still refuses 1 segment, 4 segments, capitals, digits and empty segments.
--  - Not tested here: status transitions, wipe flow, block size maximum, retention enforcement (service, T0B-SYNC-1); client encryption and wipe (T0D-OFFLINE-*).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c4f0-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
CREATE FUNCTION pg_temp.centre(p_tenant uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_tenant = '01a1a98a-ac40-7000-8000-00000000a001'::uuid THEN pg_temp.id('00000000a201') ELSE pg_temp.id('00000000b201') END $$;
CREATE FUNCTION pg_temp.usr(p_tenant uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_tenant = '01a1a98a-ac40-7000-8000-00000000a001'::uuid THEN pg_temp.id('00000000a300') ELSE pg_temp.id('00000000b300') END $$;
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
CREATE FUNCTION pg_temp.dev(n int, p_tenant uuid, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'user_id', pg_temp.usr(p_tenant), 'device_label', 'Synthetic PC ' || n, 'platform', 'web', 'app_version', '1.4.0') || p_over $$;
CREATE FUNCTION pg_temp.blk(n int, p_tenant uuid, p_dev int, p_series text, p_from bigint, p_to bigint, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'device_id', pg_temp.uid(p_dev), 'series', p_series, 'from_value', p_from, 'to_value', p_to) || p_over $$;
-- insert into core.g_permissions (class G, no tenant) and report 'ok' or the SQLSTATE
CREATE FUNCTION pg_temp.perm(p_code text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO core.g_permissions (code, module, privileged, phase) VALUES (p_code, 'zz_probe', false, '1');
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE; END $f$;

CREATE TEMP TABLE nt(s, t) AS VALUES ('core','sync_device'),('core','number_block');

-- ===================================================================================================================================== shape of the two tables
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
 WHERE c.relname IN (SELECT t FROM nt) AND c.relnamespace = 'core'::regnamespace
   AND NOT (i.indisprimary AND i.indnatts = 1 AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'id');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass(n.s || '.' || n.t) AND k.contype = 'u' AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) = ARRAY['tenant_id','id']), n.t || ' has UNIQUE (tenant_id, id) next to PRIMARY KEY (id)') FROM nt n;
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass(n.s || '.' || n.t) AND k.contype = 'f' AND k.confrelid = 'core.tenants'::regclass), n.t || ' references core.tenants') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = to_regclass(n.s || '.' || n.t) AND a.attname IN ('id','tenant_id') AND a.atthasdef AND NOT a.attisdropped), 0, n.t || ': no DEFAULT on id / tenant_id') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = to_regclass(n.s || '.' || n.t) AND a.attname IN ('id','tenant_id','created_at','updated_at') AND a.attnotnull AND NOT a.attisdropped), 4,
  n.t || ': id, tenant_id, created_at, updated_at are NOT NULL') FROM nt n;
SELECT is((SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = to_regclass(m.s || '.' || m.t) AND a.attname = m.col AND NOT a.attisdropped), m.typ, m.t || '.' || m.col || ' is ' || m.typ)
  FROM (VALUES ('core','sync_device','user_id','uuid'),('core','sync_device','device_label','text'),('core','sync_device','platform','text'),('core','sync_device','app_version','text'),('core','sync_device','status','text'),
               ('core','sync_device','first_seen_at','timestamp with time zone'),('core','sync_device','last_seen_at','timestamp with time zone'),('core','sync_device','last_sync_at','timestamp with time zone'),
               ('core','sync_device','wipe_requested_at','timestamp with time zone'),('core','sync_device','wipe_acked_at','timestamp with time zone'),
               ('core','number_block','device_id','uuid'),('core','number_block','series','text'),('core','number_block','centre_id','uuid'),('core','number_block','issued_at','timestamp with time zone'),
               ('core','number_block','exhausted_at','timestamp with time zone')) m(s, t, col, typ);
SELECT is((SELECT format_type(a.atttypid, a.atttypmod) IN ('integer', 'bigint') FROM pg_attribute a WHERE a.attrelid = to_regclass(m.s || '.' || m.t) AND a.attname = m.col AND NOT a.attisdropped), true, m.t || '.' || m.col || ' is an integer type')
  FROM (VALUES ('core','sync_device','last_clock_skew_ms'),('core','sync_device','offline_retention_days'),('core','number_block','from_value'),('core','number_block','to_value'),('core','number_block','skipped_count')) m(s, t, col);
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = 'core.sync_device'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
            AND a.attname IN ('user_id','device_label','platform','app_version','status','first_seen_at','last_seen_at','offline_retention_days')),
          ARRAY['app_version','device_label','first_seen_at','last_seen_at','offline_retention_days','platform','status','user_id'], 'sync_device: the required columns are NOT NULL');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = 'core.sync_device'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
            AND a.attname IN ('last_sync_at','wipe_requested_at','wipe_acked_at','last_clock_skew_ms')), NULL::text[], 'sync_device: last_sync_at, wipe_requested_at, wipe_acked_at, last_clock_skew_ms are nullable');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = 'core.number_block'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
            AND a.attname IN ('device_id','series','from_value','to_value','issued_at','skipped_count')), ARRAY['device_id','from_value','issued_at','series','skipped_count','to_value'], 'number_block: the required columns are NOT NULL');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = 'core.number_block'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
            AND a.attname IN ('centre_id','exhausted_at')), NULL::text[], 'number_block: centre_id and exhausted_at are nullable');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = to_regclass(n.s || '.' || n.t) AND a.attnum > 0 AND NOT a.attisdropped AND a.atttypid IN ('float4'::regtype, 'float8'::regtype, 'numeric'::regtype, 'money'::regtype)), 0,
  'no float, numeric or money column in ' || n.t) FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_class WHERE relkind = 'S' AND relnamespace = 'core'::regnamespace AND relname ~ 'sync_device|number_block'), 0, 'no sequences (numbers come from reserved blocks, not a sequence)');

-- ===================================================================================================================================== devices
SELECT is(pg_temp.try('core.sync_device', pg_temp.dev(1, pg_temp.ta())), 'ok', 'device A1 (web)');
SELECT is(pg_temp.try('core.sync_device', pg_temp.dev(2, pg_temp.ta(), '{"platform":"android","app_version":"2.0.1"}')), 'ok', 'device A2 (android)');
SELECT is(pg_temp.try('core.sync_device', pg_temp.dev(3, pg_temp.ta(), '{"platform":"ios"}')), 'ok', 'device A3 (ios)');
SELECT is(pg_temp.try('core.sync_device', pg_temp.dev(4, pg_temp.tb())), 'ok', 'device B4');
SELECT is(pg_temp.try('core.sync_device', pg_temp.dev(5, pg_temp.ta(), '{"status":"revoked"}')), 'ok', 'device A5 revoked');
SELECT is(pg_temp.try('core.sync_device', pg_temp.dev(6, pg_temp.ta(), '{"status":"wipe_requested","wipe_requested_at":"2026-11-17T10:00:00Z"}')), 'ok', 'device A6 wipe requested');
SELECT is((SELECT status FROM core.sync_device WHERE id = pg_temp.uid(1)), 'active', 'a device is active by default');
SELECT is((SELECT offline_retention_days FROM core.sync_device WHERE id = pg_temp.uid(1)), 14, 'offline_retention_days defaults to 14 (design section 6)');
SELECT ok((SELECT first_seen_at IS NOT NULL AND last_seen_at IS NOT NULL FROM core.sync_device WHERE id = pg_temp.uid(1)), 'first_seen_at and last_seen_at default to now()');
SELECT is((SELECT last_sync_at FROM core.sync_device WHERE id = pg_temp.uid(1)), NULL::timestamptz, 'last_sync_at is empty until the first sync');
SELECT is(pg_temp.try('core.sync_device', pg_temp.dev(1, pg_temp.ta())), '23505', 'the same device id twice -> unique_violation (registerSyncDevice is idempotent in the service)');
SELECT is(pg_temp.try('core.sync_device', pg_temp.dev(1, pg_temp.tb())), '23505', 'a device id is global: tenant B cannot reuse the id of a tenant A device');
SELECT isnt(pg_temp.try('core.sync_device', pg_temp.dev(10 + t.i, pg_temp.ta(), t.o)), 'ok', t.lbl)
  FROM (VALUES (1, '{"platform":"windows"}'::jsonb, 'platform outside web|android|ios rejected'), (2, '{"platform":"Web"}'::jsonb, 'platform is case sensitive'), (3, '{"platform":null}'::jsonb, 'NULL platform rejected'),
               (4, '{"status":"deleted"}'::jsonb, 'status outside active|revoked|wipe_requested rejected'), (5, '{"status":null}'::jsonb, 'NULL status rejected'), (6, '{"device_label":""}'::jsonb, 'empty label rejected'),
               (7, jsonb_build_object('device_label', repeat('l', 1000)), 'oversize label rejected'), (8, '{"app_version":""}'::jsonb, 'empty app_version rejected'), (9, jsonb_build_object('app_version', repeat('9', 200)), 'oversize app_version rejected'),
               (10, '{"offline_retention_days":0}'::jsonb, 'retention 0 days rejected'), (11, '{"offline_retention_days":-3}'::jsonb, 'negative retention rejected'), (12, '{"user_id":null}'::jsonb, 'NULL user_id rejected')) t(i, o, lbl);
SELECT is(pg_temp.try('core.sync_device', pg_temp.dev(30, pg_temp.ta(), '{"offline_retention_days":30,"last_clock_skew_ms":-90000,"last_sync_at":"2026-11-17T09:00:00Z"}')), 'ok', 'retention 30, a negative clock skew (device behind the server) and last_sync_at accepted');
SELECT is(pg_temp.try('core.sync_device', pg_temp.dev(31, pg_temp.ta(), jsonb_build_object('user_id', pg_temp.usr(pg_temp.tb())))), '23503', 'a user of another tenant -> foreign_key_violation (composite tenant FK)');
SELECT is(pg_temp.try('core.sync_device', pg_temp.dev(32, pg_temp.ta(), jsonb_build_object('user_id', pg_temp.uid(9999)))), '23503', 'an unknown user -> foreign_key_violation');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_device SET status = 'revoked' WHERE id = %L $$, pg_temp.uid(1))) ~ '^n=1', true, 'lims_app can revoke a device (UPDATE)');
SELECT is((SELECT status FROM core.sync_device WHERE id = pg_temp.uid(1)), 'revoked', 'the device is revoked');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_device SET status = 'gone' WHERE id = %L $$, pg_temp.uid(2))) ~ '^E23514', true, 'update to an unknown status -> check_violation');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_device SET status = 'wipe_requested', wipe_requested_at = now() WHERE id = %L $$, pg_temp.uid(2))) ~ '^n=1', true, 'lims_app can request a wipe');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_device SET wipe_acked_at = now(), last_sync_at = now(), last_clock_skew_ms = 1200 WHERE id = %L $$, pg_temp.uid(2))) ~ '^n=1', true, 'lims_app can record the wipe ack, last sync and clock skew');
SELECT is(pg_temp.a(format($$ DELETE FROM core.sync_device WHERE id = %L $$, pg_temp.uid(3))) ~ '^E42501', true, 'lims_app cannot delete a device (revoke keeps the row for the audit trail)');

-- ===================================================================================================================================== number blocks: no overlap per tenant and series
SELECT is(pg_temp.try('core.number_block', pg_temp.blk(101, pg_temp.ta(), 3, 'lab_code', 1, 200)), 'ok', 'block 101: lab_code 1..200 (device A3)');
SELECT is(pg_temp.try('core.number_block', pg_temp.blk(102, pg_temp.ta(), 6, 'lab_code', 201, 400)), 'ok', 'block 102: lab_code 201..400 (adjacent, another device)');
SELECT is(pg_temp.try('core.number_block', pg_temp.blk(103, pg_temp.ta(), 3, 'patient_id', 1, 100)), 'ok', 'block 103: patient_id 1..100 (another series: independent ranges)');
SELECT is(pg_temp.try('core.number_block', pg_temp.blk(104, pg_temp.tb(), 4, 'lab_code', 1, 200)), 'ok', 'block B104: lab_code 1..200 in tenant B (same numbers, another tenant)');
SELECT is(pg_temp.try('core.number_block', pg_temp.blk(105, pg_temp.ta(), 3, 'lab_code', 401, 600, jsonb_build_object('centre_id', pg_temp.centre(pg_temp.ta())))), 'ok', 'block 105: lab_code 401..600 with a centre');
SELECT is((SELECT skipped_count FROM core.number_block WHERE id = pg_temp.uid(101)), 0, 'skipped_count defaults to 0');
SELECT is((SELECT exhausted_at FROM core.number_block WHERE id = pg_temp.uid(101)), NULL::timestamptz, 'exhausted_at is empty while numbers remain');
SELECT ok((SELECT issued_at IS NOT NULL FROM core.number_block WHERE id = pg_temp.uid(101)), 'issued_at defaults to now()');
SELECT isnt(pg_temp.try('core.number_block', pg_temp.blk(110, pg_temp.ta(), 3, 'lab_code', 200, 250)), 'ok', 'overlap on the shared number 200 (inclusive upper bound) refused');
SELECT isnt(pg_temp.try('core.number_block', pg_temp.blk(111, pg_temp.ta(), 6, 'lab_code', 150, 160)), 'ok', 'a range inside block 101 refused (another device)');
SELECT isnt(pg_temp.try('core.number_block', pg_temp.blk(112, pg_temp.ta(), 3, 'lab_code', 1, 1)), 'ok', 'the single number 1 refused');
SELECT isnt(pg_temp.try('core.number_block', pg_temp.blk(113, pg_temp.ta(), 3, 'lab_code', 190, 410)), 'ok', 'a range spanning two existing blocks refused');
SELECT isnt(pg_temp.try('core.number_block', pg_temp.blk(114, pg_temp.ta(), 3, 'lab_code', 600, 700)), 'ok', 'overlap on the shared number 600 (inclusive lower bound) refused');
SELECT isnt(pg_temp.try('core.number_block', pg_temp.blk(115, pg_temp.ta(), 3, 'lab_code', 1, 200, jsonb_build_object('centre_id', pg_temp.centre(pg_temp.ta())))), 'ok', 'the same range at another centre refused (the rule ignores the centre)');
SELECT isnt(pg_temp.try('core.number_block', pg_temp.blk(116, pg_temp.ta(), 6, 'lab_code', 0, 0)), 'ok', 'number 0 refused (blocks start at 1)');
SELECT is(pg_temp.try('core.number_block', pg_temp.blk(117, pg_temp.ta(), 6, 'lab_code', 601, 800)), 'ok', 'the next free range 601..800 is accepted');
SELECT is(pg_temp.try('core.number_block', pg_temp.blk(118, pg_temp.ta(), 6, 'lab_code', 2000000000, 2000000099)), 'ok', 'a block above 2^31 - 1 is accepted when the columns are bigint')
  WHERE (SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'core.number_block'::regclass AND attname = 'to_value') = 'bigint';
SELECT isnt(pg_temp.try('core.number_block', pg_temp.blk(120 + t.i, pg_temp.ta(), 6, t.s, t.f, t.t, t.o)), 'ok', t.lbl)
  FROM (VALUES (1, 'lab_code', 900::bigint, 899::bigint, '{}'::jsonb, 'from_value above to_value rejected'), (2, 'lab_code', -5::bigint, 10::bigint, '{}'::jsonb, 'negative from_value rejected'),
               (3, 'bill_no', 5000::bigint, 5100::bigint, '{}'::jsonb, 'series bill_no rejected (bill numbers are provisional, never blocks)'), (4, 'invoice', 5000::bigint, 5100::bigint, '{}'::jsonb, 'series invoice rejected'),
               (5, 'Lab_Code', 5000::bigint, 5100::bigint, '{}'::jsonb, 'series is case sensitive'), (6, 'lab_code', 5000::bigint, 5100::bigint, '{"skipped_count":-1}'::jsonb, 'negative skipped_count rejected'),
               (7, 'lab_code', 5000::bigint, 5100::bigint, '{"series":null}'::jsonb, 'NULL series rejected'), (8, 'lab_code', 5000::bigint, 5100::bigint, '{"device_id":null}'::jsonb, 'NULL device_id rejected')) t(i, s, f, t, o, lbl);
SELECT is(pg_temp.try('core.number_block', pg_temp.blk(140, pg_temp.ta(), 4, 'lab_code', 7000, 7100)), '23503', 'a device of another tenant -> foreign_key_violation (composite tenant FK)');
SELECT is(pg_temp.try('core.number_block', pg_temp.blk(141, pg_temp.ta(), 9999, 'lab_code', 7000, 7100)), '23503', 'an unknown device -> foreign_key_violation');
SELECT is(pg_temp.try('core.number_block', pg_temp.blk(142, pg_temp.ta(), 3, 'lab_code', 7000, 7100, jsonb_build_object('centre_id', pg_temp.centre(pg_temp.tb())))), '23503', 'a centre of another tenant -> foreign_key_violation');
SELECT is(pg_temp.a(format($$ UPDATE core.number_block SET exhausted_at = now(), skipped_count = 17 WHERE id = %L $$, pg_temp.uid(101))) ~ '^n=1', true, 'recording exhaustion and skipped numbers (UPDATE) is allowed');
SELECT is((SELECT skipped_count FROM core.number_block WHERE id = pg_temp.uid(101)), 17, 'skipped_count is recorded');
SELECT is(pg_temp.a(format($$ UPDATE core.number_block SET to_value = 250 WHERE id = %L $$, pg_temp.uid(101))) ~ '^E', true, 'growing a block into its neighbour (UPDATE) refused');
SELECT is((SELECT to_value::int FROM core.number_block WHERE id = pg_temp.uid(101)), 200, 'a refused UPDATE leaves the block unchanged');
SELECT is(pg_temp.a(format($$ UPDATE core.number_block SET to_value = 150 WHERE id = %L $$, pg_temp.uid(101))) ~ '^n=1', true, 'shrinking a block is allowed');
SELECT is(pg_temp.try('core.number_block', pg_temp.blk(143, pg_temp.ta(), 6, 'lab_code', 151, 160)), 'ok', 'after shrinking, the freed numbers can be issued again');
SELECT is(pg_temp.a(format($$ DELETE FROM core.number_block WHERE id = %L $$, pg_temp.uid(101))) ~ '^E42501', true, 'lims_app cannot delete a block (numbers are never reissued)');

-- ===================================================================================================================================== tenant isolation (RLS probes)
CREATE TEMP TABLE probe(s, t, a_id, b_id) AS VALUES ('core','sync_device', pg_temp.uid(2), pg_temp.uid(4)), ('core','number_block', pg_temp.uid(102), pg_temp.uid(104));
SELECT is(pg_temp.a(format('SELECT 1 FROM %s.%s WHERE id = %L', p.s, p.t, p.a_id), 'n'), 'n=1', 'tenant A sees its own row of ' || p.t) FROM probe p;
SELECT is(pg_temp.a(format('SELECT 1 FROM %s.%s WHERE id = %L', p.s, p.t, p.b_id), 'n'), 'n=0', 'tenant A cannot see the tenant B row of ' || p.t) FROM probe p;
SELECT is(pg_temp.b(format('SELECT 1 FROM %s.%s WHERE id = %L', p.s, p.t, p.a_id), 'n'), 'n=0', 'tenant B cannot see the tenant A row of ' || p.t) FROM probe p;
SELECT is(pg_temp.a(format('SELECT 1 FROM %s.%s WHERE tenant_id = %L', p.s, p.t, pg_temp.tb()), 'n'), 'n=0', 'filtering on the other tenant id still returns nothing for ' || p.t) FROM probe p;
SELECT is(pg_temp.a(format($$ UPDATE core.sync_device SET status = 'revoked' WHERE id = %L $$, pg_temp.uid(4))), 'n=0', 'tenant A cannot revoke the tenant B device (0 rows)');
SELECT is(pg_temp.a(format($$ UPDATE core.number_block SET skipped_count = 5 WHERE id = %L $$, pg_temp.uid(104))), 'n=0', 'tenant A cannot change the tenant B block (0 rows)');
SELECT alike(pg_temp.a(format($$ INSERT INTO core.sync_device (id, tenant_id, user_id, device_label, platform, app_version, created_by, updated_by) VALUES (%L, %L, %L, 'x', 'web', '1', %L, %L) $$,
  pg_temp.uid(500), pg_temp.tb(), pg_temp.usr(pg_temp.tb()), pg_temp.sys(), pg_temp.sys())), 'E42501|%', 'tenant A cannot register a device for tenant B');
SELECT alike(pg_temp.a(format($$ INSERT INTO core.number_block (id, tenant_id, device_id, series, from_value, to_value) VALUES (%L, %L, %L, 'lab_code', 9000, 9100) $$, pg_temp.uid(501), pg_temp.tb(), pg_temp.uid(4))), 'E42501|%',
  'tenant A cannot reserve a block for tenant B');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format('SELECT 1 FROM %s.%s', p.s, p.t), 'n'), 'n=0', 'a ' || r.k || '-actor sees 0 rows of ' || p.t) FROM probe p CROSS JOIN (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ INSERT INTO core.sync_device (id, tenant_id, user_id, device_label, platform, app_version, created_by, updated_by) VALUES (%L, %L, %L, 'x', 'web', '1', %L, %L) $$,
  pg_temp.uid(510), pg_temp.ta(), pg_temp.usr(pg_temp.ta()), pg_temp.sys(), pg_temp.sys()), 'w'), 'E42501|%', 'a ' || r.k || '-actor cannot register a device') FROM (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ INSERT INTO core.number_block (id, tenant_id, device_id, series, from_value, to_value) VALUES (%L, %L, %L, 'lab_code', 9500, 9600) $$,
  pg_temp.uid(511), pg_temp.ta(), pg_temp.uid(2)), 'w'), 'E42501|%', 'a ' || r.k || '-actor cannot reserve a block') FROM (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ UPDATE core.sync_device SET status = 'revoked' WHERE id = %L $$, pg_temp.uid(2)), 'w'), 'n=0',
  'a ' || r.k || '-actor cannot change a device (0 rows)') FROM (VALUES ('patient'),('partner'),('portal')) r(k);

-- ===================================================================================================================================== audit
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = x.s AND table_name = x.t AND row_id = x.rid AND action = 'INSERT'), 1, 'control: INSERT into ' || x.t || ' is audited')
  FROM (VALUES ('core','sync_device', pg_temp.uid(2)), ('core','number_block', pg_temp.uid(102))) x(s, t, rid);
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = to_regclass(n.s || '.' || n.t) AND NOT tgisinternal AND pg_get_triggerdef(oid) ~ 'tg_row_audit'), 1, n.t || ' has one audit trigger') FROM nt n;
SELECT ok(EXISTS (SELECT 1 FROM audit.audit_log WHERE schema_name = 'core' AND table_name = 'sync_device' AND row_id = pg_temp.uid(1) AND action = 'UPDATE' AND 'status' = ANY (changed_columns)),
  'revoking a device is recorded as a changed status (who revoked which device)');
SELECT ok(EXISTS (SELECT 1 FROM audit.audit_log WHERE schema_name = 'core' AND table_name = 'sync_device' AND row_id = pg_temp.uid(2) AND action = 'UPDATE' AND 'wipe_acked_at' = ANY (changed_columns)),
  'the wipe acknowledgement is recorded');

-- ===================================================================================================================================== permission codes: sync.use has two segments (g_permissions__code__ck widened)
SELECT is((SELECT count(*)::int FROM core.g_permissions WHERE code IN ('sync.use', 'sync.device.manage', 'sync.conflict.resolve')), 3, 'the three sync permission codes are seeded in core.g_permissions');
SELECT is((SELECT privileged FROM core.g_permissions WHERE code = 'sync.use'), false, 'sync.use is not privileged');
SELECT is((SELECT privileged FROM core.g_permissions WHERE code = 'sync.device.manage'), true, 'sync.device.manage is privileged');
SELECT is((SELECT privileged FROM core.g_permissions WHERE code = 'sync.conflict.resolve'), true, 'sync.conflict.resolve is privileged');
SELECT is(pg_temp.perm('zz_probe.use'), 'ok', 'a two segment code is accepted by the widened check');
SELECT is(pg_temp.perm('zz_probe.thing.act'), 'ok', 'a three segment code is still accepted');
SELECT is(pg_temp.perm(c), '23514', 'the widened check still refuses ' || quote_literal(c)) FROM unnest(ARRAY['zz_probe', 'zz.a.b.c', 'ZZ.a.b', 'zz.A', 'zz..b', '.zz.a', 'zz.a.', 'zz.a1', 'zz.a-b', '']) c;
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'core.g_permissions'::regclass AND conname = 'g_permissions__code__ck'), 1, 'exactly one g_permissions__code__ck');
SELECT ok((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'core.g_permissions'::regclass AND conname = 'g_permissions__code__ck') ~ '\?', 'the check has an optional third segment');
SELECT is((SELECT count(*)::int FROM core.g_permissions WHERE code !~ '^[a-z_]+\.[a-z_]+(\.[a-z_]+)?$' AND module <> 'zz_probe'), 0, 'every seeded code fits the widened pattern');

-- ===================================================================================================================================== idempotent re-apply: second run changes nothing
CREATE FUNCTION pg_temp.state() RETURNS text LANGUAGE sql AS $$
  SELECT concat_ws('|',
    (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r' AND c.relnamespace = 'core'::regnamespace),
    (SELECT count(*) FROM pg_class WHERE relkind = 'r' AND relnamespace = 'core'::regnamespace),
    (SELECT count(*) FROM pg_constraint WHERE connamespace = 'core'::regnamespace),
    (SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), ';' ORDER BY conname) FROM pg_constraint WHERE conrelid IN ('core.g_permissions'::regclass, 'core.sync_device'::regclass, 'core.number_block'::regclass)),
    (SELECT count(*) FROM pg_index WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'core'::regnamespace)),
    (SELECT count(*) FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'core'::regnamespace)),
    (SELECT string_agg(pg_get_triggerdef(oid), ';' ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger WHERE tgrelid IN ('core.sync_device'::regclass, 'core.number_block'::regclass) AND NOT tgisinternal),
    (SELECT count(*) FROM core.sync_device), (SELECT count(*) FROM core.number_block), (SELECT count(*) FROM core.g_permissions)) $$;
CREATE TEMP TABLE before_state AS SELECT pg_temp.state() AS s;
\ir ../../migrations/20261117250000_core__add_sync_devices_and_number_blocks.sql
RESET ROLE;
SELECT is(pg_temp.state(), (SELECT s FROM before_state), 're-apply: tables, columns, constraints, indexes, policies, triggers and row counts are unchanged');
SELECT is((SELECT status FROM core.sync_device WHERE id = pg_temp.uid(1)), 'revoked', 're-apply: no data rewrite (device status intact)');
SELECT is((SELECT skipped_count FROM core.number_block WHERE id = pg_temp.uid(101)), 17, 're-apply: no data rewrite (skipped_count intact)');
SELECT is(has_table_privilege('lims_app', 'core.sync_device', 'DELETE'), false, 're-apply keeps DELETE revoked');
SELECT is(pg_temp.perm('zz_probe.reapply'), 'ok', 're-apply keeps the widened permission check');

SELECT * FROM finish();
ROLLBACK;
