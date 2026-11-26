-- PHLEBO-UI-FULL-1 scenario check for 20261126000000 (visit tracking): who can read a tracking row.
-- Run inside a transaction that is rolled back, after the migration, as a superuser (see phlebo_applications.scenario.sql).
-- Rows are inserted with triggers and FK checks off (session_replication_role = replica) so the fixture stays small;
-- the CHECK constraints and RLS under test still apply. Synthetic data only.
DO $$
DECLARE
  ta uuid := (SELECT id FROM core.tenants WHERE tenant_code = 'tenant_a');
  tb uuid := (SELECT id FROM core.tenants WHERE tenant_code = 'tenant_b');
  sys uuid := '01a1a98a-ac40-7000-8000-0000000900ff';
  centre uuid := '01a1a98a-ac40-7000-8000-000000090001';
  m_p1 uuid := '01a1a98a-ac40-7000-8000-000000091001'; m_p2 uuid := '01a1a98a-ac40-7000-8000-000000091002'; m_staff uuid := '01a1a98a-ac40-7000-8000-000000091003'; m_other uuid := '01a1a98a-ac40-7000-8000-000000091004';
  acc1 uuid := '01a1a98a-ac40-7000-8000-000000092001'; acc2 uuid := '01a1a98a-ac40-7000-8000-000000092002';
  bk1 uuid := '01a1a98a-ac40-7000-8000-000000093001'; bk2 uuid := '01a1a98a-ac40-7000-8000-000000093002';
  v1 uuid := '01a1a98a-ac40-7000-8000-000000094001'; v2 uuid := '01a1a98a-ac40-7000-8000-000000094002';
  n integer; lat numeric;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, created_by, updated_by) VALUES
    (m_p1, ta, m_p1, 'patient', sys, sys), (m_p2, ta, m_p2, 'patient', sys, sys), (m_staff, ta, m_staff, 'user', sys, sys), (m_other, ta, m_other, 'user', sys, sys);
  UPDATE core.memberships SET all_centres = true WHERE id = m_staff;   -- m_other: no centre at all
  INSERT INTO engagement.accounts (id, tenant_id, membership_id, created_by, updated_by) VALUES (acc1, ta, m_p1, sys, sys), (acc2, ta, m_p2, sys, sys);
  INSERT INTO engagement.bookings (id, tenant_id, booking_no, account_id, link_id, patient_id, created_via, booking_kind, branch_id, centre_id, slot_occupancy_id, home_address_id, slot_start, slot_end, confirmed_at, created_by, updated_by) VALUES
    (bk1, ta, 'BK26900001', acc1, sys, sys, 'app', 'home_collection', centre, centre, sys, sys, now(), now() + interval '1 hour', now(), sys, sys),
    (bk2, ta, 'BK26900002', acc2, sys, sys, 'app', 'home_collection', centre, centre, sys, sys, now(), now() + interval '1 hour', now(), sys, sys);
  INSERT INTO homecollection.visits (id, tenant_id, centre_id, branch_id, kind, patient_id, booking_id, orderable_ids, created_by, updated_by) VALUES
    (v1, ta, centre, centre, 'booking', sys, bk1, ARRAY[sys], sys, sys), (v2, ta, centre, centre, 'booking', sys, bk2, ARRAY[sys], sys, sys);
  INSERT INTO homecollection.visit_tracking (id, tenant_id, centre_id, visit_id, membership_id, booking_id, collector_display_name, state, started_at, latitude, longitude, position_at, created_by, updated_by) VALUES
    ('01a1a98a-ac40-7000-8000-000000095001', ta, centre, v1, m_staff, bk1, 'Synthetic Collector', 'en_route', now(), 27.700000, 85.300000, now(), sys, sys),
    ('01a1a98a-ac40-7000-8000-000000095002', ta, centre, v2, m_staff, bk2, 'Synthetic Collector', 'en_route', now(), 27.710000, 85.310000, now(), sys, sys);
  SET LOCAL session_replication_role = origin;

  -- the table refuses a position on a stopped row, and half a position
  BEGIN
    UPDATE homecollection.visit_tracking SET state = 'stopped', stop_reason = 'arrived', stopped_at = now() WHERE visit_id = v1;
    RAISE EXCEPTION 'a stopped row kept its coordinates';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE homecollection.visit_tracking SET longitude = NULL WHERE visit_id = v1;
    RAISE EXCEPTION 'half a position was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  SET LOCAL ROLE lims_app;

  -- patient 1: sees only the tracking of their own booking
  PERFORM set_config('request.jwt.claims', json_build_object('tenant_id', ta, 'actor_type', 'patient', 'sub', m_p1, 'membership_id', m_p1)::text, true);
  IF app.engagement_account_id() IS DISTINCT FROM acc1 THEN RAISE EXCEPTION 'fixture: patient 1 account not resolved'; END IF;
  SELECT count(*), min(latitude) INTO n, lat FROM homecollection.visit_tracking;
  IF n <> 1 OR lat <> 27.700000 THEN RAISE EXCEPTION 'patient 1 sees % tracking rows (lat %)', n, lat; END IF;
  SELECT count(*) INTO n FROM homecollection.visit_tracking WHERE booking_id = bk2;
  IF n <> 0 THEN RAISE EXCEPTION 'patient 1 can read the other patient''s tracking'; END IF;
  SELECT count(*) INTO n FROM homecollection.visits;
  IF n <> 0 THEN RAISE EXCEPTION 'a patient can read visits (%)', n; END IF;
  BEGIN
    UPDATE homecollection.visit_tracking SET latitude = 1, longitude = 1;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'a patient moved % tracking rows', n; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- patient 2: the mirror image
  PERFORM set_config('request.jwt.claims', json_build_object('tenant_id', ta, 'actor_type', 'patient', 'sub', m_p2, 'membership_id', m_p2)::text, true);
  SELECT count(*), min(latitude) INTO n, lat FROM homecollection.visit_tracking;
  IF n <> 1 OR lat <> 27.710000 THEN RAISE EXCEPTION 'patient 2 sees % tracking rows', n; END IF;

  -- a patient of another tenant, and a patient still at the pre-auth stage: nothing
  PERFORM set_config('request.jwt.claims', json_build_object('tenant_id', tb, 'actor_type', 'patient', 'sub', m_p1, 'membership_id', m_p1)::text, true);
  SELECT count(*) INTO n FROM homecollection.visit_tracking;
  IF n <> 0 THEN RAISE EXCEPTION 'cross-tenant patient sees % rows', n; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('tenant_id', ta, 'actor_type', 'patient', 'sub', m_p1, 'membership_id', m_p1, 'patient_stage', 'pre_auth')::text, true);
  SELECT count(*) INTO n FROM homecollection.visit_tracking;
  IF n <> 0 THEN RAISE EXCEPTION 'pre-auth caller sees % rows', n; END IF;

  -- staff with no centre in scope: nothing; staff with all centres: both
  PERFORM set_config('request.jwt.claims', json_build_object('tenant_id', ta, 'actor_type', 'user', 'sub', m_other, 'membership_id', m_other)::text, true);
  SELECT count(*) INTO n FROM homecollection.visit_tracking;
  IF n <> 0 THEN RAISE EXCEPTION 'staff of another centre sees % rows', n; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('tenant_id', ta, 'actor_type', 'user', 'sub', m_staff, 'membership_id', m_staff)::text, true);
  SELECT count(*) INTO n FROM homecollection.visit_tracking;
  IF n <> 2 THEN RAISE EXCEPTION 'all-centre staff sees % rows, expected 2', n; END IF;

  RAISE NOTICE 'visit tracking scenario: access rules OK';
END $$;
