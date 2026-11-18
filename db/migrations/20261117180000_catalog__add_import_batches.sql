-- T0C-TESTIMPORT-1 (LD-318, LD-318 follow-up, LD-335; founder 2026-11-17 08:58 NPT: one Excel workbook with the same fields as the forms, no dirty data).
-- One NEW tenant table, catalog.import_batch: the history of Excel test imports (tests, parameters and reference ranges in one workbook), never deleted.
--   Columns: id, tenant_id, created_by, file_name, file_sha256, template_version, mode (create_only | update), status (validated | rejected | committed | expired),
--   counts (jsonb object: tests, analytes, ranges, panels, errors), errors (jsonb array of at most 1000 {sheet, row, column, code, message}),
--   payload (jsonb object: the normalized JSON of the whole workbook, at most 10 MB as text), created_at, validated_at, committed_at, committed_by, version (If-Match).
--   lims_app has SELECT, INSERT, UPDATE; no DELETE grant and no DELETE policy (history is kept).
-- Append only except the status and commit columns, enforced by a BEFORE UPDATE trigger (so the superuser is held too, not only lims_app):
--   tenant_id, created_by, created_at, file_name, file_sha256, template_version, mode, counts, errors and payload never change;
--   transitions: validated -> committed (needs committed_at and committed_by), validated -> expired, rejected -> expired; nothing else;
--   a committed batch changes nothing at all; a batch whose created_at is older than 24 hours cannot become committed (a database rule, not only a service check).
-- LD-318 decision (flagged for the founder audit): the import never publishes. The commit (T0B-TESTIMPORT-1) creates analyte versions and range sets as DRAFTS only,
--   so the pathologist sign-off (publish permission) still decides what goes live. This table holds no clinical row; it is the evidence of the upload.
-- Audit: app.tg_row_audit('payload', 'errors') (the two large columns are excluded from the audit copy; file_sha256 identifies the upload).
-- No data rewrite: a new table only, no UPDATE / INSERT / DELETE of rows, no existing table, policy or grant changed.
-- Idempotent: IF NOT EXISTS everywhere, each CREATE POLICY guarded by pg_policy, function and trigger CREATE OR REPLACE.
-- Cloud apply is a founder step (push-cloud), after 20261117170000_catalog__test_management_parity.sql; not done by this task.
-- DOWN (manual, never automatic; drops the upload history: founder decision, export first):
--   DROP TABLE IF EXISTS catalog.import_batch; DROP FUNCTION IF EXISTS catalog.tg_import_batch_guard();
SET LOCAL ROLE lims_owner;

CREATE TABLE IF NOT EXISTS catalog.import_batch (
  id               uuid        NOT NULL,
  tenant_id        uuid        NOT NULL,
  created_by       uuid        NOT NULL,
  file_name        text        NOT NULL,
  file_sha256      text        NOT NULL,
  template_version text        NOT NULL,
  mode             text        NOT NULL DEFAULT 'create_only',
  status           text        NOT NULL,
  counts           jsonb       NOT NULL DEFAULT '{"tests":0,"analytes":0,"ranges":0,"panels":0,"errors":0}'::jsonb,
  errors           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  payload          jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  validated_at     timestamptz,
  committed_at     timestamptz,
  committed_by     uuid,
  version          integer     NOT NULL DEFAULT 1,
  CONSTRAINT import_batch__pk PRIMARY KEY (id),
  CONSTRAINT import_batch__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT import_batch__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT import_batch__status__ck CHECK (status IN ('validated','rejected','committed','expired')),
  CONSTRAINT import_batch__mode__ck CHECK (mode IN ('create_only','update')),
  CONSTRAINT import_batch__sha256__ck CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT import_batch__file_name__ck CHECK (char_length(file_name) BETWEEN 1 AND 255),
  CONSTRAINT import_batch__template_version__ck CHECK (char_length(template_version) BETWEEN 1 AND 20),
  CONSTRAINT import_batch__counts__ck CHECK (jsonb_typeof(counts) = 'object' AND counts ?& ARRAY['tests','analytes','ranges','panels','errors']),
  CONSTRAINT import_batch__errors__ck CHECK (CASE WHEN jsonb_typeof(errors) = 'array' THEN jsonb_array_length(errors) <= 1000 ELSE false END),
  CONSTRAINT import_batch__payload__ck CHECK (CASE WHEN jsonb_typeof(payload) = 'object' THEN octet_length(payload::text) <= 10485760 ELSE false END),
  CONSTRAINT import_batch__committed__ck CHECK (status <> 'committed' OR (committed_at IS NOT NULL AND committed_by IS NOT NULL)),
  CONSTRAINT import_batch__version__ck CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS import_batch__tenant_id_created_at__idx ON catalog.import_batch (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS import_batch__tenant_id_status__idx ON catalog.import_batch (tenant_id, status, created_at DESC);

-- append only except status and the commit columns; committed is final; the 24 hours rule
CREATE OR REPLACE FUNCTION catalog.tg_import_batch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $fn$
BEGIN
  IF OLD.status = 'committed' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'import batch % is already committed and cannot be changed', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'import_batch__committed_final';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.created_by, NEW.created_at, NEW.file_name, NEW.file_sha256, NEW.template_version, NEW.mode, NEW.counts, NEW.errors, NEW.payload)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.created_by, OLD.created_at, OLD.file_name, OLD.file_sha256, OLD.template_version, OLD.mode, OLD.counts, OLD.errors, OLD.payload) THEN
    RAISE EXCEPTION 'import batch %: only status, validated_at, committed_at, committed_by and version may change', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'import_batch__append_only';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'validated' AND NEW.status IN ('committed','expired'))
    OR (OLD.status = 'rejected' AND NEW.status = 'expired')) THEN
    RAISE EXCEPTION 'import batch %: status % cannot become %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'import_batch__transition';
  END IF;
  IF NEW.status = 'committed' AND OLD.created_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'import batch % is older than 24 hours and cannot be committed', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'import_batch__expired';
  END IF;
  RETURN NEW;
END $fn$;
CREATE OR REPLACE TRIGGER import_batch__guard BEFORE UPDATE ON catalog.import_batch
  FOR EACH ROW EXECUTE FUNCTION catalog.tg_import_batch_guard();

-- RLS (tenant, like the neighbouring catalog tables), policies, grants, audit
ALTER TABLE catalog.import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.import_batch FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.import_batch'::regclass AND polname = 'import_batch__select__tenant') THEN
  CREATE POLICY import_batch__select__tenant ON catalog.import_batch FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.import_batch'::regclass AND polname = 'import_batch__insert__tenant') THEN
  CREATE POLICY import_batch__insert__tenant ON catalog.import_batch FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.import_batch'::regclass AND polname = 'import_batch__update__tenant') THEN
  CREATE POLICY import_batch__update__tenant ON catalog.import_batch FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON catalog.import_batch TO lims_app;
CREATE OR REPLACE TRIGGER import_batch__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.import_batch FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit('payload', 'errors');
