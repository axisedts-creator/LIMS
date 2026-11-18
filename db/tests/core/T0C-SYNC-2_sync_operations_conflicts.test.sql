-- T0C-SYNC-2 pgTAP suite (LD-322; founder blanket authority LD-310; offline requirement 2026-11-17 09:19 NPT; design C:/LIMS-state/offline-design-20261117.md sections 2, 3, 5, 8) for migration
-- 20261117260000_core__add_sync_operations_and_conflicts.sql: two tenant tables in schema core (sync_operation, sync_conflict).
-- Covers: shape + CHECKs, the closed op_type catalogue (8 types) and the four outcomes, PRIMARY KEY (tenant_id, op_id) (op_id is the idempotency key, per tenant), composite tenant FKs, the append only rule
-- (the outcome of an operation is written once; op_id, payload, payload_hash, op_type, device, user, base_version and both timestamps never change; no DELETE), conflict resolution consistency
-- (open | resolved, resolved rows carry resolution + resolver + time + reason and are frozen), ENABLE + FORCE RLS by tenant, grants, isolation probes (A/B, patient / partner / portal actors), audit of conflicts,
-- no new permission code, idempotent re-apply. Synthetic data only. One rolled-back transaction. RLS is never disabled: fixtures are written by the superuser test session with system claims (audit
-- context), every isolation assertion runs as SET LOCAL ROLE lims_app. Seeds supply tenant A/B (a001/b001), users a300/b300, centres a201/b201, memberships a500/b500.
-- Run: bash db/tests/run-suites.sh db/tests/core/T0C-SYNC-2_sync_operations_conflicts.test.sql   (docker; migrations + seeds loaded)
-- ASSUMPTIONS (the brief gives fields, not constraint names; a different choice needs a ruling, not a silent test edit):
--  - core.sync_operation(tenant_id, op_id uuid, device_id, user_id, op_type, base_version integer NULL, payload_hash text, payload jsonb, device_created_at, server_received_at default now(), status, result jsonb NULL,
--    error_code text NULL, skew_flag boolean NOT NULL default false, created_at default now()); PRIMARY KEY (tenant_id, op_id), no id column. op_type is one of the 8 catalogue types (CHECK), status one of
--    accepted | duplicate | rejected | conflict (CHECK), base_version >= 1 when present, payload is a JSON object, payload_hash is not empty. (device, tenant) and (user, tenant) are composite tenant FKs.
--  - Append only: lims_app may write the outcome (status, result, error_code) ONCE, while result IS NULL; every other column is frozen; DELETE is refused (42501). How (column grants or a BEFORE UPDATE trigger)
--    is the implementer's choice; only the behaviour is tested (any error on a refused write).
--  - core.sync_conflict(id, tenant_id, op_id, entity_type, entity_id, local_payload jsonb, server_payload jsonb, status open|resolved default open, resolution keep_server|apply_local|merge NULL, resolved_by NULL,
--    resolved_at NULL, reason NULL, created_at, updated_at, created_by, updated_by): ids and tenant_id have no DEFAULT. Open: resolution, resolved_by, resolved_at, reason are all NULL. Resolved: all four are
--    set and reason is not empty. A resolved conflict never changes again; lims_app has SELECT, INSERT, UPDATE and no DELETE. Row audit trigger on sync_conflict (not on sync_operation: its payload would be
--    copied into the audit log, and the table is itself the ledger).
--  - Not tested here: the 50 operation / 1 MB limits, clock skew thresholds, payload hash comparison (sync.op_id_reused), verification policy re-check, numbering (service, T0B-SYNC-2..5), version columns of old
--    tables (static test in tools/codegen/__tests__/sync2-openapi.test.ts; a re-apply here proves they are guarded).
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();

