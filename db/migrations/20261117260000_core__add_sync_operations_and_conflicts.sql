-- T0C-SYNC-2 (LD-322, LD-325; founder blanket authority LD-310; founder 2026-11-17 09:19 NPT offline requirement): offline sync part 2 in schema core.
-- Design source: C:/LIMS-state/offline-design-20261117.md (sections 2 principles, 3 operation catalogue, 5 time, 8 conflict matrix).
-- New tenant tables:
--   core.sync_operation  the server ledger of every pushed offline operation. PRIMARY KEY (tenant_id, op_id): the op_id is made by the device and is
--                        the idempotency key per tenant (a re-sent op_id answers duplicate in the service). op_type is the closed catalogue of 8
--                        types (CHECK); status accepted | duplicate | rejected | conflict. Append only: lims_app has SELECT, INSERT and UPDATE, no
--                        DELETE; a BEFORE UPDATE trigger lets the outcome (status, result, error_code, skew_flag) be written once, while result is
--                        still NULL, and freezes every other column. Not row audited: the payload would be copied into the audit log and the
--                        table is itself the ledger.
--   core.sync_conflict   one row per conflict found at sync (design section 8), status open | resolved, resolution keep_server | apply_local |
--                        merge. A resolved row carries resolution, resolver, time and a non empty reason (CHECK) and is frozen by a BEFORE UPDATE
--                        trigger (written once); op_id, entity and both stored versions never change. Row audited (who resolved what).
-- Entity versions (done_when 5): base_version uses the version column the API already returns; every entity the catalogue wraps or the pull
-- whitelist names has one, so no version column is added to an old table here (where a table has none the service falls back to updated_at).
-- Additive only: new tables, functions, triggers, policies and grants; no data rewrite, no ENUM type, no change to an existing table.
-- Idempotent: IF NOT EXISTS on tables and indexes, constraints inline, each CREATE POLICY guarded by pg_policy, functions and triggers CREATE OR REPLACE.
-- Cloud apply is a founder step (push-cloud) after 20261117250000_core__add_sync_devices_and_number_blocks.sql; not done by this task.
-- DOWN (manual, never automatic; drops the sync ledger and its conflicts: founder decision, export first):
--   DROP TABLE IF EXISTS core.sync_conflict, core.sync_operation CASCADE;
--   DROP FUNCTION IF EXISTS core.sync_operation__append_only(), core.sync_conflict__resolve_once(), core.sync_conflict__resolver_ck();
--   no version column was added, so no DROP COLUMN is needed.
SET LOCAL ROLE lims_owner;

-- ---------- (1) the operation ledger ----------
CREATE TABLE IF NOT EXISTS core.sync_operation (
  tenant_id          uuid        NOT NULL,
  op_id              uuid        NOT NULL,
  device_id          uuid        NOT NULL,
  user_id            uuid        NOT NULL,
  op_type            text        NOT NULL,
  base_version       integer,
  payload_hash       text        NOT NULL,
  payload            jsonb       NOT NULL,
  device_created_at  timestamptz NOT NULL,
  server_received_at timestamptz NOT NULL DEFAULT now(),
  status             text        NOT NULL,
  result             jsonb,
  error_code         text,
  skew_flag          boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_operation__pk PRIMARY KEY (tenant_id, op_id),
  CONSTRAINT sync_operation__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT sync_operation__device__fk FOREIGN KEY (tenant_id, device_id) REFERENCES core.sync_device (tenant_id, id),
  CONSTRAINT sync_operation__user__fk FOREIGN KEY (tenant_id, user_id) REFERENCES core.users (tenant_id, id),
  CONSTRAINT sync_operation__op_type__ck CHECK (op_type IN ('registration.create_order','billing.record_receipt','collection.mark_collected',
    'accession.receive','result.enter','result.verify','report.print_marker','daily_cash.close')),
  CONSTRAINT sync_operation__status__ck CHECK (status IN ('accepted','duplicate','rejected','conflict')),
  CONSTRAINT sync_operation__base_version__ck CHECK (base_version >= 1),
  CONSTRAINT sync_operation__payload__ck CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT sync_operation__payload_hash__ck CHECK (char_length(payload_hash) BETWEEN 1 AND 128),
  CONSTRAINT sync_operation__error_code__ck CHECK (char_length(error_code) BETWEEN 1 AND 64)
);
CREATE INDEX IF NOT EXISTS sync_operation__tenant_id_device_id_server_received_at__idx ON core.sync_operation (tenant_id, device_id, server_received_at);
CREATE INDEX IF NOT EXISTS sync_operation__tenant_id_status__idx ON core.sync_operation (tenant_id, status);

-- append only: the outcome is written once (while result IS NULL, and the write must set result); every other column is frozen
CREATE OR REPLACE FUNCTION core.sync_operation__append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.tenant_id, NEW.op_id, NEW.device_id, NEW.user_id, NEW.op_type, NEW.payload_hash, NEW.payload, NEW.device_created_at,
      NEW.server_received_at, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.op_id, OLD.device_id, OLD.user_id, OLD.op_type, OLD.payload_hash, OLD.payload, OLD.device_created_at,
      OLD.server_received_at, OLD.created_at)
     OR NEW.base_version IS DISTINCT FROM OLD.base_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'core.sync_operation';
  END IF;
  IF OLD.result IS NOT NULL OR NEW.result IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'core.sync_operation outcome is written once';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER sync_operation__append_only BEFORE UPDATE ON core.sync_operation
  FOR EACH ROW EXECUTE FUNCTION core.sync_operation__append_only();

