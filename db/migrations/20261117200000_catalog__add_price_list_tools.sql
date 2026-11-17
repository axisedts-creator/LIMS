-- T0C-PRICETOOLS-1 (LD-321, LD-325; founder 2026-11-17 09:18 NPT priority order; ElabAssist "Price Allocation"): price list tools in the catalog.
-- Two NEW tenant tables (history of Excel uploads, never deleted):
--   catalog.price_list_import_batch (one upload: price_list_id, status dry_run | committed | failed | cancelled, row_count 0..5000, error_count, file_ref, file_sha256, summary);
--     lims_app has SELECT, INSERT, UPDATE (status moves dry_run -> committed / cancelled / failed), no DELETE grant and no DELETE policy.
--   catalog.price_list_import_error (batch_id, row_no, column_name, code, message): append only, lims_app has SELECT and INSERT only.
-- catalog.price_list_assignments gains effective_from (NOT NULL DEFAULT now(): an existing row is valid from the apply time, open ended) and effective_to (NULL = open ended),
--   effective_to > effective_from. The old "one row per party" partial unique indexes price_list_assignments__tenant_id_credit_party_id__p_uq,
--   price_list_assignments__tenant_id_doctor_id__p_uq and price_list_assignments__tenant_id_centre_id__p_uq are dropped: a party may now hold one list per period.
--   Label cr-approved-breaking: authority is LD-321 (brief done_when 2 "assignments of one party never overlap in time", which a one-row-per-party unique index forbids);
--   only these three indexes are dropped, no data, no column, no policy; FLAGGED for the lead to confirm (no separate CR file was written).
--   New rule: two assignments of one party (credit party, doctor or centre) never overlap in time, whatever the list. Enforced by a BEFORE INSERT OR UPDATE trigger
--   (btree_gist is not assumed in the pinned image, so no EXCLUDE USING gist); the trigger takes a transaction advisory lock per party so two concurrent writers
--   cannot both pass the check. An overlap raises SQLSTATE 23505 (unique_violation, as the old one-row-per-party index did: 409 catalog.code_duplicate).
-- No data rewrite: no UPDATE / INSERT / DELETE of rows; ADD COLUMN with a stable DEFAULT is metadata only. RLS of price_list_assignments is unchanged (no policy touched).
-- Prices stay in catalog.price_list_items (integer paisa); every tool writes a DRAFT version only, publishing stays publishPriceListVersion (LD-321).
-- Idempotent: IF NOT EXISTS everywhere, extra constraints in DO blocks that check pg_constraint, each CREATE POLICY guarded by pg_policy, functions and triggers CREATE OR REPLACE.
-- Cloud apply is a founder step (push-cloud), after 20261117170000_catalog__test_management_parity.sql; not done by this task.
-- DOWN (manual, never automatic; drops the upload history: founder decision, export first):
--   DROP TABLE IF EXISTS catalog.price_list_import_error, catalog.price_list_import_batch;
--   DROP TRIGGER IF EXISTS price_list_assignments__no_overlap ON catalog.price_list_assignments; DROP FUNCTION IF EXISTS catalog.tg_price_list_assignment_no_overlap();
--   ALTER TABLE catalog.price_list_assignments DROP CONSTRAINT IF EXISTS price_list_assignments__window__ck, DROP COLUMN IF EXISTS effective_to, DROP COLUMN IF EXISTS effective_from;
--   then re-create the three partial unique indexes ONLY after each party holds at most one row (close or delete the extra periods first).
SET LOCAL ROLE lims_owner;

-- ---------- (1) assignments: effective dates and the no-overlap rule (done_when 2) ----------
ALTER TABLE catalog.price_list_assignments
  ADD COLUMN IF NOT EXISTS effective_from timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS effective_to timestamptz;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'catalog.price_list_assignments'::regclass AND conname = 'price_list_assignments__window__ck') THEN
    ALTER TABLE catalog.price_list_assignments ADD CONSTRAINT price_list_assignments__window__ck CHECK (effective_to IS NULL OR effective_to > effective_from);
  END IF;
END $do$;
DROP INDEX IF EXISTS catalog.price_list_assignments__tenant_id_credit_party_id__p_uq;
DROP INDEX IF EXISTS catalog.price_list_assignments__tenant_id_doctor_id__p_uq;
DROP INDEX IF EXISTS catalog.price_list_assignments__tenant_id_centre_id__p_uq;
CREATE INDEX IF NOT EXISTS price_list_assignments__tenant_id_credit_party_id_from__idx ON catalog.price_list_assignments (tenant_id, credit_party_id, effective_from) WHERE credit_party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS price_list_assignments__tenant_id_doctor_id_from__idx ON catalog.price_list_assignments (tenant_id, doctor_id, effective_from) WHERE doctor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS price_list_assignments__tenant_id_centre_id_from__idx ON catalog.price_list_assignments (tenant_id, centre_id, effective_from) WHERE centre_id IS NOT NULL;

CREATE OR REPLACE FUNCTION catalog.tg_price_list_assignment_no_overlap() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $fn$
DECLARE
  v_party uuid := coalesce(NEW.credit_party_id, NEW.doctor_id, NEW.centre_id);
  v_other uuid;
