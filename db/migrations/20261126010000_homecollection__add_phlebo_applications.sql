-- PHLEBO-UI-FULL-1 (founder request 2026-11-26, .orchestra/cr/PHLEBO-UI-FULL-1.md): phlebotomist job applications.
-- A person who is not signed in applies from the phlebotomist app (patientPreAuth credential = tenant only). Staff holding
-- homecollection.application.manage review, approve or reject in the web app. The web bell lists waiting applications.
-- The anonymous side never touches the tables: it goes through the four DEFINER functions below, which check an upload
-- token (only its SHA-256 is stored). Document bytes live on the API server's disk, never in the database. P2 (applicant
-- identity data: name, phone, email, identity documents).
SET LOCAL ROLE lims_owner;

CREATE TABLE homecollection.phlebo_applications (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  full_name text NOT NULL, phone_e164 text NOT NULL, email text NOT NULL, area text NOT NULL,
  employment_type text NOT NULL, shift_count text, day_slots text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'uploading',
  upload_token_sha256 bytea NOT NULL,
  submitted_at timestamptz, decided_at timestamptz, decided_by uuid, decision_note text,
  membership_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  CONSTRAINT phlebo_applications__pk PRIMARY KEY (id),
  CONSTRAINT phlebo_applications__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT phlebo_applications__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT phlebo_applications__member__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT phlebo_applications__name__ck CHECK (char_length(full_name) BETWEEN 3 AND 120),
  CONSTRAINT phlebo_applications__phone__ck CHECK (phone_e164 ~ '^\+9779[678][0-9]{8}$'),
  CONSTRAINT phlebo_applications__email__ck CHECK (char_length(email) BETWEEN 6 AND 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT phlebo_applications__area__ck CHECK (char_length(area) BETWEEN 1 AND 120),
  CONSTRAINT phlebo_applications__employment__ck CHECK (employment_type IN ('full_time','part_time')),
  CONSTRAINT phlebo_applications__shift__ck CHECK (
        (employment_type = 'full_time' AND shift_count IS NULL AND day_slots = '{}')
     OR (employment_type = 'part_time' AND shift_count = 'single' AND cardinality(day_slots) = 1)
     OR (employment_type = 'part_time' AND shift_count = 'double' AND cardinality(day_slots) = 2)),
  CONSTRAINT phlebo_applications__slots__ck CHECK (day_slots <@ ARRAY['morning','afternoon','evening']),
  CONSTRAINT phlebo_applications__status__ck CHECK (status IN ('uploading','submitted','approved','rejected')),
  CONSTRAINT phlebo_applications__token__ck CHECK (octet_length(upload_token_sha256) = 32),
  CONSTRAINT phlebo_applications__decision__ck CHECK ((status IN ('approved','rejected')) = (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  CONSTRAINT phlebo_applications__note__ck CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 500)
);
CREATE INDEX phlebo_applications__tenant_id_status_created__idx ON homecollection.phlebo_applications (tenant_id, status, created_at DESC);
-- one open application per phone number
CREATE UNIQUE INDEX phlebo_applications__tenant_id_phone__p_uq ON homecollection.phlebo_applications (tenant_id, phone_e164) WHERE status IN ('uploading','submitted');

CREATE TABLE homecollection.phlebo_application_documents (
  id uuid NOT NULL, tenant_id uuid NOT NULL, application_id uuid NOT NULL,
  kind text NOT NULL, file_name text NOT NULL, content_type text NOT NULL,
  byte_size integer NOT NULL, stored_size integer NOT NULL, sha256 bytea NOT NULL, storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phlebo_application_documents__pk PRIMARY KEY (id),
  CONSTRAINT phlebo_application_documents__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT phlebo_application_documents__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT phlebo_application_documents__application__fk FOREIGN KEY (tenant_id, application_id) REFERENCES homecollection.phlebo_applications (tenant_id, id),
  CONSTRAINT phlebo_application_documents__kind__ck CHECK (kind IN ('licence','training_certificate','identity','photo')),
  CONSTRAINT phlebo_application_documents__type__ck CHECK (content_type IN ('image/jpeg','image/png','application/pdf') AND (kind <> 'photo' OR content_type <> 'application/pdf')),
  CONSTRAINT phlebo_application_documents__name__ck CHECK (char_length(file_name) BETWEEN 1 AND 120),
  CONSTRAINT phlebo_application_documents__size__ck CHECK (byte_size BETWEEN 1 AND 2097152 AND stored_size BETWEEN 1 AND 2200000),   -- 2 MiB
  CONSTRAINT phlebo_application_documents__sha__ck CHECK (octet_length(sha256) = 32),
  CONSTRAINT phlebo_application_documents__path__ck CHECK (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.gz$')
);
CREATE INDEX phlebo_application_documents__tenant_id_application__idx ON homecollection.phlebo_application_documents (tenant_id, application_id);

ALTER TABLE homecollection.phlebo_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.phlebo_applications FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.phlebo_application_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.phlebo_application_documents FORCE ROW LEVEL SECURITY;

-- Staff: tenant-wide (an applicant belongs to no centre yet). The permission is checked in the API.
CREATE POLICY phlebo_applications__select__tenant ON homecollection.phlebo_applications FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY phlebo_applications__update__tenant ON homecollection.phlebo_applications FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY phlebo_application_documents__select__tenant ON homecollection.phlebo_application_documents FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, UPDATE ON homecollection.phlebo_applications TO lims_app;
GRANT SELECT ON homecollection.phlebo_application_documents TO lims_app;

-- Owner policies: only inside the DEFINER functions below (they set app.maintenance), and only in the caller's tenant.
CREATE POLICY phlebo_applications__all__owner_apply ON homecollection.phlebo_applications FOR ALL TO lims_owner
  USING      (current_setting('app.maintenance', true) = 'homecollection_phlebo_application' AND tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (current_setting('app.maintenance', true) = 'homecollection_phlebo_application' AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY phlebo_application_documents__all__owner_apply ON homecollection.phlebo_application_documents FOR ALL TO lims_owner
  USING      (current_setting('app.maintenance', true) = 'homecollection_phlebo_application' AND tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (current_setting('app.maintenance', true) = 'homecollection_phlebo_application' AND tenant_id = (SELECT app.current_tenant_id()));

-- ---- anonymous side: DEFINER functions. Caller must be a pre-auth actor of a resolved tenant. Errors carry no detail.
CREATE FUNCTION app.homecollection_application_create(
  p_id uuid, p_full_name text, p_phone_e164 text, p_email text, p_area text,
  p_employment_type text, p_shift_count text, p_day_slots text[], p_token_sha256 bytea)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid := app.current_tenant_id();
BEGIN
  IF v_tenant IS NULL OR app.current_actor_type() IS DISTINCT FROM 'patient' THEN RETURN 'denied'; END IF;
  PERFORM set_config('app.maintenance', 'homecollection_phlebo_application', true);
  -- an abandoned upload for the same phone older than one hour is replaced
  DELETE FROM homecollection.phlebo_application_documents d USING homecollection.phlebo_applications a
   WHERE d.tenant_id = v_tenant AND a.tenant_id = v_tenant AND d.application_id = a.id
     AND a.phone_e164 = p_phone_e164 AND a.status = 'uploading' AND a.created_at < now() - interval '1 hour';
  DELETE FROM homecollection.phlebo_applications
   WHERE tenant_id = v_tenant AND phone_e164 = p_phone_e164 AND status = 'uploading' AND created_at < now() - interval '1 hour';
  IF EXISTS (SELECT 1 FROM homecollection.phlebo_applications WHERE tenant_id = v_tenant AND phone_e164 = p_phone_e164 AND status IN ('uploading','submitted')) THEN
    PERFORM set_config('app.maintenance', '', true);
    RETURN 'exists';
  END IF;
  INSERT INTO homecollection.phlebo_applications (id, tenant_id, full_name, phone_e164, email, area, employment_type, shift_count, day_slots, upload_token_sha256)
  VALUES (p_id, v_tenant, p_full_name, p_phone_e164, lower(p_email), p_area, p_employment_type, p_shift_count, COALESCE(p_day_slots, '{}'), p_token_sha256);
  PERFORM set_config('app.maintenance', '', true);
  RETURN 'created';
END $$;

-- How many documents of each kind an application being uploaded already has; no row = unknown id, wrong token or not uploading.
CREATE FUNCTION app.homecollection_application_upload_state(p_id uuid, p_token_sha256 bytea)
RETURNS TABLE (kind text, n integer) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid := app.current_tenant_id();
BEGIN
  IF v_tenant IS NULL OR app.current_actor_type() IS DISTINCT FROM 'patient' THEN RETURN; END IF;
  PERFORM set_config('app.maintenance', 'homecollection_phlebo_application', true);
  RETURN QUERY
    SELECT k.kind, (SELECT count(*)::integer FROM homecollection.phlebo_application_documents d
                     WHERE d.tenant_id = v_tenant AND d.application_id = a.id AND d.kind = k.kind)
      FROM homecollection.phlebo_applications a
      CROSS JOIN (VALUES ('licence'), ('training_certificate'), ('identity'), ('photo')) AS k(kind)
     WHERE a.tenant_id = v_tenant AND a.id = p_id AND a.upload_token_sha256 = p_token_sha256 AND a.status = 'uploading';
  PERFORM set_config('app.maintenance', '', true);
END $$;

CREATE FUNCTION app.homecollection_application_add_document(
  p_id uuid, p_token_sha256 bytea, p_document_id uuid, p_kind text, p_file_name text, p_content_type text,
  p_byte_size integer, p_stored_size integer, p_sha256 bytea, p_storage_path text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid := app.current_tenant_id(); v_count integer; v_max integer;
BEGIN
  IF v_tenant IS NULL OR app.current_actor_type() IS DISTINCT FROM 'patient' THEN RETURN 'denied'; END IF;
  PERFORM set_config('app.maintenance', 'homecollection_phlebo_application', true);
  PERFORM 1 FROM homecollection.phlebo_applications
    WHERE tenant_id = v_tenant AND id = p_id AND upload_token_sha256 = p_token_sha256 AND status = 'uploading' FOR UPDATE;
  IF NOT FOUND THEN PERFORM set_config('app.maintenance', '', true); RETURN 'denied'; END IF;
  v_max := CASE p_kind WHEN 'training_certificate' THEN 5 WHEN 'identity' THEN 2 ELSE 1 END;
  SELECT count(*) INTO v_count FROM homecollection.phlebo_application_documents WHERE tenant_id = v_tenant AND application_id = p_id AND kind = p_kind;
  IF v_count >= v_max THEN PERFORM set_config('app.maintenance', '', true); RETURN 'too_many'; END IF;
  INSERT INTO homecollection.phlebo_application_documents (id, tenant_id, application_id, kind, file_name, content_type, byte_size, stored_size, sha256, storage_path)
  VALUES (p_document_id, v_tenant, p_id, p_kind, p_file_name, p_content_type, p_byte_size, p_stored_size, p_sha256, p_storage_path);
  PERFORM set_config('app.maintenance', '', true);
  RETURN 'added';
END $$;

-- All four kinds present -> submitted. The token stops working after this.
CREATE FUNCTION app.homecollection_application_submit(p_id uuid, p_token_sha256 bytea)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid := app.current_tenant_id(); v_kinds integer;
BEGIN
  IF v_tenant IS NULL OR app.current_actor_type() IS DISTINCT FROM 'patient' THEN RETURN 'denied'; END IF;
  PERFORM set_config('app.maintenance', 'homecollection_phlebo_application', true);
  PERFORM 1 FROM homecollection.phlebo_applications
    WHERE tenant_id = v_tenant AND id = p_id AND upload_token_sha256 = p_token_sha256 AND status = 'uploading' FOR UPDATE;
  IF NOT FOUND THEN PERFORM set_config('app.maintenance', '', true); RETURN 'denied'; END IF;
  SELECT count(DISTINCT kind) INTO v_kinds FROM homecollection.phlebo_application_documents WHERE tenant_id = v_tenant AND application_id = p_id;
  IF v_kinds < 4 THEN PERFORM set_config('app.maintenance', '', true); RETURN 'incomplete'; END IF;
  UPDATE homecollection.phlebo_applications SET status = 'submitted', submitted_at = now(), version = version + 1, updated_at = now()
   WHERE tenant_id = v_tenant AND id = p_id;
  PERFORM set_config('app.maintenance', '', true);
  RETURN 'submitted';
END $$;

ALTER FUNCTION app.homecollection_application_create(uuid, text, text, text, text, text, text, text[], bytea) OWNER TO lims_owner;
ALTER FUNCTION app.homecollection_application_upload_state(uuid, bytea) OWNER TO lims_owner;
ALTER FUNCTION app.homecollection_application_add_document(uuid, bytea, uuid, text, text, text, integer, integer, bytea, text) OWNER TO lims_owner;
ALTER FUNCTION app.homecollection_application_submit(uuid, bytea) OWNER TO lims_owner;
REVOKE ALL ON FUNCTION app.homecollection_application_create(uuid, text, text, text, text, text, text, text[], bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.homecollection_application_upload_state(uuid, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.homecollection_application_add_document(uuid, bytea, uuid, text, text, text, integer, integer, bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.homecollection_application_submit(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.homecollection_application_create(uuid, text, text, text, text, text, text, text[], bytea) TO lims_app;
GRANT EXECUTE ON FUNCTION app.homecollection_application_upload_state(uuid, bytea) TO lims_app;
GRANT EXECUTE ON FUNCTION app.homecollection_application_add_document(uuid, bytea, uuid, text, text, text, integer, integer, bytea, text) TO lims_app;
GRANT EXECUTE ON FUNCTION app.homecollection_application_submit(uuid, bytea) TO lims_app;