CREATE FUNCTION pg_temp.ta() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000a001'::uuid $$;
CREATE FUNCTION pg_temp.tb() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1a98a-ac40-7000-8000-00000000b001'::uuid $$;
CREATE FUNCTION pg_temp.sys() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '01a1b34e-1000-7eee-9d29-d7ca59a102b5'::uuid $$;
CREATE FUNCTION pg_temp.uid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('0190c4f0-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
CREATE FUNCTION pg_temp.id(s text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01a1a98a-ac40-7000-8000-' || s)::uuid $$;
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
-- row builders (p_over is merged last): devices (needed as FK targets), operations, conflicts
CREATE FUNCTION pg_temp.dev(n int, p_tenant uuid) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(n), 'tenant_id', p_tenant, 'user_id', pg_temp.usr(p_tenant), 'device_label', 'Synthetic PC ' || n, 'platform', 'web', 'app_version', '1.4.0') $$;
CREATE FUNCTION pg_temp.op(n int, p_tenant uuid, p_dev int, p_type text, p_status text DEFAULT 'accepted', p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('tenant_id', p_tenant, 'op_id', pg_temp.uid(1000 + n), 'device_id', pg_temp.uid(p_dev), 'user_id', pg_temp.usr(p_tenant), 'op_type', p_type, 'payload_hash', repeat('ab', 32),
    'payload', jsonb_build_object('synthetic', true, 'n', n), 'device_created_at', '2026-11-17T08:00:00Z'::timestamptz, 'server_received_at', '2026-11-17T10:00:00Z'::timestamptz, 'status', p_status) || p_over $$;
CREATE FUNCTION pg_temp.cf(n int, p_tenant uuid, p_op int, p_over jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', pg_temp.uid(2000 + n), 'tenant_id', p_tenant, 'op_id', pg_temp.uid(1000 + p_op), 'entity_type', 'patient', 'entity_id', pg_temp.uid(3000 + n),
    'local_payload', jsonb_build_object('phone_present', true), 'server_payload', jsonb_build_object('phone_present', false)) || p_over $$;

CREATE TEMP TABLE nt(s, t) AS VALUES ('core','sync_operation'),('core','sync_conflict');
CREATE TEMP TABLE cat(t) AS VALUES ('registration.create_order'),('billing.record_receipt'),('collection.mark_collected'),('accession.receive'),('result.enter'),('result.verify'),('report.print_marker'),('daily_cash.close');

-- fixture devices (table of T0C-SYNC-1)
SELECT is(pg_temp.try('core.sync_device', pg_temp.dev(1, pg_temp.ta())), 'ok', 'fixture device A1');
SELECT is(pg_temp.try('core.sync_device', pg_temp.dev(2, pg_temp.ta())), 'ok', 'fixture device A2');
SELECT is(pg_temp.try('core.sync_device', pg_temp.dev(4, pg_temp.tb())), 'ok', 'fixture device B4');

-- ===================================================================================================================================== shape of the two tables
SELECT is((SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = n.s) AND c.relname = n.t AND c.relkind = 'r'), 1, n.s || '.' || n.t || ' exists') FROM nt n;
SELECT is((SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid = to_regclass(n.s || '.' || n.t)), true, n.t || ' ENABLE + FORCE row level security') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = n.s AND p.tablename = n.t AND p.roles <> ARRAY['lims_app']::name[]), 0, 'every policy on ' || n.t || ' is TO lims_app only') FROM nt n;
SELECT ok((SELECT count(*) FROM pg_policy p WHERE p.polrelid = to_regclass(n.s || '.' || n.t)) >= 3, n.t || ' has SELECT, INSERT and UPDATE policies') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = to_regclass(n.s || '.' || n.t)
            AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) !~ 'tenant_id = '), 0, 'every ' || n.t || ' policy is tenant_id-scoped') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = n.s AND p.tablename = n.t AND p.cmd IN ('DELETE', 'ALL')), 0, n.t || ' has no DELETE / ALL policy') FROM nt n;
SELECT is(has_table_privilege('lims_app', to_regclass(n.s || '.' || n.t), x.priv), x.want, 'lims_app ' || x.priv || ' on ' || n.t || ' = ' || x.want)
  FROM nt n CROSS JOIN (VALUES ('SELECT', true), ('INSERT', true), ('DELETE', false), ('TRUNCATE', false)) x(priv, want);
SELECT is(has_table_privilege('lims_app', 'core.sync_conflict', 'UPDATE'), true, 'lims_app can UPDATE sync_conflict (resolution)');
SELECT ok(has_any_column_privilege('lims_app', 'core.sync_operation', 'UPDATE'), 'lims_app can UPDATE at least the outcome columns of sync_operation');
SELECT is(coalesce(has_table_privilege(r.role, to_regclass(n.s || '.' || n.t), 'SELECT'), false), false, r.role || ' has no grant on ' || n.t) FROM nt n CROSS JOIN (VALUES ('anon'),('authenticated')) r(role)
  WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role);
SELECT is((SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]), 'tenant_id', '§9 test 2: ' || c.relname || ' index ' || ic.relname || ' leads with tenant_id')
  FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid
 WHERE c.relname IN (SELECT t FROM nt) AND c.relnamespace = 'core'::regnamespace
   AND NOT (i.indisprimary AND i.indnatts = 1 AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'id');
