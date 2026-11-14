-- T0B-03: core.branches, core.collection_centres — class M, tenant-scoped (05-SCHEMA §3.2, §5, §6, §7, §10 verbatim).
SET LOCAL ROLE lims_owner;

CREATE TABLE core.branches (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  branch_code text NOT NULL, name text NOT NULL, address_text text, phone_display text,
  is_processing_lab boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT branches__pk PRIMARY KEY (id),
  CONSTRAINT branches__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT branches__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT branches__branch_code__ck CHECK (branch_code ~ '^[A-Za-z0-9-]{1,16}$'),
  CONSTRAINT branches__text__ck CHECK (char_length(name) BETWEEN 1 AND 120 AND coalesce(char_length(address_text),0) <= 500
                                      AND coalesce(char_length(phone_display),0) <= 40)
);
CREATE UNIQUE INDEX branches__tenant_id_branch_code__uq ON core.branches (tenant_id, branch_code);
CREATE INDEX branches__tenant_id_is_active__idx ON core.branches (tenant_id, is_active);

ALTER TABLE core.branches ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.branches FORCE ROW LEVEL SECURITY;
CREATE POLICY branches__select__tenant ON core.branches FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY branches__insert__tenant ON core.branches FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY branches__update__tenant ON core.branches FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON core.branches TO lims_app;
CREATE TRIGGER branches__audit AFTER INSERT OR UPDATE OR DELETE ON core.branches FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

CREATE TABLE core.collection_centres (
  id uuid NOT NULL, tenant_id uuid NOT NULL, branch_id uuid NOT NULL,
  centre_code text NOT NULL, name text NOT NULL, centre_kind text NOT NULL,
  address_text text, phone_display text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT collection_centres__pk PRIMARY KEY (id),
  CONSTRAINT collection_centres__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT collection_centres__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT collection_centres__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT collection_centres__centre_code__ck CHECK (centre_code ~ '^[A-Za-z0-9-]{1,16}$'),
  CONSTRAINT collection_centres__kind__ck CHECK (centre_kind IN ('own','franchise','home_collection')),
  CONSTRAINT collection_centres__text__ck CHECK (char_length(name) BETWEEN 1 AND 120 AND coalesce(char_length(address_text),0) <= 500
                                                AND coalesce(char_length(phone_display),0) <= 40)
);
CREATE UNIQUE INDEX collection_centres__tenant_id_centre_code__uq ON core.collection_centres (tenant_id, centre_code);
CREATE INDEX collection_centres__tenant_id_branch_id__idx ON core.collection_centres (tenant_id, branch_id, is_active);

ALTER TABLE core.collection_centres ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.collection_centres FORCE ROW LEVEL SECURITY;
CREATE POLICY collection_centres__select__tenant ON core.collection_centres FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY collection_centres__insert__tenant ON core.collection_centres FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY collection_centres__update__tenant ON core.collection_centres FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, UPDATE ON core.collection_centres TO lims_app;
CREATE TRIGGER collection_centres__audit AFTER INSERT OR UPDATE OR DELETE ON core.collection_centres FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
