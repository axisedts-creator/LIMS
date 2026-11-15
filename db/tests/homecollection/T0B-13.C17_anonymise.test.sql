-- T0B-13.C17 live-DB assertions under FORCE RLS: 05-SCHEMA §4.2 tests T1..T5 (retention anonymisation DEFINER app.homecollection_anonymise_retired_visits + the visit_locations retention DELETE policy; 08 A12.7, A17 P-18(c), A19 P-41 / D-125).
-- ACs: AC-0B-2.1 AC-0B-2.2 AC-0B-2.3 AC-0B-2.4 (policies + FORCE RLS exercised), AC-0B-3.1 AC-0B-3.2 AC-0B-3.3 (tenant isolation of the DEFINER), AC-0B-4.1 AC-0B-4.2 (immutable_row guards), AC-0B-6.3 (owner).
-- Synthetic data only. One rolled-back transaction. RLS is never disabled for the assertions (rows are seeded with session_replication_role = replica, as the isolation probes do;
-- CHECK constraints still apply, so every seeded row is valid). Counts are read as the superuser (bypasses RLS) so they show the truth, not a policy-filtered view.
-- Run: pg_prove -d <migrated db with the homecollection DDL> db/tests/homecollection/T0B-13.C17_anonymise.test.sql   (superuser; pgTAP in schema `extensions`; run from the repo root)
-- Needs a live Postgres with C0 + C17 migrations; it is NOT part of .orchestra/notes/T0B-13.C17-verify.cmd (no database in the unit-test environment).
-- Fails now: app.homecollection_anonymise_retired_visits(timestamptz), the owner policies and the visit_locations DELETE policy do not exist in the migrated schema.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT * FROM no_plan();
\ir ../fixtures/T0B-06_identity_standin.sql

