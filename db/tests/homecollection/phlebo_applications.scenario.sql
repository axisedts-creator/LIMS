-- PHLEBO-UI-FULL-1 scenario check for 20261126000000 (visit tracking) and 20261126010000 (phlebo applications).
-- Run inside a transaction that is rolled back, after both migrations, as a superuser:
--   (echo 'BEGIN; SET LOCAL ROLE lims_migrator;'; cat <the two migrations>; echo 'RESET ROLE;'; cat this file; echo 'ROLLBACK;') | psql -v ON_ERROR_STOP=1
-- Every check raises on failure. Synthetic data only. Uses seeded tenants tenant_a / tenant_b.
DO $$
DECLARE
  ta uuid := (SELECT id FROM core.tenants WHERE tenant_code = 'tenant_a');
  tb uuid := (SELECT id FROM core.tenants WHERE tenant_code = 'tenant_b');
  app1 uuid := '01a1a98a-ac40-7000-8000-0000000f0001';
  tok bytea := decode(repeat('ab', 32), 'hex');
  bad bytea := decode(repeat('cd', 32), 'hex');
  r text; n integer;
BEGIN
  IF ta IS NULL OR tb IS NULL THEN RAISE EXCEPTION 'seed tenants missing'; END IF;
  SET LOCAL ROLE lims_app;

  -- anonymous applicant of tenant_a
  PERFORM set_config('request.jwt.claims', json_build_object('tenant_id', ta, 'actor_type', 'patient', 'sub', '01a1a98a-ac40-7000-8000-0000000f00aa')::text, true);

  r := app.homecollection_application_create(app1, 'Sita Demo', '+9779800000001', 'Sita@Example.Test', 'Demo Tole', 'part_time', 'double', ARRAY['morning','evening'], tok);
  IF r <> 'created' THEN RAISE EXCEPTION 'create: %', r; END IF;
  r := app.homecollection_application_create('01a1a98a-ac40-7000-8000-0000000f0002', 'Sita Demo', '+9779800000001', 'sita@example.test', 'Demo Tole', 'full_time', NULL, NULL, tok);
  IF r <> 'exists' THEN RAISE EXCEPTION 'second open application for one phone must be refused: %', r; END IF;

  -- the anonymous actor cannot read or write the tables directly
  SELECT count(*) INTO n FROM homecollection.phlebo_applications;
  IF n <> 0 THEN RAISE EXCEPTION 'anonymous actor can read applications (%)', n; END IF;
  BEGIN
    UPDATE homecollection.phlebo_applications SET status = 'approved';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'anonymous actor updated % applications', n; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- wrong token: nothing
  SELECT count(*) INTO n FROM app.homecollection_application_upload_state(app1, bad);
  IF n <> 0 THEN RAISE EXCEPTION 'wrong token saw upload state'; END IF;
  r := app.homecollection_application_add_document(app1, bad, '01a1a98a-ac40-7000-8000-0000000d0000', 'licence', 'a.pdf', 'application/pdf', 10, 10, tok,
        ta::text || '/' || app1::text || '/01a1a98a-ac40-7000-8000-0000000d0000.gz');
  IF r <> 'denied' THEN RAISE EXCEPTION 'wrong token added a document: %', r; END IF;
  IF app.homecollection_application_submit(app1, bad) <> 'denied' THEN RAISE EXCEPTION 'wrong token submitted'; END IF;

  -- incomplete: cannot submit
  IF app.homecollection_application_submit(app1, tok) <> 'incomplete' THEN RAISE EXCEPTION 'submitted without documents'; END IF;

  r := app.homecollection_application_add_document(app1, tok, '01a1a98a-ac40-7000-8000-0000000d0001', 'licence', 'a.pdf', 'application/pdf', 10, 10, tok, ta::text || '/' || app1::text || '/01a1a98a-ac40-7000-8000-0000000d0001.gz');
  IF r <> 'added' THEN RAISE EXCEPTION 'add licence: %', r; END IF;
  r := app.homecollection_application_add_document(app1, tok, '01a1a98a-ac40-7000-8000-0000000d0002', 'licence', 'b.pdf', 'application/pdf', 10, 10, tok, ta::text || '/' || app1::text || '/01a1a98a-ac40-7000-8000-0000000d0002.gz');
  IF r <> 'too_many' THEN RAISE EXCEPTION 'second licence must be refused: %', r; END IF;
  PERFORM app.homecollection_application_add_document(app1, tok, '01a1a98a-ac40-7000-8000-0000000d0003', 'training_certificate', 'c.jpg', 'image/jpeg', 10, 10, tok, ta::text || '/' || app1::text || '/01a1a98a-ac40-7000-8000-0000000d0003.gz');
  PERFORM app.homecollection_application_add_document(app1, tok, '01a1a98a-ac40-7000-8000-0000000d0004', 'identity', 'd.png', 'image/png', 10, 10, tok, ta::text || '/' || app1::text || '/01a1a98a-ac40-7000-8000-0000000d0004.gz');
  BEGIN
    PERFORM app.homecollection_application_add_document(app1, tok, '01a1a98a-ac40-7000-8000-0000000d0005', 'photo', 'e.pdf', 'application/pdf', 10, 10, tok, ta::text || '/' || app1::text || '/01a1a98a-ac40-7000-8000-0000000d0005.gz');
    RAISE EXCEPTION 'a PDF photo was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM app.homecollection_application_add_document(app1, tok, '01a1a98a-ac40-7000-8000-0000000d0006', 'photo', 'e.jpg', 'image/jpeg', 10, 10, tok, ta::text || '/' || app1::text || '/01a1a98a-ac40-7000-8000-0000000d0006.gz');
  SELECT sum(s.n) INTO n FROM app.homecollection_application_upload_state(app1, tok) s;
  IF n <> 4 THEN RAISE EXCEPTION 'upload state counts %', n; END IF;

  IF app.homecollection_application_submit(app1, tok) <> 'submitted' THEN RAISE EXCEPTION 'submit failed'; END IF;
  -- the token is dead after submit
  IF app.homecollection_application_submit(app1, tok) <> 'denied' THEN RAISE EXCEPTION 'submitted twice'; END IF;
  SELECT count(*) INTO n FROM app.homecollection_application_upload_state(app1, tok);
  IF n <> 0 THEN RAISE EXCEPTION 'token still works after submit'; END IF;

  -- an anonymous caller of ANOTHER tenant with the right token gets nothing
  PERFORM set_config('request.jwt.claims', json_build_object('tenant_id', tb, 'actor_type', 'patient', 'sub', '01a1a98a-ac40-7000-8000-0000000f00bb')::text, true);
  IF app.homecollection_application_add_document(app1, tok, '01a1a98a-ac40-7000-8000-0000000d0007', 'identity', 'x.png', 'image/png', 10, 10, tok, tb::text || '/' || app1::text || '/01a1a98a-ac40-7000-8000-0000000d0007.gz') <> 'denied'
    THEN RAISE EXCEPTION 'cross-tenant add'; END IF;

  -- a staff member (not a pre-auth actor) cannot use the anonymous functions
  PERFORM set_config('request.jwt.claims', json_build_object('tenant_id', ta, 'actor_type', 'user', 'sub', '01a1a98a-ac40-7000-8000-0000000f00cc', 'all_centres', true)::text, true);
  IF app.homecollection_application_create('01a1a98a-ac40-7000-8000-0000000f0009', 'Other Demo', '+9779800000009', 'o@example.test', 'X', 'full_time', NULL, NULL, tok) <> 'denied'
    THEN RAISE EXCEPTION 'staff used the anonymous create'; END IF;

  RAISE NOTICE 'phlebo applications scenario: anonymous side OK';
END $$;