BEGIN
  -- an empty or inverted window is left to price_list_assignments__window__ck (23514); tstzrange would raise 22000 first
  IF NEW.effective_to IS NOT NULL AND NEW.effective_to <= NEW.effective_from THEN
    RETURN NEW;
  END IF;
  -- serialise writers of one party (two concurrent inserts must not both pass the check below)
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog.price_list_assignments:' || NEW.tenant_id::text || ':' || NEW.owner_kind || ':' || v_party::text, 0));
  SELECT a.id INTO v_other
    FROM catalog.price_list_assignments a
   WHERE a.tenant_id = NEW.tenant_id
     AND a.owner_kind = NEW.owner_kind
     AND coalesce(a.credit_party_id, a.doctor_id, a.centre_id) = v_party
     AND a.id <> NEW.id
     AND tstzrange(a.effective_from, a.effective_to, '[)') && tstzrange(NEW.effective_from, NEW.effective_to, '[)')
   LIMIT 1;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'price list assignment overlaps assignment % of the same party', v_other
      USING ERRCODE = '23505', CONSTRAINT = 'price_list_assignments__no_overlap';
  END IF;
  RETURN NEW;
END $fn$;
CREATE OR REPLACE TRIGGER price_list_assignments__no_overlap BEFORE INSERT OR UPDATE ON catalog.price_list_assignments
  FOR EACH ROW EXECUTE FUNCTION catalog.tg_price_list_assignment_no_overlap();

-- ---------- (2) import batches (done_when 2) ----------
CREATE TABLE IF NOT EXISTS catalog.price_list_import_batch (
  id            uuid        NOT NULL,
  tenant_id     uuid        NOT NULL,
  price_list_id uuid        NOT NULL,
  status        text        NOT NULL DEFAULT 'dry_run',
  row_count     integer     NOT NULL,
  error_count   integer     NOT NULL,
  file_ref      text        NOT NULL,
  file_sha256   text        NOT NULL,
  summary       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  result_price_list_version_id uuid,
  version       integer     NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL,
  CONSTRAINT price_list_import_batch__pk PRIMARY KEY (id),
  CONSTRAINT price_list_import_batch__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT price_list_import_batch__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT price_list_import_batch__list__fk FOREIGN KEY (tenant_id, price_list_id) REFERENCES catalog.price_lists (tenant_id, id),
  CONSTRAINT price_list_import_batch__result__fk FOREIGN KEY (tenant_id, result_price_list_version_id) REFERENCES catalog.price_list_versions (tenant_id, id),
  CONSTRAINT price_list_import_batch__status__ck CHECK (status IN ('dry_run','committed','failed','cancelled')),
  CONSTRAINT price_list_import_batch__row_count__ck CHECK (row_count BETWEEN 0 AND 5000),
  CONSTRAINT price_list_import_batch__error_count__ck CHECK (error_count >= 0 AND error_count <= 50000),
  CONSTRAINT price_list_import_batch__file_ref__ck CHECK (char_length(file_ref) BETWEEN 1 AND 512),
  CONSTRAINT price_list_import_batch__sha256__ck CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT price_list_import_batch__summary__ck CHECK (jsonb_typeof(summary) = 'object')
);
CREATE INDEX IF NOT EXISTS price_list_import_batch__tenant_id_price_list_id__idx ON catalog.price_list_import_batch (tenant_id, price_list_id, created_at DESC);

-- ---------- (3) import errors, append only (done_when 2) ----------
CREATE TABLE IF NOT EXISTS catalog.price_list_import_error (
  id          uuid        NOT NULL,
  tenant_id   uuid        NOT NULL,
  batch_id    uuid        NOT NULL,
  row_no      integer     NOT NULL,
  column_name text        NOT NULL,
  code        text        NOT NULL,
  message     text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL,
  CONSTRAINT price_list_import_error__pk PRIMARY KEY (id),
  CONSTRAINT price_list_import_error__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT price_list_import_error__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT price_list_import_error__batch__fk FOREIGN KEY (tenant_id, batch_id) REFERENCES catalog.price_list_import_batch (tenant_id, id),
  CONSTRAINT price_list_import_error__row_no__ck CHECK (row_no >= 1 AND row_no <= 1048576),
  CONSTRAINT price_list_import_error__column__ck CHECK (char_length(column_name) BETWEEN 1 AND 40),
  CONSTRAINT price_list_import_error__code__ck CHECK (char_length(code) BETWEEN 1 AND 64),
  CONSTRAINT price_list_import_error__message__ck CHECK (char_length(message) BETWEEN 1 AND 300)
);
CREATE INDEX IF NOT EXISTS price_list_import_error__tenant_id_batch_id_row_no__idx ON catalog.price_list_import_error (tenant_id, batch_id, row_no);

-- ---------- (4) RLS (tenant, like the neighbouring catalog tables), policies, grants, audit ----------
ALTER TABLE catalog.price_list_import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.price_list_import_batch FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.price_list_import_batch'::regclass AND polname = 'price_list_import_batch__select__tenant') THEN
  CREATE POLICY price_list_import_batch__select__tenant ON catalog.price_list_import_batch FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.price_list_import_batch'::regclass AND polname = 'price_list_import_batch__insert__tenant') THEN
  CREATE POLICY price_list_import_batch__insert__tenant ON catalog.price_list_import_batch FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.price_list_import_batch'::regclass AND polname = 'price_list_import_batch__update__tenant') THEN
  CREATE POLICY price_list_import_batch__update__tenant ON catalog.price_list_import_batch FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON catalog.price_list_import_batch TO lims_app;
CREATE OR REPLACE TRIGGER price_list_import_batch__audit AFTER INSERT OR UPDATE OR DELETE ON catalog.price_list_import_batch FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

ALTER TABLE catalog.price_list_import_error ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog.price_list_import_error FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.price_list_import_error'::regclass AND polname = 'price_list_import_error__select__tenant') THEN
  CREATE POLICY price_list_import_error__select__tenant ON catalog.price_list_import_error FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'catalog.price_list_import_error'::regclass AND polname = 'price_list_import_error__insert__tenant') THEN
  CREATE POLICY price_list_import_error__insert__tenant ON catalog.price_list_import_error FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT ON catalog.price_list_import_error TO lims_app;