CREATE FUNCTION pg_temp.id(k int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01950c17-0000-7000-8000-' || lpad(to_hex(k), 12, '0'))::uuid $$;
-- claims of actor type p_type in tenant #p_tenant (1 = A, 2 = B); p_tenant = 0 -> no tenant claim
CREATE FUNCTION pg_temp.cl(p_type text, p_tenant int) RETURNS text LANGUAGE sql AS $$
  SELECT CASE WHEN p_tenant = 0 THEN jsonb_build_object('actor_type', p_type, 'sub', pg_temp.id(99))::text
              ELSE jsonb_build_object('actor_type', p_type, 'tenant_id', pg_temp.id(p_tenant), 'sub', pg_temp.id(99))::text END $$;
-- run p_sql as p_role with p_claims; optional p_pre first (the "attacker" setting a GUC itself). modes: v scalar text, n row count of a SELECT, w DML row count. Errors -> 'E<SQLSTATE>:<message>'.
CREATE FUNCTION pg_temp.x(p_role text, p_claims text, p_pre text, p_sql text, p_mode text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text; n bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    IF p_pre IS NOT NULL THEN EXECUTE p_pre; END IF;
    IF p_mode = 'v' THEN EXECUTE p_sql INTO r; r := coalesce(r, '<null>');
    ELSIF p_mode = 'n' THEN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') t' INTO n; r := n::text;
    ELSE EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT; r := n::text; END IF;
  EXCEPTION WHEN OTHERS THEN r := 'E' || SQLSTATE || ':' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN r;
END $f$;
CREATE FUNCTION pg_temp.worker(p_type text, p_tenant int, p_sql text) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_worker', pg_temp.cl(p_type, p_tenant), NULL, p_sql, 'v') $$;
CREATE FUNCTION pg_temp.app(p_type text, p_tenant int, p_sql text, p_mode text DEFAULT 'w', p_pre text DEFAULT NULL) RETURNS text LANGUAGE sql AS $$ SELECT pg_temp.x('lims_app', pg_temp.cl(p_type, p_tenant), p_pre, p_sql, p_mode) $$;
-- superuser values (RLS bypassed)
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS $$ DECLARE r text; BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r, '<null>'); END $$;
CREATE FUNCTION pg_temp.call(p_tenant int, p_before text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.worker('system', p_tenant, 'SELECT visits_anonymised || '','' || handover_items_anonymised FROM app.homecollection_anonymise_retired_visits(' || p_before || ')') $$;

-- ---------------------------------------------------------------- fixtures: tenant A (t = 1) and tenant B (t = 2); k offsets keep ids unique per tenant
SET LOCAL session_replication_role = replica;
INSERT INTO core.tenants (id, tenant_code, legal_name, display_name, status, created_by, updated_by) VALUES
  (pg_temp.id(1), 'hc17_a', 'Lab A', 'Lab A', 'active', pg_temp.id(99), pg_temp.id(99)),
  (pg_temp.id(2), 'hc17_b', 'Lab B', 'Lab B', 'active', pg_temp.id(99), pg_temp.id(99));
DO $seed$
DECLARE t int; o int;
BEGIN
  FOR t IN 1..2 LOOP
    o := t * 1000;
    -- visits: +1 closed 6 years ago (eligible), +2 closed yesterday (newer than p_before), +3 open (unassigned), +4 cancelled 6 years ago (eligible, already anonymised: nothing to do)
    INSERT INTO homecollection.visits (id, tenant_id, centre_id, branch_id, kind, status, order_id, patient_id, address_text, landmark, latitude, longitude, note_for_phlebotomist, status_reason_text, completed_at, cancelled_at, created_by, updated_by, created_at, updated_at) VALUES
      (pg_temp.id(o+1), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+61), 'front_desk', 'completed', pg_temp.id(o+70), pg_temp.id(o+50), 'Synthetic Road 1', 'Near synthetic tree', 27.700000, 85.300000, 'ring twice', 'synthetic note', now() - interval '6 years', NULL, pg_temp.id(99), pg_temp.id(99), now() - interval '6 years', now() - interval '6 years'),
      (pg_temp.id(o+2), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+61), 'front_desk', 'completed', pg_temp.id(o+71), pg_temp.id(o+50), 'Synthetic Road 2', 'Near synthetic well', 27.710000, 85.310000, 'gate code 0000', 'synthetic note', now() - interval '1 day', NULL, pg_temp.id(99), pg_temp.id(99), now() - interval '1 day', now() - interval '1 day'),
      (pg_temp.id(o+3), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+61), 'front_desk', 'unassigned', pg_temp.id(o+72), pg_temp.id(o+50), 'Synthetic Road 3', 'Near synthetic pond', 27.720000, 85.320000, 'call first', NULL, NULL, NULL, pg_temp.id(99), pg_temp.id(99), now() - interval '7 years', now() - interval '7 years'),
      (pg_temp.id(o+4), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+61), 'front_desk', 'cancelled', pg_temp.id(o+73), pg_temp.id(o+50), NULL, NULL, NULL, NULL, NULL, NULL, NULL, now() - interval '6 years', pg_temp.id(99), pg_temp.id(99), now() - interval '6 years', now() - interval '6 years');
    -- handover items: +11 of visit +1 (eligible), +12 of visit +2 (newer), +13 of the open visit +3 (kept), +14 of visit +4 (already ANONYMISED: not touched again)
    INSERT INTO homecollection.handover_items (id, tenant_id, centre_id, to_centre_id, handover_id, collection_id, specimen_id, visit_id, barcode, specimen_type_code, created_by, updated_by) VALUES
      (pg_temp.id(o+11), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+62), pg_temp.id(o+80), pg_temp.id(o+81), pg_temp.id(o+91), pg_temp.id(o+1), 'SYN' || o || 'A', 'serum', pg_temp.id(99), pg_temp.id(99)),
      (pg_temp.id(o+12), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+62), pg_temp.id(o+80), pg_temp.id(o+82), pg_temp.id(o+92), pg_temp.id(o+2), 'SYN' || o || 'B', 'serum', pg_temp.id(99), pg_temp.id(99)),
      (pg_temp.id(o+13), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+62), pg_temp.id(o+80), pg_temp.id(o+83), pg_temp.id(o+93), pg_temp.id(o+3), 'SYN' || o || 'C', 'serum', pg_temp.id(99), pg_temp.id(99)),
      (pg_temp.id(o+14), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+62), pg_temp.id(o+80), pg_temp.id(o+84), pg_temp.id(o+94), pg_temp.id(o+4), 'ANONYMISED', 'serum', pg_temp.id(99), pg_temp.id(99));
    -- visit_locations: +21 expired 10 days ago, +22 live (expires in 10 days)
    INSERT INTO homecollection.visit_locations (id, tenant_id, centre_id, visit_id, mutation_id, kind, latitude, longitude, accuracy_m, captured_at, created_by, expires_at) VALUES
      (pg_temp.id(o+21), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+1), pg_temp.id(o+95), 'arrived', 27.700000, 85.300000, 10, now() - interval '100 days', pg_temp.id(99), now() - interval '10 days'),
      (pg_temp.id(o+22), pg_temp.id(t), pg_temp.id(o+60), pg_temp.id(o+2), pg_temp.id(o+96), 'arrived', 27.710000, 85.310000, 10, now() - interval '80 days', pg_temp.id(99), now() + interval '10 days');
  END LOOP;
