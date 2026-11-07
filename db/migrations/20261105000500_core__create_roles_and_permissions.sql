-- T0B-03: core.g_permissions (class G), core.roles, core.role_permissions, core.membership_roles — class M
-- (05-SCHEMA §3.4, IC §11, §5, §6, §7, §10 verbatim).
SET LOCAL ROLE lims_owner;

CREATE TABLE core.g_permissions (
  code text NOT NULL, module text NOT NULL, privileged boolean NOT NULL, phase text NOT NULL,
  description text, is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_permissions__pk PRIMARY KEY (code),
  CONSTRAINT g_permissions__code__ck CHECK (code ~ '^[a-z_]+\.[a-z_]+\.[a-z_]+$'),
  CONSTRAINT g_permissions__phase__ck CHECK (phase IN ('1','1.5','2','3'))
);
GRANT SELECT ON core.g_permissions TO lims_app;   -- class G: RLS-exempt, read-only

CREATE TABLE core.roles (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  role_code text NOT NULL, display_name text NOT NULL, description text,
  is_system_default boolean NOT NULL DEFAULT false, mfa_required boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT roles__pk PRIMARY KEY (id),
  CONSTRAINT roles__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT roles__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT roles__role_code__ck CHECK (role_code ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT roles__text__ck CHECK (char_length(display_name) BETWEEN 1 AND 80 AND coalesce(char_length(description),0) <= 300)
);
CREATE UNIQUE INDEX roles__tenant_id_role_code__uq ON core.roles (tenant_id, role_code);

ALTER TABLE core.roles ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles__select__tenant ON core.roles FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY roles__insert__tenant ON core.roles FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY roles__update__tenant ON core.roles FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY roles__select__owner_only ON core.roles FOR SELECT TO lims_owner
  USING (tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid);        -- C2 identity_login_context
GRANT SELECT, INSERT, UPDATE ON core.roles TO lims_app;
CREATE TRIGGER roles__audit AFTER INSERT OR UPDATE OR DELETE ON core.roles FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

CREATE TABLE core.role_permissions (
  tenant_id uuid NOT NULL, role_id uuid NOT NULL, permission_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT role_permissions__pk PRIMARY KEY (tenant_id, role_id, permission_code),
  CONSTRAINT role_permissions__role__fk FOREIGN KEY (tenant_id, role_id) REFERENCES core.roles (tenant_id, id),
  CONSTRAINT role_permissions__permission__fk FOREIGN KEY (permission_code) REFERENCES core.g_permissions (code),
  CONSTRAINT role_permissions__no_platform__ck CHECK (permission_code NOT LIKE 'platform.%')
);
CREATE INDEX role_permissions__tenant_id_permission_code__idx ON core.role_permissions (tenant_id, permission_code);   -- 08 A3.4

ALTER TABLE core.role_permissions ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permissions__select__tenant ON core.role_permissions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY role_permissions__insert__tenant ON core.role_permissions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY role_permissions__delete__tenant ON core.role_permissions FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, DELETE ON core.role_permissions TO lims_app;
CREATE TRIGGER role_permissions__audit AFTER INSERT OR UPDATE OR DELETE ON core.role_permissions FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

CREATE TABLE core.membership_roles (
  tenant_id uuid NOT NULL, membership_id uuid NOT NULL, role_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT membership_roles__pk PRIMARY KEY (tenant_id, membership_id, role_id),
  CONSTRAINT membership_roles__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT membership_roles__role__fk FOREIGN KEY (tenant_id, role_id) REFERENCES core.roles (tenant_id, id)
);
CREATE INDEX membership_roles__tenant_id_role_id__idx ON core.membership_roles (tenant_id, role_id);                    -- 08 A3.4

ALTER TABLE core.membership_roles ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.membership_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_roles__select__tenant ON core.membership_roles FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_roles__insert__tenant ON core.membership_roles FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_roles__delete__tenant ON core.membership_roles FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_roles__select__owner_only ON core.membership_roles FOR SELECT TO lims_owner
  USING (tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid          -- C2 identity_login_context: the chosen
         AND EXISTS (SELECT 1 FROM core.memberships m                                      -- tenant and a membership of the user
                     WHERE m.tenant_id = membership_roles.tenant_id AND m.id = membership_roles.membership_id
                       AND m.user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid));
GRANT SELECT, INSERT, DELETE ON core.membership_roles TO lims_app;
CREATE TRIGGER membership_roles__audit AFTER INSERT OR UPDATE OR DELETE ON core.membership_roles FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
