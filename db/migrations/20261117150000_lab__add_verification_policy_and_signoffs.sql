-- T0C-VERLEVEL-1 (LD-316; LD-318 follow-up (4); LD-319 (3)/(5); LD-335; founder 2026-11-17 08:39 NPT "verification level 1 2 3"): verification levels 1, 2, 3.
-- Additive only. Level N = the number of DIFFERENT people who must sign off a result version before it is approved (lead interpretation, flagged for the founder audit).
--   lab.verification_policy (per tenant: scope lab | department | test, exactly the matching target set; required_verifiers 1..3; require_pathologist DEFAULT true;
--     allow_enterer_verify DEFAULT false; active). At most one ACTIVE row per tenant and scope target (partial unique index). The most specific active policy wins
--     (test > department > lab): service rule, T0B-VERLEVEL-1. Deactivate with active = false, never delete: lims_app has SELECT, INSERT, UPDATE and no DELETE. Audited.
--     department_id / test_id carry no cross-schema FK (same as lab.results.department_id; the service checks them against catalog).
--   lab.result_signoff (APPEND ONLY sign-off chain per result version: seq 1..3, action verify | approve, signer snapshot taken at signing time:
--     signer_user_id, signer_display_name, signer_role_code, signer_is_pathologist = held lab.result.approve then, signer_registration_no, signer_signature_asset_id).
--     UNIQUE (result_id, result_version, seq) and UNIQUE (result_id, result_version, signer_user_id): one person signs one version once.
--     lims_app has SELECT + INSERT only (no UPDATE, DELETE, TRUNCATE; no UPDATE / DELETE policy). Only rows with signer_is_pathologist print as signatures (PRINTCFG).
--   lab.results gains signoff_required smallint (1..3, NULL until sign-off starts) and signoff_count smallint NOT NULL DEFAULT 0 (0..3).
-- BACKFILL (once per row, never rewrites a row the service already set): every live row with signoff_required IS NULL gets required 2 (the default policy, which
--   reproduces the old two step flow) and count 1 when verified, 2 when approved, 0 otherwise. Cancelled rows are frozen by lab.enforce_result_lock and keep NULL / 0.
--   Legacy approved results get no chain rows (their chain reads empty, count 2). The rows are updated as lims_app under system claims of their own tenant
--   (RLS WITH CHECK and the row audit apply, like seed 010); the result lock trigger is disabled for the backfill only and enabled again in the same transaction.
-- DEFAULT POLICY: every existing tenant gets one active lab scope row (2 / true / false) if it has none; tenants seeded later get it from
--   db/seeds/020_lab__synthetic_verification_policy.sql (dev / ci) or from the service on first read (T0B-VERLEVEL-1).
-- RESULT LOCK: lab.enforce_result_lock is replaced with the same rules plus one: on an approved row signoff_required / signoff_count may change only together with
--   current_version_no (an amendment is signed off again). Nothing else about the lock changes.
-- Idempotent: IF NOT EXISTS everywhere, constraints guarded by pg_constraint, each CREATE POLICY guarded by pg_policy (no DROP), function CREATE OR REPLACE.
-- Cloud apply is a founder step (push-cloud.ps1), after 20261117120000; not done by this task.
-- DOWN (manual, never automatic; destroys sign-off evidence, founder decision, export first):
--   DROP TABLE IF EXISTS lab.result_signoff, lab.verification_policy;
--   ALTER TABLE lab.results DROP COLUMN IF EXISTS signoff_count, DROP COLUMN IF EXISTS signoff_required;
--   and re-create lab.enforce_result_lock() from 20261105001800_lab__create_lab_schema.sql.
SET LOCAL ROLE lims_owner;