END $seed$;
SET LOCAL session_replication_role = origin;

-- ---------------------------------------------------------------- the DEFINER: owner, DEFINER, search_path, grants (§4.2 inventory row)
SELECT is((SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'app.homecollection_anonymise_retired_visits(timestamptz)'::regprocedure), 'lims_owner', 'AC-0B-6.3: the anonymise function is owned by lims_owner');
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'app.homecollection_anonymise_retired_visits(timestamptz)'::regprocedure), 'AC-0B-4.1: the anonymise function is SECURITY DEFINER');
SELECT ok((SELECT proconfig @> ARRAY['search_path='] FROM pg_proc WHERE oid = 'app.homecollection_anonymise_retired_visits(timestamptz)'::regprocedure), 'search_path is pinned to the empty path');
SELECT ok(has_function_privilege('lims_worker', 'app.homecollection_anonymise_retired_visits(timestamptz)', 'EXECUTE'), 'lims_worker may execute the anonymise function');
SELECT ok(NOT has_function_privilege('lims_app', 'app.homecollection_anonymise_retired_visits(timestamptz)', 'EXECUTE') AND NOT has_function_privilege('lims_api', 'app.homecollection_anonymise_retired_visits(timestamptz)', 'EXECUTE'), 'the request roles may not execute the anonymise function');

-- C17 T4 (first, nothing may change): without tenant claims, with a user actor, or with p_before > now() -> homecollection_anonymise_invalid_input; AC-0B-2.2 AC-0B-3.2
SELECT matches(pg_temp.worker('system', 0, 'SELECT count(*) FROM app.homecollection_anonymise_retired_visits(now() - interval ''5 years'')'), 'P0001.*homecollection_anonymise_invalid_input', 'C17 T4: no tenant claims -> homecollection_anonymise_invalid_input');
SELECT matches(pg_temp.call(1, 'now() + interval ''1 day'''), 'P0001.*homecollection_anonymise_invalid_input', 'C17 T4: p_before in the future -> homecollection_anonymise_invalid_input');
SELECT matches(pg_temp.x('lims_worker', pg_temp.cl('user', 1), NULL, 'SELECT count(*) FROM app.homecollection_anonymise_retired_visits(now() - interval ''5 years'')', 'v'), 'P0001.*homecollection_anonymise_invalid_input', 'C17 T4: a user actor -> homecollection_anonymise_invalid_input');
SELECT matches(pg_temp.call(1, 'NULL::timestamptz'), 'P0001.*homecollection_anonymise_invalid_input', 'C17 T4: NULL p_before -> homecollection_anonymise_invalid_input');
SELECT is(pg_temp.q('SELECT count(*) FROM homecollection.visits WHERE address_text IS NULL AND status <> ''cancelled'''), '0', 'C17 T4: nothing was anonymised by the rejected calls');
SELECT is(pg_temp.q('SELECT count(*) FROM homecollection.handover_items WHERE barcode = ''ANONYMISED'''), '2', 'C17 T4: no barcode was overwritten by the rejected calls (the 2 seeded ANONYMISED items stay)');