SELECT is((SELECT array_agg(a.attname::text ORDER BY x.ord) FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY x(attnum, ord) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum
            WHERE k.conrelid = 'core.sync_operation'::regclass AND k.contype = 'p'), ARRAY['tenant_id','op_id'], 'sync_operation: PRIMARY KEY (tenant_id, op_id): op_id is the idempotency key per tenant');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'core.sync_operation'::regclass AND a.attname = 'id' AND NOT a.attisdropped), 0, 'sync_operation has no separate id column');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = 'core.sync_conflict'::regclass AND k.contype = 'u' AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum) = ARRAY['tenant_id','id']), 'sync_conflict has UNIQUE (tenant_id, id) next to PRIMARY KEY (id)');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = to_regclass(n.s || '.' || n.t) AND k.contype = 'f' AND k.confrelid = 'core.tenants'::regclass), n.t || ' references core.tenants') FROM nt n;
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'core.sync_conflict'::regclass AND a.attname IN ('id','tenant_id') AND a.atthasdef AND NOT a.attisdropped), 0, 'sync_conflict: no DEFAULT on id / tenant_id');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'core.sync_operation'::regclass AND a.attname IN ('tenant_id','op_id') AND a.atthasdef AND NOT a.attisdropped), 0, 'sync_operation: no DEFAULT on tenant_id / op_id (the device makes the op_id)');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'core.sync_conflict'::regclass AND a.attname IN ('id','tenant_id','created_at','updated_at') AND a.attnotnull AND NOT a.attisdropped), 4, 'sync_conflict: id, tenant_id, created_at, updated_at are NOT NULL');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = 'core.sync_operation'::regclass AND a.attname IN ('tenant_id','op_id','created_at') AND a.attnotnull AND NOT a.attisdropped), 3, 'sync_operation: tenant_id, op_id, created_at are NOT NULL');
SELECT is((SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a WHERE a.attrelid = to_regclass(m.s || '.' || m.t) AND a.attname = m.col AND NOT a.attisdropped), m.typ, m.t || '.' || m.col || ' is ' || m.typ)
  FROM (VALUES ('core','sync_operation','device_id','uuid'),('core','sync_operation','user_id','uuid'),('core','sync_operation','op_type','text'),('core','sync_operation','payload_hash','text'),('core','sync_operation','payload','jsonb'),
               ('core','sync_operation','device_created_at','timestamp with time zone'),('core','sync_operation','server_received_at','timestamp with time zone'),('core','sync_operation','status','text'),
               ('core','sync_operation','result','jsonb'),('core','sync_operation','error_code','text'),('core','sync_operation','skew_flag','boolean'),
               ('core','sync_conflict','op_id','uuid'),('core','sync_conflict','entity_type','text'),('core','sync_conflict','entity_id','uuid'),('core','sync_conflict','local_payload','jsonb'),('core','sync_conflict','server_payload','jsonb'),
               ('core','sync_conflict','status','text'),('core','sync_conflict','resolution','text'),('core','sync_conflict','resolved_by','uuid'),('core','sync_conflict','resolved_at','timestamp with time zone'),('core','sync_conflict','reason','text')) m(s, t, col, typ);
SELECT is((SELECT format_type(a.atttypid, a.atttypmod) IN ('integer', 'bigint') FROM pg_attribute a WHERE a.attrelid = 'core.sync_operation'::regclass AND a.attname = 'base_version' AND NOT a.attisdropped), true, 'sync_operation.base_version is an integer type');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = 'core.sync_operation'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
            AND a.attname IN ('device_id','user_id','op_type','payload_hash','payload','device_created_at','server_received_at','status','skew_flag')),
          ARRAY['device_created_at','device_id','op_type','payload','payload_hash','server_received_at','skew_flag','status','user_id'], 'sync_operation: the required columns are NOT NULL');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = 'core.sync_operation'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
            AND a.attname IN ('base_version','result','error_code')), NULL::text[], 'sync_operation: base_version, result, error_code are nullable (unwritten outcome)');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = 'core.sync_conflict'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
            AND a.attname IN ('op_id','entity_type','entity_id','local_payload','server_payload','status')), ARRAY['entity_id','entity_type','local_payload','op_id','server_payload','status'], 'sync_conflict: the required columns are NOT NULL');
SELECT is((SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = 'core.sync_conflict'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
            AND a.attname IN ('resolution','resolved_by','resolved_at','reason')), NULL::text[], 'sync_conflict: resolution, resolved_by, resolved_at, reason are nullable');
SELECT is((SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = to_regclass(n.s || '.' || n.t) AND a.attnum > 0 AND NOT a.attisdropped AND a.atttypid IN ('float4'::regtype, 'float8'::regtype, 'numeric'::regtype, 'money'::regtype)), 0,
  'no float, numeric or money column in ' || n.t) FROM nt n;

