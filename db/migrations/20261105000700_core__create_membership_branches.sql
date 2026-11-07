-- T0B-06: core.membership_branches — association class, audited (05-SCHEMA §3.3, §5, §10 verbatim; CR-C2-003; 08 R3) and the
-- app.tg_scope_user_only BEFORE INSERT trigger on both scope tables (non-user memberships refused: 23514 scope_user_only).
SET LOCAL ROLE lims_owner;

CREATE TABLE core.membership_branches (                                -- CR-C2-003; 08 R3 (explicit branch scope, application-level only)
  tenant_id uuid NOT NULL, membership_id uuid NOT NULL, branch_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT membership_branches__pk PRIMARY KEY (tenant_id, membership_id, branch_id),
  CONSTRAINT membership_branches__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT membership_branches__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id)
);

CREATE FUNCTION app.tg_scope_user_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.memberships m
                 WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.membership_id AND m.actor_type = 'user') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'scope_user_only', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;   -- 08 R3: centre/branch scope rows only for staff memberships
CREATE TRIGGER membership_centres__scope_user_only BEFORE INSERT ON core.membership_centres
  FOR EACH ROW EXECUTE FUNCTION app.tg_scope_user_only();
CREATE TRIGGER membership_branches__scope_user_only BEFORE INSERT ON core.membership_branches
  FOR EACH ROW EXECUTE FUNCTION app.tg_scope_user_only();

ALTER TABLE core.membership_branches ENABLE ROW LEVEL SECURITY;  ALTER TABLE core.membership_branches FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_branches__select__tenant ON core.membership_branches FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_branches__insert__tenant ON core.membership_branches FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_branches__delete__tenant ON core.membership_branches FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT, DELETE ON core.membership_branches TO lims_app;
CREATE TRIGGER membership_branches__audit AFTER INSERT OR UPDATE OR DELETE ON core.membership_branches FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