-- C17 T1: tenant-A system claims; closed A visit past p_before and its handover item are anonymised; the open visit, the closed visit newer than p_before and every tenant-B row are unchanged; the function returns the counts; AC-0B-3.1 AC-0B-3.3
SELECT is(pg_temp.call(1, 'now() - interval ''5 years'''), '1,1', 'C17 T1: returns (visits_anonymised, handover_items_anonymised) = (1, 1) for tenant A');
SELECT is(pg_temp.q('SELECT concat_ws(''|'', address_text, landmark, latitude::text, longitude::text, note_for_phlebotomist, status_reason_text, version::text) FROM homecollection.visits WHERE id = ' || quote_literal(pg_temp.id(1001))), '2', 'C17 T1: the eligible closed visit lost address_text, landmark, latitude, longitude, note_for_phlebotomist, status_reason_text (concat_ws skips NULLs: only version = 2 remains)');
SELECT is(pg_temp.q('SELECT status || '','' || kind || '','' || (order_id IS NOT NULL)::text FROM homecollection.visits WHERE id = ' || quote_literal(pg_temp.id(1001))), 'completed,front_desk,true', 'C17 T1: the row is kept (class C), its identity and status columns are untouched');
SELECT is(pg_temp.q('SELECT barcode || '','' || version FROM homecollection.handover_items WHERE id = ' || quote_literal(pg_temp.id(1011))), 'ANONYMISED,2', 'C17 T1: the eligible handover item carries the ANONYMISED barcode (D-125), version + 1');
SELECT is(pg_temp.q('SELECT address_text FROM homecollection.visits WHERE id = ' || quote_literal(pg_temp.id(1002))), 'Synthetic Road 2', 'C17 T1: a closed visit newer than p_before is unchanged');
SELECT is(pg_temp.q('SELECT address_text FROM homecollection.visits WHERE id = ' || quote_literal(pg_temp.id(1003))), 'Synthetic Road 3', 'C17 T1: an open visit is unchanged');
SELECT is(pg_temp.q('SELECT barcode FROM homecollection.handover_items WHERE id IN (' || quote_literal(pg_temp.id(1012)) || ',' || quote_literal(pg_temp.id(1013)) || ') ORDER BY id LIMIT 1'), 'SYN1000B', 'C17 T1: the items of the newer / open visits keep their barcodes');
SELECT is(pg_temp.q('SELECT count(*) FROM homecollection.visits WHERE tenant_id = ' || quote_literal(pg_temp.id(2)) || ' AND address_text IS NOT NULL'), '3', 'C17 T1: every tenant-B visit is unchanged (3 with an address)');
SELECT is(pg_temp.q('SELECT count(*) FROM homecollection.handover_items WHERE tenant_id = ' || quote_literal(pg_temp.id(2)) || ' AND barcode <> ''ANONYMISED'''), '3', 'C17 T1: every tenant-B handover item is unchanged');
SELECT is(pg_temp.call(1, 'now() - interval ''5 years'''), '0,0', 'C17 T1: a second run is idempotent (already anonymised rows are not touched again)');

-- C17 T3: after return, current_setting('app.maintenance', true) = ''
SELECT is(pg_temp.worker('system', 1, 'SELECT current_setting(''app.maintenance'', true)'), '', 'C17 T3: app.maintenance is reset to the empty string after the function returns');
SELECT is(pg_temp.worker('system', 2, 'SELECT visits_anonymised || '','' || handover_items_anonymised FROM app.homecollection_anonymise_retired_visits(now() - interval ''5 years'')') || '|' || pg_temp.worker('system', 2, 'SELECT current_setting(''app.maintenance'', true)'), '1,1|', 'C17 T3: tenant B run anonymises only tenant B and also resets the GUC');