-- ===================================================================================================================================== sync_operation: closed catalogue, outcomes, key
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(c.i::int, pg_temp.ta(), 1, c.t)), 'ok', 'op_type ' || c.t || ' accepted') FROM (SELECT t, row_number() OVER () AS i FROM cat) c;
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(20 + s.i::int, pg_temp.ta(), 1, 'result.enter', s.t)), 'ok', 'status ' || s.t || ' accepted') FROM (SELECT t, row_number() OVER () AS i FROM (VALUES ('accepted'),('duplicate'),('rejected'),('conflict')) v(t)) s;
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(40, pg_temp.tb(), 4, 'result.enter')), 'ok', 'tenant B operation');
SELECT isnt(pg_temp.try('core.sync_operation', pg_temp.op(50 + t.i, pg_temp.ta(), 1, 'result.enter', 'accepted', t.o)), 'ok', t.lbl)
  FROM (VALUES (1, '{"op_type":"user.delete"}'::jsonb, 'op_type outside the closed catalogue rejected (user.delete)'), (2, '{"op_type":"Result.Enter"}'::jsonb, 'op_type is case sensitive'), (3, '{"op_type":null}'::jsonb, 'NULL op_type rejected'),
               (4, '{"op_type":""}'::jsonb, 'empty op_type rejected'), (5, '{"op_type":"patient.merge"}'::jsonb, 'patient.merge is not an offline operation'),
               (6, '{"status":"pending"}'::jsonb, 'status outside accepted|duplicate|rejected|conflict rejected'), (7, '{"status":"Accepted"}'::jsonb, 'status is case sensitive'), (8, '{"status":null}'::jsonb, 'NULL status rejected'),
               (9, '{"payload_hash":""}'::jsonb, 'empty payload_hash rejected'), (10, '{"payload_hash":null}'::jsonb, 'NULL payload_hash rejected'), (11, '{"payload":null}'::jsonb, 'NULL payload rejected'),
               (12, '{"payload":[1,2]}'::jsonb, 'a JSON array payload rejected (payload is an object)'), (13, '{"payload":"text"}'::jsonb, 'a JSON string payload rejected'),
               (14, '{"base_version":0}'::jsonb, 'base_version 0 rejected (versions start at 1)'), (15, '{"base_version":-2}'::jsonb, 'negative base_version rejected'),
               (16, '{"device_created_at":null}'::jsonb, 'NULL device_created_at rejected'), (17, '{"server_received_at":null}'::jsonb, 'NULL server_received_at rejected'),
               (18, '{"device_id":null}'::jsonb, 'NULL device_id rejected'), (19, '{"user_id":null}'::jsonb, 'NULL user_id rejected'), (20, '{"op_id":null}'::jsonb, 'NULL op_id rejected')) t(i, o, lbl);
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(60, pg_temp.ta(), 1, 'result.verify', 'accepted', '{"base_version":7}')), 'ok', 'base_version 7 accepted (the entity version the user saw)');
SELECT is((SELECT base_version FROM core.sync_operation WHERE op_id = pg_temp.uid(1060)), 7, 'base_version is stored as sent');
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(61, pg_temp.ta(), 1, 'result.enter')), 'ok', 'an operation without base_version (NULL) is accepted');
SELECT is((SELECT skew_flag FROM core.sync_operation WHERE op_id = pg_temp.uid(1061)), false, 'skew_flag defaults to false');
SELECT ok((SELECT created_at IS NOT NULL FROM core.sync_operation WHERE op_id = pg_temp.uid(1061)), 'created_at defaults to now()');
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(62, pg_temp.ta(), 1, 'result.enter', 'rejected', '{"error_code":"sync.result_locked","skew_flag":true,"result":{"reason":"locked"}}')), 'ok', 'a rejected operation with error code, skew flag and result is stored');
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(63, pg_temp.ta(), 1, 'result.enter', 'accepted', '{"payload":{"entries":[{"value":"5.1","unit":"g/dL"}],"note":"synthetic"}}')), 'ok', 'a nested payload is stored');
SELECT is((SELECT payload #>> '{entries,0,unit}' FROM core.sync_operation WHERE op_id = pg_temp.uid(1063)), 'g/dL', 'the payload is stored verbatim (jsonb)');
-- the key: (tenant_id, op_id)
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(1, pg_temp.ta(), 1, 'registration.create_order')), '23505', 'the same op_id again in tenant A -> unique_violation (re-sending is safe: the service answers duplicate)');
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(1, pg_temp.ta(), 2, 'billing.record_receipt', 'accepted', '{"payload_hash":"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"}')), '23505',
  'the same op_id with another payload and device is still one row (the service answers sync.op_id_reused)');
SELECT is(pg_temp.try('core.sync_operation', jsonb_set(pg_temp.op(70, pg_temp.tb(), 4, 'result.enter'), '{op_id}', to_jsonb(pg_temp.uid(1001)))), 'ok', 'the same op_id in tenant B is another row (key is per tenant)');
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(71, pg_temp.ta(), 4, 'result.enter')), '23503', 'a device of another tenant -> foreign_key_violation (composite tenant FK)');
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(72, pg_temp.ta(), 9999, 'result.enter')), '23503', 'an unknown device -> foreign_key_violation');
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(73, pg_temp.ta(), 1, 'result.enter', 'accepted', jsonb_build_object('user_id', pg_temp.usr(pg_temp.tb())))), '23503', 'a user of another tenant -> foreign_key_violation');
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(74, pg_temp.ta(), 1, 'result.enter', 'accepted', jsonb_build_object('user_id', pg_temp.uid(9999)))), '23503', 'an unknown user -> foreign_key_violation');

-- ===================================================================================================================================== sync_operation: append only (outcome written once, nothing else changes, no delete)
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(80, pg_temp.ta(), 1, 'result.enter', 'accepted')), 'ok', 'operation 80: outcome not written yet (result IS NULL)');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_operation SET status = 'rejected', error_code = 'sync.result_locked', result = '{"reason":"locked"}'::jsonb WHERE op_id = %L $$, pg_temp.uid(1080))) ~ '^n=1', true,
  'lims_app writes the outcome (status, error_code, result) once');