-- ---------- verification policy ----------
CREATE TABLE IF NOT EXISTS lab.verification_policy (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  scope text NOT NULL,
  department_id uuid,
  test_id uuid,
  required_verifiers smallint NOT NULL,
  require_pathologist boolean NOT NULL DEFAULT true,
  allow_enterer_verify boolean NOT NULL DEFAULT false,   -- LD-318 follow-up (4): the enterer cannot verify, switchable per policy
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT verification_policy__pk PRIMARY KEY (id),
  CONSTRAINT verification_policy__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT verification_policy__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT verification_policy__scope__ck CHECK (scope IN ('lab','department','test')),
  CONSTRAINT verification_policy__target__ck CHECK (
       (scope = 'lab'        AND department_id IS NULL     AND test_id IS NULL)
    OR (scope = 'department' AND department_id IS NOT NULL AND test_id IS NULL)
    OR (scope = 'test'       AND test_id IS NOT NULL       AND department_id IS NULL)),
  CONSTRAINT verification_policy__required_verifiers__ck CHECK (required_verifiers BETWEEN 1 AND 3),
  CONSTRAINT verification_policy__version__ck CHECK (version >= 1)
);
-- at most one ACTIVE policy per tenant and scope target (NULLS NOT DISTINCT: one lab row per tenant)
CREATE UNIQUE INDEX IF NOT EXISTS verification_policy__tenant_id_target__p_uq ON lab.verification_policy (tenant_id, scope, department_id, test_id) NULLS NOT DISTINCT
  WHERE active;

-- ---------- sign-off chain (append only) ----------
CREATE TABLE IF NOT EXISTS lab.result_signoff (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  result_id uuid NOT NULL,
  result_version integer NOT NULL,                -- lab.results.current_version_no at signing time
  seq smallint NOT NULL,
  action text NOT NULL,
  signer_user_id uuid NOT NULL,
  signer_display_name text NOT NULL,
  signer_role_code text NOT NULL,
  signer_is_pathologist boolean NOT NULL,         -- snapshot: the signer held lab.result.approve at that moment
  signer_registration_no text,
  signer_signature_asset_id uuid,                 -- snapshot reference, no FK (the asset may be replaced later; the row keeps what was used)
  signed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT result_signoff__pk PRIMARY KEY (id),
  CONSTRAINT result_signoff__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT result_signoff__result__fk FOREIGN KEY (tenant_id, result_id) REFERENCES lab.results (tenant_id, id),
  CONSTRAINT result_signoff__result_version_seq__uq UNIQUE (result_id, result_version, seq),
  CONSTRAINT result_signoff__result_version_signer__uq UNIQUE (result_id, result_version, signer_user_id),
  CONSTRAINT result_signoff__result_version__ck CHECK (result_version >= 1),
  CONSTRAINT result_signoff__seq__ck CHECK (seq BETWEEN 1 AND 3),
  CONSTRAINT result_signoff__action__ck CHECK (action IN ('verify','approve')),
  CONSTRAINT result_signoff__display_name__ck CHECK (char_length(signer_display_name) BETWEEN 1 AND 200),
  CONSTRAINT result_signoff__role_code__ck CHECK (char_length(signer_role_code) BETWEEN 1 AND 100),
  CONSTRAINT result_signoff__registration_no__ck CHECK (signer_registration_no IS NULL OR char_length(signer_registration_no) BETWEEN 1 AND 60)
);

-- ---------- lab.results: sign-off counters ----------
ALTER TABLE lab.results ADD COLUMN IF NOT EXISTS signoff_required smallint;
ALTER TABLE lab.results ADD COLUMN IF NOT EXISTS signoff_count smallint NOT NULL DEFAULT 0;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'lab.results'::regclass AND conname = 'results__signoff_required__ck') THEN
  ALTER TABLE lab.results ADD CONSTRAINT results__signoff_required__ck CHECK (signoff_required IS NULL OR signoff_required BETWEEN 1 AND 3);
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'lab.results'::regclass AND conname = 'results__signoff_count__ck') THEN
  ALTER TABLE lab.results ADD CONSTRAINT results__signoff_count__ck CHECK (signoff_count BETWEEN 0 AND 3);
END IF; END $do$;

