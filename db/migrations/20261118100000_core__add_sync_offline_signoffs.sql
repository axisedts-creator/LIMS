-- T0B-SYNC-4 (LD-322 decisions 2 and 3, LD-325 b; founder blanket authority LD-310; founder 2026-11-17 09:19 NPT offline requirement): storage the
-- offline adapters result.enter, result.verify and report.print_marker need, plus the issued offline flag of a print job.
-- [CR .orchestra/cr/T0B-SYNC-4.nonblocking.md] the contract names no table for these; names follow core.sync_operation / core.sync_conflict.
-- New tenant tables (schema core, written only by the sync adapters on the operation's transaction):
--   core.sync_signoff_outcome  one row per result.verify operation that reached the policy: accepted | rejected (the sign offs a print relied on).
--                              Append only (no UPDATE, no DELETE grant).
--   core.sync_print_marker     one row per report.print_marker operation: the report version printed offline, the results it showed and the state
--                              pending -> confirmed | recall_required, confirmed -> recall_required (BEFORE UPDATE trigger; recall_required is final).
--   core.sync_alert            alerts for the lab manager (result_locked, verification_policy_failed): ids and codes only, never a value or a name.
--                              Append only.
-- Changed table: reporting.print_jobs gains issued_offline boolean NOT NULL DEFAULT false (the print path sets it while a marker is pending).
-- Additive only; idempotent (IF NOT EXISTS, guarded policies, CREATE OR REPLACE). Cloud apply is a founder step (push-cloud), not done by this task.
-- DOWN (manual, founder decision, export first):
--   DROP TABLE IF EXISTS core.sync_alert, core.sync_print_marker, core.sync_signoff_outcome CASCADE;
--   DROP FUNCTION IF EXISTS core.sync_print_marker__state_move();
--   ALTER TABLE reporting.print_jobs DROP COLUMN IF EXISTS issued_offline;
SET LOCAL ROLE lims_owner;

CREATE TABLE IF NOT EXISTS core.sync_signoff_outcome (
  tenant_id         uuid        NOT NULL,
  op_id             uuid        NOT NULL,
  device_id         uuid        NOT NULL,
  result_id         uuid        NOT NULL,
  outcome           text        NOT NULL,
  device_created_at timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_signoff_outcome__pk PRIMARY KEY (tenant_id, op_id),
  CONSTRAINT sync_signoff_outcome__operation__fk FOREIGN KEY (tenant_id, op_id) REFERENCES core.sync_operation (tenant_id, op_id),
  CONSTRAINT sync_signoff_outcome__outcome__ck CHECK (outcome IN ('accepted','rejected'))
);
CREATE INDEX IF NOT EXISTS sync_signoff_outcome__tenant_id_device_id_result_id__idx ON core.sync_signoff_outcome (tenant_id, device_id, result_id);

CREATE TABLE IF NOT EXISTS core.sync_print_marker (
  tenant_id         uuid        NOT NULL,
  op_id             uuid        NOT NULL,
  report_version_id uuid        NOT NULL,
  result_ids        uuid[]      NOT NULL,
  device_id         uuid        NOT NULL,
  state             text        NOT NULL DEFAULT 'pending',
  device_created_at timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_print_marker__pk PRIMARY KEY (tenant_id, op_id),
  CONSTRAINT sync_print_marker__operation__fk FOREIGN KEY (tenant_id, op_id) REFERENCES core.sync_operation (tenant_id, op_id),
  CONSTRAINT sync_print_marker__state__ck CHECK (state IN ('pending','confirmed','recall_required')),
  CONSTRAINT sync_print_marker__results__ck CHECK (cardinality(result_ids) <= 2000)
);
CREATE INDEX IF NOT EXISTS sync_print_marker__tenant_id_report_version_id__idx ON core.sync_print_marker (tenant_id, report_version_id);
CREATE INDEX IF NOT EXISTS sync_print_marker__result_ids__gin ON core.sync_print_marker USING gin (result_ids);

CREATE OR REPLACE FUNCTION core.sync_print_marker__state_move() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.tenant_id, NEW.op_id, NEW.report_version_id, NEW.result_ids, NEW.device_id, NEW.device_created_at, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.op_id, OLD.report_version_id, OLD.result_ids, OLD.device_id, OLD.device_created_at, OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'core.sync_print_marker';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT ((OLD.state = 'pending' AND NEW.state IN ('confirmed','recall_required'))
     OR (OLD.state = 'confirmed' AND NEW.state = 'recall_required')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'core.sync_print_marker state move';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER sync_print_marker__state_move BEFORE UPDATE ON core.sync_print_marker
  FOR EACH ROW EXECUTE FUNCTION core.sync_print_marker__state_move();

CREATE TABLE IF NOT EXISTS core.sync_alert (
  id                 uuid        NOT NULL,
  tenant_id          uuid        NOT NULL,
  kind               text        NOT NULL,
  op_id              uuid        NOT NULL,
  result_id          uuid,
  code               text,
  report_version_ids uuid[]      NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_alert__pk PRIMARY KEY (id),
  CONSTRAINT sync_alert__operation__fk FOREIGN KEY (tenant_id, op_id) REFERENCES core.sync_operation (tenant_id, op_id),
  CONSTRAINT sync_alert__kind__ck CHECK (kind IN ('result_locked','verification_policy_failed')),
  CONSTRAINT sync_alert__code__ck CHECK (code IS NULL OR code ~ '^[a-z][a-z0-9_.]{0,63}$'),
  CONSTRAINT sync_alert__reports__ck CHECK (cardinality(report_version_ids) <= 500)
);
CREATE INDEX IF NOT EXISTS sync_alert__tenant_id_created_at__idx ON core.sync_alert (tenant_id, created_at);

ALTER TABLE reporting.print_jobs ADD COLUMN IF NOT EXISTS issued_offline boolean NOT NULL DEFAULT false;

-- RLS by tenant (staff and system actors) as core.sync_operation
ALTER TABLE core.sync_signoff_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.sync_signoff_outcome FORCE ROW LEVEL SECURITY;
ALTER TABLE core.sync_print_marker ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.sync_print_marker FORCE ROW LEVEL SECURITY;
ALTER TABLE core.sync_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.sync_alert FORCE ROW LEVEL SECURITY;

DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'core.sync_signoff_outcome'::regclass AND polname = 'sync_signoff_outcome__select__tenant') THEN
  CREATE POLICY sync_signoff_outcome__select__tenant ON core.sync_signoff_outcome FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'core.sync_signoff_outcome'::regclass AND polname = 'sync_signoff_outcome__insert__tenant') THEN
  CREATE POLICY sync_signoff_outcome__insert__tenant ON core.sync_signoff_outcome FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'core.sync_print_marker'::regclass AND polname = 'sync_print_marker__select__tenant') THEN
  CREATE POLICY sync_print_marker__select__tenant ON core.sync_print_marker FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'core.sync_print_marker'::regclass AND polname = 'sync_print_marker__insert__tenant') THEN
  CREATE POLICY sync_print_marker__insert__tenant ON core.sync_print_marker FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'core.sync_print_marker'::regclass AND polname = 'sync_print_marker__update__tenant') THEN
  CREATE POLICY sync_print_marker__update__tenant ON core.sync_print_marker FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'core.sync_alert'::regclass AND polname = 'sync_alert__select__tenant') THEN
  CREATE POLICY sync_alert__select__tenant ON core.sync_alert FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'core.sync_alert'::regclass AND polname = 'sync_alert__insert__tenant') THEN
  CREATE POLICY sync_alert__insert__tenant ON core.sync_alert FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;

GRANT SELECT, INSERT ON core.sync_signoff_outcome TO lims_app;
GRANT SELECT, INSERT ON core.sync_print_marker TO lims_app;
GRANT UPDATE (state, updated_at) ON core.sync_print_marker TO lims_app;
GRANT SELECT, INSERT ON core.sync_alert TO lims_app;
-- not row audited (as core.sync_operation): every row is the trace of one ledger operation, and the print itself writes its access audit event.