SELECT is((SELECT status || '|' || error_code FROM core.sync_operation WHERE op_id = pg_temp.uid(1080)), 'rejected|sync.result_locked', 'the outcome is stored');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_operation SET status = 'accepted' WHERE op_id = %L $$, pg_temp.uid(1080))) ~ '^E', true, 'a second outcome write is refused (status)');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_operation SET result = '{"reason":"other"}'::jsonb WHERE op_id = %L $$, pg_temp.uid(1080))) ~ '^E', true, 'a second outcome write is refused (result)');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_operation SET error_code = NULL WHERE op_id = %L $$, pg_temp.uid(1080))) ~ '^E', true, 'the error code cannot be cleared afterwards');
SELECT is((SELECT status FROM core.sync_operation WHERE op_id = pg_temp.uid(1080)), 'rejected', 'a refused write leaves the outcome unchanged');
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(81, pg_temp.ta(), 1, 'result.enter', 'accepted', '{"result":{"entity_id":"synthetic"}}')), 'ok', 'operation 81: outcome written at insert');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_operation SET status = 'conflict' WHERE op_id = %L $$, pg_temp.uid(1081))) ~ '^E', true, 'an outcome written at insert cannot be rewritten');
SELECT is(pg_temp.try('core.sync_operation', pg_temp.op(82, pg_temp.ta(), 1, 'result.enter')), 'ok', 'operation 82: outcome not written yet');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_operation SET %s WHERE op_id = %L $$, f.setc, pg_temp.uid(1000 + f.n))) ~ '^E', true, 'frozen column cannot change: ' || f.lbl)
  FROM (VALUES (82, 'payload', $$payload = '{"tampered":true}'::jsonb$$), (82, 'payload_hash', $$payload_hash = repeat('ef', 32)$$), (82, 'op_type', $$op_type = 'result.verify'$$),
               (82, 'device_id', format('device_id = %L', pg_temp.uid(2))), (82, 'user_id', format('user_id = %L', pg_temp.usr(pg_temp.ta()))), (82, 'base_version', 'base_version = 9'),
               (82, 'device_created_at', $$device_created_at = '2020-01-01T00:00:00Z'$$), (82, 'server_received_at', $$server_received_at = '2020-01-01T00:00:00Z'$$),
               (82, 'op_id', format('op_id = %L', pg_temp.uid(5555))), (82, 'tenant_id', format('tenant_id = %L', pg_temp.tb()))) f(n, lbl, setc);
SELECT is(pg_temp.a(format($$ UPDATE core.sync_operation SET %s WHERE op_id = %L $$, f.setc, pg_temp.uid(1081))) ~ '^E', true, 'frozen column cannot change after the outcome too: ' || f.lbl)
  FROM (VALUES ('payload', $$payload = '{"tampered":true}'::jsonb$$), ('payload_hash', $$payload_hash = repeat('ef', 32)$$), ('op_type', $$op_type = 'result.verify'$$), ('base_version', 'base_version = 9'),
               ('server_received_at', $$server_received_at = '2020-01-01T00:00:00Z'$$)) f(lbl, setc);
SELECT is((SELECT payload ->> 'tampered' FROM core.sync_operation WHERE op_id = pg_temp.uid(1082)), NULL, 'the payload of operation 82 is unchanged after the refused writes');
SELECT is((SELECT op_type FROM core.sync_operation WHERE op_id = pg_temp.uid(1082)), 'result.enter', 'the op_type of operation 82 is unchanged after the refused writes');
SELECT is(pg_temp.a(format($$ DELETE FROM core.sync_operation WHERE op_id = %L $$, pg_temp.uid(1081))) ~ '^E42501', true, 'lims_app cannot delete an operation');
SELECT is(pg_temp.a(format($$ DELETE FROM core.sync_operation WHERE tenant_id = %L $$, pg_temp.ta())) ~ '^E42501', true, 'lims_app cannot delete operations in bulk');
SELECT is(pg_temp.a('TRUNCATE core.sync_operation') ~ '^E42501', true, 'lims_app cannot truncate the ledger');

-- ===================================================================================================================================== sync_conflict: shape rules and resolution consistency
SELECT is(pg_temp.try('core.sync_conflict', pg_temp.cf(1, pg_temp.ta(), 1)), 'ok', 'open conflict 1 (on operation 1)');
SELECT is(pg_temp.try('core.sync_conflict', pg_temp.cf(2, pg_temp.ta(), 2)), 'ok', 'open conflict 2');
SELECT is(pg_temp.try('core.sync_conflict', pg_temp.cf(3, pg_temp.ta(), 3)), 'ok', 'open conflict 3');
SELECT is(pg_temp.try('core.sync_conflict', pg_temp.cf(4, pg_temp.tb(), 40)), 'ok', 'open conflict B4 (tenant B)');
SELECT is((SELECT status FROM core.sync_conflict WHERE id = pg_temp.uid(2001)), 'open', 'a conflict is open by default');
SELECT is((SELECT resolution IS NULL AND resolved_by IS NULL AND resolved_at IS NULL AND reason IS NULL FROM core.sync_conflict WHERE id = pg_temp.uid(2001)), true, 'an open conflict has no resolution, resolver, time or reason');
SELECT is(pg_temp.try('core.sync_conflict', pg_temp.cf(10, pg_temp.ta(), 4, jsonb_build_object('status', 'resolved', 'resolution', 'keep_server', 'resolved_by', pg_temp.usr(pg_temp.ta()),
  'resolved_at', '2026-11-17T11:00:00Z'::timestamptz, 'reason', 'Server copy is newer (synthetic)'))), 'ok', 'a fully resolved conflict is accepted (all four resolution fields set)');