-- C17 T2: a lims_app session that sets app.maintenance itself reads no extra rows (owner policies are TO lims_owner) and its UPDATEs of handover_items.barcode / visits.address_text on a closed visit still fail with immutable_row; AC-0B-2.3 AC-0B-4.1 AC-0B-4.2
SELECT is(pg_temp.app('system', 1, 'SELECT id FROM homecollection.visits', 'n', 'SELECT set_config(''app.maintenance'', ''homecollection_anonymise_retired_visits'', true)'), '4', 'C17 T2: with the GUC set by lims_app, tenant A sees exactly its 4 visits (no extra row, no tenant-B row)');
SELECT is(pg_temp.app('system', 1, 'SELECT id FROM homecollection.visits WHERE tenant_id = ''' || pg_temp.id(2) || '''', 'n', 'SELECT set_config(''app.maintenance'', ''homecollection_anonymise_retired_visits'', true)'), '0', 'C17 T2: tenant-B visits stay invisible to tenant A even with the GUC');
SELECT matches(pg_temp.app('system', 1, 'UPDATE homecollection.handover_items SET barcode = ''ANONYMISED'' WHERE id = ''' || pg_temp.id(1012) || '''', 'w', 'SELECT set_config(''app.maintenance'', ''homecollection_anonymise_retired_visits'', true)'), 'P0001.*immutable_row', 'C17 T2: lims_app + GUC cannot overwrite handover_items.barcode (current_user is not lims_owner): immutable_row');
SELECT matches(pg_temp.app('system', 1, 'UPDATE homecollection.visits SET address_text = NULL WHERE id = ''' || pg_temp.id(1002) || '''', 'w', 'SELECT set_config(''app.maintenance'', ''homecollection_anonymise_retired_visits'', true)'), 'P0001.*immutable_row', 'C17 T2: lims_app + GUC cannot clear visits.address_text of a closed visit: immutable_row');
SELECT matches(pg_temp.app('system', 1, 'UPDATE homecollection.visits SET latitude = NULL, longitude = NULL WHERE id = ''' || pg_temp.id(1002) || '''', 'w'), 'P0001.*immutable_row', 'C17 T2: without the GUC the closed visit is just as immutable (AC-0B-4.1)');
SELECT is(pg_temp.q('SELECT address_text FROM homecollection.visits WHERE id = ' || quote_literal(pg_temp.id(1002))), 'Synthetic Road 2', 'C17 T2: the failed UPDATEs changed nothing');

-- C17 T5: visit_locations retention (08 A17 P-18(c)): a user actor's DELETE affects 0 rows; the system actor deletes only rows with expires_at < now() of its tenant; AC-0B-2.1 AC-0B-2.2 AC-0B-2.4
SELECT is(pg_temp.app('user', 1, 'DELETE FROM homecollection.visit_locations', 'w'), '0', 'C17 T5: a user actor''s DELETE affects 0 rows (system actor only)');
SELECT is(pg_temp.app('system', 1, 'DELETE FROM homecollection.visit_locations', 'w'), '1', 'C17 T5: the system actor of tenant A deletes only its expired row (1), not the live one and nothing of tenant B');
SELECT is(pg_temp.q('SELECT count(*) FROM homecollection.visit_locations WHERE tenant_id = ' || quote_literal(pg_temp.id(1))), '1', 'C17 T5: the live tenant-A location remains');
SELECT is(pg_temp.q('SELECT count(*) FROM homecollection.visit_locations WHERE tenant_id = ' || quote_literal(pg_temp.id(2))), '2', 'C17 T5: tenant B keeps both locations (including its expired one)');
SELECT is(pg_temp.app('system', 1, 'DELETE FROM homecollection.visit_locations', 'w'), '0', 'C17 T5: a repeat deletes nothing (the live row has expires_at in the future)');
SELECT is(pg_temp.app('system', 1, 'DELETE FROM homecollection.visits', 'w'), 'E42501:permission denied for table visits', 'C17 T5: DELETE is granted on visit_locations only (class C visits: permission denied)');

SELECT * FROM finish();
ROLLBACK;