-- Lock: as 20261105001800 (03-IC §10.2; 04 R1), plus: an approved row may change signoff_required / signoff_count only together with current_version_no (LD-316).
CREATE OR REPLACE FUNCTION lab.enforce_result_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_free text[] := ARRAY['current_version_no','qc_review_required','updated_at','updated_by','version'];
BEGIN
  IF OLD.status = 'approved' THEN
    IF NEW.current_version_no IS DISTINCT FROM OLD.current_version_no THEN
      v_free := v_free || ARRAY['signoff_required','signoff_count'];
    END IF;
    IF NEW.status <> 'approved'
       OR (to_jsonb(OLD) - v_free) IS DISTINCT FROM (to_jsonb(NEW) - v_free) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'lab.results';
    END IF;
  ELSIF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'lab.results';
  END IF;
  IF (OLD.tenant_id, OLD.order_id, OLD.order_item_id, OLD.order_test_id, OLD.patient_id, OLD.test_id, OLD.analyte_id)
     IS DISTINCT FROM (NEW.tenant_id, NEW.order_id, NEW.order_item_id, NEW.order_test_id, NEW.patient_id, NEW.test_id, NEW.analyte_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'lab.results';
  END IF;
  RETURN NEW;
END $$;

-- ---------- RLS, policies, grants ----------
ALTER TABLE lab.verification_policy ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.verification_policy FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'lab.verification_policy'::regclass AND polname = 'verification_policy__select__tenant') THEN
  CREATE POLICY verification_policy__select__tenant ON lab.verification_policy FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'lab.verification_policy'::regclass AND polname = 'verification_policy__insert__tenant') THEN
  CREATE POLICY verification_policy__insert__tenant ON lab.verification_policy FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'lab.verification_policy'::regclass AND polname = 'verification_policy__update__tenant') THEN
  CREATE POLICY verification_policy__update__tenant ON lab.verification_policy FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON lab.verification_policy TO lims_app;

-- append only: SELECT + INSERT policies and grants only (done_when 3)
ALTER TABLE lab.result_signoff ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.result_signoff FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'lab.result_signoff'::regclass AND polname = 'result_signoff__select__tenant') THEN
  CREATE POLICY result_signoff__select__tenant ON lab.result_signoff FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'lab.result_signoff'::regclass AND polname = 'result_signoff__insert__tenant') THEN
  CREATE POLICY result_signoff__insert__tenant ON lab.result_signoff FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
END IF; END $do$;
GRANT SELECT, INSERT ON lab.result_signoff TO lims_app;

-- row audit: the policy says who may sign off (security relevant); the chain itself is append only evidence (no audit trigger, like lab.report_releases)
CREATE OR REPLACE TRIGGER verification_policy__audit AFTER INSERT OR UPDATE OR DELETE ON lab.verification_policy FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- ---------- backfill + default lab policy, per tenant (lims_app under the lab system actor's claims of that tenant) ----------
ALTER TABLE lab.results DISABLE TRIGGER results__lock;   -- the backfill touches approved rows; enabled again below, same transaction
DO $do$
DECLARE
  v_saved text := current_setting('request.jwt.claims', true);
  v_tenants uuid[];
  v_t uuid;
  v_actor constant uuid := '01a1b34e-1004-782c-a681-49b1ce74d717';   -- db/meta/system-actors.yaml: lab
BEGIN
  PERFORM set_config('app.maintenance', 'platform_list_tenants', true);   -- core.tenants__select__owner_only
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_tenants FROM core.tenants;
  PERFORM set_config('app.maintenance', '', true);
  FOREACH v_t IN ARRAY v_tenants LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('tenant_id', v_t, 'sub', v_actor, 'actor_type', 'system')::text, true);
    SET LOCAL ROLE lims_app;
    UPDATE lab.results
       SET signoff_required = 2,
           signoff_count = CASE status WHEN 'verified' THEN 1 WHEN 'approved' THEN 2 ELSE 0 END
     WHERE tenant_id = v_t AND signoff_required IS NULL AND status <> 'cancelled';
    INSERT INTO lab.verification_policy (id, tenant_id, scope, required_verifiers, require_pathologist, allow_enterer_verify, active, updated_by)
    SELECT gen_random_uuid(), v_t, 'lab', 2, true, false, true, v_actor   -- app.uuidv7() is not executable by lims_app
     WHERE NOT EXISTS (SELECT 1 FROM lab.verification_policy p WHERE p.tenant_id = v_t AND p.scope = 'lab' AND p.active)
    ON CONFLICT DO NOTHING;
    SET LOCAL ROLE lims_owner;
  END LOOP;
  PERFORM set_config('request.jwt.claims', coalesce(v_saved, ''), true);
END $do$;
ALTER TABLE lab.results ENABLE TRIGGER results__lock;