SELECT is(pg_temp.try('core.sync_conflict', pg_temp.cf(20 + t.i, pg_temp.ta(), 5, t.o)), '23514', t.lbl)
  FROM (VALUES (1, '{"status":"closed"}'::jsonb, 'status outside open|resolved rejected'), (2, '{"status":"resolved"}'::jsonb, 'resolved without resolution, resolver, time and reason rejected'),
               (3, jsonb_build_object('status', 'resolved', 'resolution', 'merge', 'resolved_by', pg_temp.usr(pg_temp.ta()), 'resolved_at', '2026-11-17T11:00:00Z'::timestamptz), 'resolved without a reason rejected'),
               (4, jsonb_build_object('status', 'resolved', 'resolution', 'merge', 'resolved_by', pg_temp.usr(pg_temp.ta()), 'resolved_at', '2026-11-17T11:00:00Z'::timestamptz, 'reason', ''), 'resolved with an empty reason rejected'),
               (5, jsonb_build_object('status', 'resolved', 'resolved_by', pg_temp.usr(pg_temp.ta()), 'resolved_at', '2026-11-17T11:00:00Z'::timestamptz, 'reason', 'x'), 'resolved without a resolution rejected'),
               (6, jsonb_build_object('status', 'resolved', 'resolution', 'merge', 'resolved_at', '2026-11-17T11:00:00Z'::timestamptz, 'reason', 'x'), 'resolved without a resolver rejected'),
               (7, jsonb_build_object('status', 'resolved', 'resolution', 'merge', 'resolved_by', pg_temp.usr(pg_temp.ta()), 'reason', 'x'), 'resolved without a time rejected'),
               (8, jsonb_build_object('status', 'resolved', 'resolution', 'discard', 'resolved_by', pg_temp.usr(pg_temp.ta()), 'resolved_at', '2026-11-17T11:00:00Z'::timestamptz, 'reason', 'x'), 'resolution outside keep_server|apply_local|merge rejected'),
               (9, '{"resolution":"keep_server"}'::jsonb, 'an open conflict with a resolution rejected'),
               (10, '{"reason":"early reason"}'::jsonb, 'an open conflict with a reason rejected'),
               (11, jsonb_build_object('resolved_by', pg_temp.usr(pg_temp.ta())), 'an open conflict with a resolver rejected')) t(i, o, lbl);
SELECT isnt(pg_temp.try('core.sync_conflict', pg_temp.cf(40 + t.i, pg_temp.ta(), 5, t.o)), 'ok', t.lbl)
  FROM (VALUES (1, '{"entity_type":null}'::jsonb, 'NULL entity_type rejected'), (2, '{"local_payload":null}'::jsonb, 'NULL local_payload rejected'), (3, '{"server_payload":null}'::jsonb, 'NULL server_payload rejected'),
               (4, '{"entity_id":null}'::jsonb, 'NULL entity_id rejected'), (5, '{"op_id":null}'::jsonb, 'NULL op_id rejected')) t(i, o, lbl);
SELECT is(pg_temp.try('core.sync_conflict', pg_temp.cf(50, pg_temp.ta(), 9999)), '23503', 'a conflict on an unknown operation -> foreign_key_violation');
SELECT is(pg_temp.try('core.sync_conflict', pg_temp.cf(51, pg_temp.ta(), 40)), '23503', 'a conflict on an operation of another tenant -> foreign_key_violation (composite tenant FK)');
SELECT is(pg_temp.try('core.sync_conflict', pg_temp.cf(52, pg_temp.ta(), 5, jsonb_build_object('status', 'resolved', 'resolution', 'merge', 'resolved_by', pg_temp.usr(pg_temp.tb()), 'resolved_at', '2026-11-17T11:00:00Z'::timestamptz, 'reason', 'x'))), '23503',
  'a resolver of another tenant -> foreign_key_violation');
SELECT is(pg_temp.try('core.sync_conflict', pg_temp.cf(1, pg_temp.ta(), 6)), '23505', 'the same conflict id twice -> unique_violation');
-- resolving through lims_app
SELECT is(pg_temp.a(format($$ UPDATE core.sync_conflict SET status = 'resolved', resolution = 'keep_server', resolved_by = %L, resolved_at = now(), reason = 'Server copy kept (synthetic)' WHERE id = %L $$,
  pg_temp.usr(pg_temp.ta()), pg_temp.uid(2001))) ~ '^n=1', true, 'lims_app resolves an open conflict (keep_server)');
