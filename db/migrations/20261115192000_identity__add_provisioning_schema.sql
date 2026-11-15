-- PLATFORM-DDL-1 (LD-223, founder-approved 2026-11-15 19:49 NPT; audit-realstack-20261115 RS-05): the provisioning schema that provisionTenant
-- (services/api/src/modules/identity/service/tenant.service.ts) already writes, so a live provisioning no longer fails with 42703 / 42P01.
--   (1) identity.tenant_settings.training_mode exactly as CR C2.T16 (.orchestra/cr/C2.T16.nonblocking.md; LD-26; 08 A33-3: set at provisioning
--       only): boolean NOT NULL DEFAULT false + a BEFORE UPDATE trigger that refuses any change of the value (no tenant / platform PATCH path).
--   (2) identity.tenant_contract_acceptances exactly as CR C2.T22 (.orchestra/cr/C2.T22.nonblocking.md; LD-29): append-only rows, ENABLE + FORCE
--       RLS, __tenant SELECT / INSERT (C2 05-SCHEMA s5.2 pred_t) + __platform SELECT (s5.3 predicate), GRANT SELECT, INSERT only, audited.
--       recorded_by = the platform staff user. The C2.T22-detail DEFINER is NOT added here (LD-223: no new DEFINER).
-- Additive only: no existing policy, grant, function, trigger or table changes. Policies copied 1:1 into db/policies/identity.sql (AC-0B-2.3).
-- NOT RUN in the lane: db/tests/identity/PLATFORM-DDL-1_policies.test.sql (sections C, D).
SET LOCAL ROLE lims_owner;

-- (1) CR C2.T16 ---------------------------------------------------------------------------------------
ALTER TABLE identity.tenant_settings ADD COLUMN training_mode boolean NOT NULL DEFAULT false;

-- INVOKER trigger function, as identity.tenant_settings__check_arrays (20261105001300); error text [CONV]
CREATE FUNCTION identity.tenant_settings__training_mode_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.training_mode IS DISTINCT FROM OLD.training_mode THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'training_mode_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_settings__training_mode_immutable BEFORE UPDATE ON identity.tenant_settings
  FOR EACH ROW EXECUTE FUNCTION identity.tenant_settings__training_mode_immutable();

-- (2) CR C2.T22 ---------------------------------------------------------------------------------------
CREATE TABLE identity.tenant_contract_acceptances (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  document text NOT NULL,
  version text NOT NULL,
  accepted_by_name text NOT NULL,
  accepted_by_title text NOT NULL,
  accepted_at timestamptz NOT NULL,
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  CONSTRAINT tenant_contract_acceptances__pk PRIMARY KEY (id),
  CONSTRAINT tenant_contract_acceptances__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT tenant_contract_acceptances__document__ck CHECK (document IN ('tos','dpa')),
  CONSTRAINT tenant_contract_acceptances__version__ck CHECK (char_length(version) BETWEEN 1 AND 32),
  CONSTRAINT tenant_contract_acceptances__name__ck CHECK (char_length(accepted_by_name) BETWEEN 1 AND 120),
  CONSTRAINT tenant_contract_acceptances__title__ck CHECK (char_length(accepted_by_title) BETWEEN 1 AND 80)
);
ALTER TABLE identity.tenant_contract_acceptances OWNER TO lims_owner;
CREATE INDEX tenant_contract_acceptances__tenant_id_document_accepted_at__idx ON identity.tenant_contract_acceptances (tenant_id, document, accepted_at DESC);
ALTER TABLE identity.tenant_contract_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.tenant_contract_acceptances FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_contract_acceptances__select__tenant ON identity.tenant_contract_acceptances FOR SELECT TO lims_app
  USING (tenant_id=(SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenant_contract_acceptances__insert__tenant ON identity.tenant_contract_acceptances FOR INSERT TO lims_app
  WITH CHECK (tenant_id=(SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenant_contract_acceptances__select__platform ON identity.tenant_contract_acceptances FOR SELECT TO lims_app
  USING ((SELECT app.is_platform_actor()));

-- append-only: no UPDATE / DELETE grant (CR C2.T22)
GRANT SELECT, INSERT ON identity.tenant_contract_acceptances TO lims_app;

CREATE TRIGGER tenant_contract_acceptances__audit AFTER INSERT OR UPDATE OR DELETE ON identity.tenant_contract_acceptances
  FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