-- ---------- (2) conflicts ----------
CREATE TABLE IF NOT EXISTS core.sync_conflict (
  id             uuid        NOT NULL,
  tenant_id      uuid        NOT NULL,
  op_id          uuid        NOT NULL,
  entity_type    text        NOT NULL,
  entity_id      uuid        NOT NULL,
  local_payload  jsonb       NOT NULL,
  server_payload jsonb       NOT NULL,
  status         text        NOT NULL DEFAULT 'open',
  resolution     text,
  resolved_by    uuid,
  resolved_at    timestamptz,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid        NOT NULL,
  CONSTRAINT sync_conflict__pk PRIMARY KEY (id),
  CONSTRAINT sync_conflict__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT sync_conflict__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT sync_conflict__operation__fk FOREIGN KEY (tenant_id, op_id) REFERENCES core.sync_operation (tenant_id, op_id),
  CONSTRAINT sync_conflict__resolved_by__fk FOREIGN KEY (tenant_id, resolved_by) REFERENCES core.users (tenant_id, id),
  CONSTRAINT sync_conflict__entity_type__ck CHECK (entity_type ~ '^[a-z][a-z_]*$' AND char_length(entity_type) <= 60),
  CONSTRAINT sync_conflict__status__ck CHECK (status IN ('open','resolved')),
  CONSTRAINT sync_conflict__resolution__ck CHECK (resolution IN ('keep_server','apply_local','merge')),
  CONSTRAINT sync_conflict__reason__ck CHECK (char_length(reason) <= 1000),
  CONSTRAINT sync_conflict__resolved__ck CHECK (
    (status = 'open' AND resolution IS NULL AND resolved_at IS NULL AND reason IS NULL)
    OR (status = 'resolved' AND resolution IS NOT NULL AND resolved_at IS NOT NULL AND reason IS NOT NULL
        AND char_length(reason) >= 1))
);
CREATE INDEX IF NOT EXISTS sync_conflict__tenant_id_status_created_at__idx ON core.sync_conflict (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS sync_conflict__tenant_id_op_id__idx ON core.sync_conflict (tenant_id, op_id);

-- resolved once: op_id, entity and both stored versions never change; an open conflict may only become resolved; a resolved one never changes
CREATE OR REPLACE FUNCTION core.sync_conflict__resolve_once() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.op_id, NEW.entity_type, NEW.entity_id, NEW.local_payload, NEW.server_payload, NEW.created_at, NEW.created_by)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.op_id, OLD.entity_type, OLD.entity_id, OLD.local_payload, OLD.server_payload, OLD.created_at, OLD.created_by) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'core.sync_conflict';
  END IF;
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'core.sync_conflict is resolved once';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER sync_conflict__resolve_once BEFORE UPDATE ON core.sync_conflict
  FOR EACH ROW EXECUTE FUNCTION core.sync_conflict__resolve_once();

-- resolved_by is set exactly when resolved (the rest of the rule is sync_conflict__resolved__ck). Kept out of the CHECK on purpose: an AFTER
-- row trigger fires after the foreign key triggers (RI_ConstraintTrigger_* sort first by name), so a resolver of another tenant answers
-- 23503 from sync_conflict__resolved_by__fk (isolation probe step 6) and a missing or early resolver still answers 23514.
CREATE OR REPLACE FUNCTION core.sync_conflict__resolver_ck() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.status = 'open') = (NEW.resolved_by IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'sync_conflict__resolved__ck', DETAIL = 'resolved_by is set exactly when the conflict is resolved';
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER sync_conflict__resolver_ck AFTER INSERT OR UPDATE ON core.sync_conflict
  FOR EACH ROW EXECUTE FUNCTION core.sync_conflict__resolver_ck();

-- ---------- (3) RLS by tenant (staff and system actors), policies, grants (no DELETE), audit ----------
ALTER TABLE core.sync_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.sync_operation FORCE ROW LEVEL SECURITY;
ALTER TABLE core.sync_conflict ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.sync_conflict FORCE ROW LEVEL SECURITY;

DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'core.sync_operation'::regclass AND polname = 'sync_operation__select__tenant') THEN
  CREATE POLICY sync_operation__select__tenant ON core.sync_operation FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'core.sync_operation'::regclass AND polname = 'sync_operation__insert__tenant') THEN
  CREATE POLICY sync_operation__insert__tenant ON core.sync_operation FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'core.sync_operation'::regclass AND polname = 'sync_operation__update__tenant') THEN
  CREATE POLICY sync_operation__update__tenant ON core.sync_operation FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;

DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'core.sync_conflict'::regclass AND polname = 'sync_conflict__select__tenant') THEN
  CREATE POLICY sync_conflict__select__tenant ON core.sync_conflict FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'core.sync_conflict'::regclass AND polname = 'sync_conflict__insert__tenant') THEN
  CREATE POLICY sync_conflict__insert__tenant ON core.sync_conflict FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'core.sync_conflict'::regclass AND polname = 'sync_conflict__update__tenant') THEN
  CREATE POLICY sync_conflict__update__tenant ON core.sync_conflict FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;

-- sync_operation: UPDATE only on the outcome columns (the trigger enforces once); sync_conflict: UPDATE guarded by its trigger
GRANT SELECT, INSERT ON core.sync_operation TO lims_app;
GRANT UPDATE (status, result, error_code, skew_flag) ON core.sync_operation TO lims_app;
GRANT SELECT, INSERT, UPDATE ON core.sync_conflict TO lims_app;

CREATE OR REPLACE TRIGGER sync_conflict__audit AFTER INSERT OR UPDATE OR DELETE ON core.sync_conflict FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