SELECT is((SELECT status || '|' || resolution FROM core.sync_conflict WHERE id = pg_temp.uid(2001)), 'resolved|keep_server', 'the resolution is stored');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_conflict SET resolution = 'apply_local' WHERE id = %L $$, pg_temp.uid(2001))) ~ '^E', true, 'a resolved conflict cannot be re-resolved (resolution)');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_conflict SET status = 'open', resolution = NULL, resolved_by = NULL, resolved_at = NULL, reason = NULL WHERE id = %L $$, pg_temp.uid(2001))) ~ '^E', true, 'a resolved conflict cannot be reopened');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_conflict SET reason = 'rewritten history' WHERE id = %L $$, pg_temp.uid(2001))) ~ '^E', true, 'the reason of a resolved conflict cannot be rewritten');
SELECT is((SELECT resolution FROM core.sync_conflict WHERE id = pg_temp.uid(2001)), 'keep_server', 'refused writes leave the resolved conflict unchanged');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_conflict SET status = 'resolved', resolution = 'merge', resolved_by = %L, resolved_at = now(), reason = '' WHERE id = %L $$, pg_temp.usr(pg_temp.ta()), pg_temp.uid(2002))) ~ '^E23514', true,
  'resolving with an empty reason -> check_violation');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_conflict SET status = 'resolved', resolution = 'merge' WHERE id = %L $$, pg_temp.uid(2002))) ~ '^E23514', true, 'resolving without resolver, time and reason -> check_violation');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_conflict SET status = 'resolved', resolution = 'merge', resolved_by = %L, resolved_at = now(), reason = 'Field merge (synthetic)' WHERE id = %L $$,
  pg_temp.usr(pg_temp.ta()), pg_temp.uid(2002))) ~ '^n=1', true, 'lims_app resolves a conflict with merge');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_conflict SET op_id = %L WHERE id = %L $$, pg_temp.uid(1005), pg_temp.uid(2003))) ~ '^E', true, 'the operation a conflict belongs to cannot be changed');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_conflict SET local_payload = '{"tampered":true}'::jsonb WHERE id = %L $$, pg_temp.uid(2003))) ~ '^E', true, 'the local version stored with a conflict cannot be rewritten');
SELECT is(pg_temp.a(format($$ DELETE FROM core.sync_conflict WHERE id = %L $$, pg_temp.uid(2003))) ~ '^E42501', true, 'lims_app cannot delete a conflict');

-- ===================================================================================================================================== tenant isolation (RLS probes)
CREATE TEMP TABLE probe(s, t, a_key, b_key, kcol) AS VALUES ('core','sync_operation', pg_temp.uid(1002), pg_temp.uid(1040), 'op_id'), ('core','sync_conflict', pg_temp.uid(2002), pg_temp.uid(2004), 'id');
SELECT is(pg_temp.a(format('SELECT 1 FROM %s.%s WHERE %I = %L', p.s, p.t, p.kcol, p.a_key), 'n'), 'n=1', 'tenant A sees its own row of ' || p.t) FROM probe p;
SELECT is(pg_temp.a(format('SELECT 1 FROM %s.%s WHERE %I = %L', p.s, p.t, p.kcol, p.b_key), 'n'), 'n=0', 'tenant A cannot see the tenant B row of ' || p.t) FROM probe p;
SELECT is(pg_temp.b(format('SELECT 1 FROM %s.%s WHERE %I = %L', p.s, p.t, p.kcol, p.a_key), 'n'), 'n=0', 'tenant B cannot see the tenant A row of ' || p.t) FROM probe p;
SELECT is(pg_temp.a(format('SELECT 1 FROM %s.%s WHERE tenant_id = %L', p.s, p.t, pg_temp.tb()), 'n'), 'n=0', 'filtering on the other tenant id still returns nothing for ' || p.t) FROM probe p;
SELECT is(pg_temp.a(format($$ UPDATE core.sync_operation SET status = 'conflict', result = '{"x":1}'::jsonb WHERE op_id = %L $$, pg_temp.uid(1040))), 'n=0', 'tenant A cannot write the outcome of a tenant B operation (0 rows)');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_conflict SET status = 'resolved', resolution = 'merge', resolved_by = %L, resolved_at = now(), reason = 'x' WHERE id = %L $$, pg_temp.usr(pg_temp.ta()), pg_temp.uid(2004))), 'n=0',
  'tenant A cannot resolve a tenant B conflict (0 rows)');
SELECT alike(pg_temp.a(format($$ INSERT INTO core.sync_operation (tenant_id, op_id, device_id, user_id, op_type, payload_hash, payload, device_created_at, server_received_at, status) VALUES (%L, %L, %L, %L, 'result.enter', 'h', '{}', now(), now(), 'accepted') $$,
  pg_temp.tb(), pg_temp.uid(5001), pg_temp.uid(4), pg_temp.usr(pg_temp.tb()))), 'E42501|%', 'tenant A cannot write an operation for tenant B');
SELECT alike(pg_temp.a(format($$ INSERT INTO core.sync_conflict (id, tenant_id, op_id, entity_type, entity_id, local_payload, server_payload, created_by, updated_by) VALUES (%L, %L, %L, 'patient', %L, '{}', '{}', %L, %L) $$,
  pg_temp.uid(5002), pg_temp.tb(), pg_temp.uid(1040), pg_temp.uid(5003), pg_temp.sys(), pg_temp.sys())), 'E42501|%', 'tenant A cannot write a conflict for tenant B');
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format('SELECT 1 FROM %s.%s', p.s, p.t), 'n'), 'n=0', 'a ' || r.k || '-actor sees 0 rows of ' || p.t) FROM probe p CROSS JOIN (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT alike(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ INSERT INTO core.sync_operation (tenant_id, op_id, device_id, user_id, op_type, payload_hash, payload, device_created_at, server_received_at, status) VALUES (%L, %L, %L, %L, 'result.enter', 'h', '{}', now(), now(), 'accepted') $$,
  pg_temp.ta(), pg_temp.uid(5010), pg_temp.uid(1), pg_temp.usr(pg_temp.ta())), 'w'), 'E42501|%', 'a ' || r.k || '-actor cannot write an operation') FROM (VALUES ('patient'),('partner'),('portal')) r(k);
SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), r.k), format($$ UPDATE core.sync_conflict SET status = 'resolved', resolution = 'merge', resolved_by = %L, resolved_at = now(), reason = 'x' WHERE id = %L $$, pg_temp.usr(pg_temp.ta()), pg_temp.uid(2003)), 'w'), 'n=0',
  'a ' || r.k || '-actor cannot resolve a conflict (0 rows)') FROM (VALUES ('patient'),('partner'),('portal')) r(k);

-- ===================================================================================================================================== audit (conflicts) and permissions
SELECT is((SELECT count(*)::int FROM audit.audit_log WHERE schema_name = 'core' AND table_name = 'sync_conflict' AND row_id = pg_temp.uid(2002) AND action = 'INSERT'), 1, 'control: INSERT into sync_conflict is audited');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'core.sync_conflict'::regclass AND NOT tgisinternal AND pg_get_triggerdef(oid) ~ 'tg_row_audit'), 1, 'sync_conflict has one audit trigger');
SELECT ok(EXISTS (SELECT 1 FROM audit.audit_log WHERE schema_name = 'core' AND table_name = 'sync_conflict' AND row_id = pg_temp.uid(2002) AND action = 'UPDATE' AND 'resolution' = ANY (changed_columns)),
  'resolving a conflict is recorded as a changed resolution (who resolved which conflict)');
SELECT is((SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'core.sync_operation'::regclass AND NOT tgisinternal AND pg_get_triggerdef(oid) ~ 'tg_row_audit'), 0,
  'sync_operation is not row-audited (its payload would be copied into the audit log; the table is the ledger)');
SELECT is((SELECT count(*)::int FROM core.g_permissions WHERE code LIKE 'sync.%'), 3, 'no new permission code: exactly sync.use, sync.device.manage, sync.conflict.resolve');

-- ===================================================================================================================================== idempotent re-apply: second run changes nothing
CREATE FUNCTION pg_temp.state() RETURNS text LANGUAGE sql AS $$
  SELECT concat_ws('|',
    (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r' AND c.relpersistence <> 't' AND c.relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)),
    (SELECT count(*) FROM pg_class WHERE relkind = 'r' AND relnamespace = 'core'::regnamespace),
    (SELECT count(*) FROM pg_constraint WHERE connamespace = 'core'::regnamespace),
    (SELECT string_agg(conname || ':' || pg_get_constraintdef(oid), ';' ORDER BY conname) FROM pg_constraint WHERE conrelid IN ('core.sync_operation'::regclass, 'core.sync_conflict'::regclass)),
    (SELECT count(*) FROM pg_index WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'core'::regnamespace)),
    (SELECT count(*) FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'core'::regnamespace)),
    (SELECT string_agg(pg_get_triggerdef(oid), ';' ORDER BY tgrelid::regclass::text, tgname) FROM pg_trigger WHERE tgrelid IN ('core.sync_operation'::regclass, 'core.sync_conflict'::regclass) AND NOT tgisinternal),
    (SELECT count(*) FROM core.sync_operation), (SELECT count(*) FROM core.sync_conflict)) $$;
CREATE TEMP TABLE before_state AS SELECT pg_temp.state() AS s;
\ir ../../migrations/20261117260000_core__add_sync_operations_and_conflicts.sql
RESET ROLE;
SELECT is(pg_temp.state(), (SELECT s FROM before_state), 're-apply: tables, columns (also the version columns), constraints, indexes, policies, triggers and row counts are unchanged');
SELECT is((SELECT status FROM core.sync_operation WHERE op_id = pg_temp.uid(1080)), 'rejected', 're-apply: no data rewrite (operation outcome intact)');
SELECT is((SELECT resolution FROM core.sync_conflict WHERE id = pg_temp.uid(2001)), 'keep_server', 're-apply: no data rewrite (conflict resolution intact)');
SELECT is(has_table_privilege('lims_app', 'core.sync_operation', 'DELETE'), false, 're-apply keeps DELETE revoked on sync_operation');
SELECT is(has_table_privilege('lims_app', 'core.sync_conflict', 'DELETE'), false, 're-apply keeps DELETE revoked on sync_conflict');
SELECT is(pg_temp.a(format($$ UPDATE core.sync_operation SET payload = '{"tampered":true}'::jsonb WHERE op_id = %L $$, pg_temp.uid(1081))) ~ '^E', true, 're-apply keeps the payload frozen');

SELECT * FROM finish();
ROLLBACK;
