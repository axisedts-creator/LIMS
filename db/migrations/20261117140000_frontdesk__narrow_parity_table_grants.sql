-- T0B-REGAPI-2 (LD-315 (b), LD-310 (7)). Founder push-cloud step (LD-310 (e)): apply after 20261117110000; not applied to the cloud by this task.
-- (a) DELETE on frontdesk.registration_drafts / frontdesk.favourite_tests stays (user deletable by design) but each table keeps exactly ONE delete policy, bound to the
--     actor tenant AND the owning user (user_id = app.current_membership_id()). The 20261117110000 policies (tenant only) are renamed and narrowed in place (ALTER POLICY,
--     no DROP: gate 9); a fresh database without them gets the narrowed policy created. Privileges: 20261117110000 already gives DELETE on exactly these two tables
--     and nothing wider, so no privilege statement is needed here; reward_points_ledger stays SELECT + INSERT; coupons, icd_codes, custom_field_definitions stay SELECT + INSERT + UPDATE.
-- (b) cancelOrder reverses the insurance claim (LD-310 (7)): insurance_claim_amount_paisa joins the mutable columns of frontdesk.orders, and the lifecycle guard allows it
--     to change ONLY to 0 on the transition to cancelled (never otherwise). The rest of the guard is the 20261105001600 text unchanged.
-- Idempotent: pg_policy checks, CREATE OR REPLACE for the trigger and the function.
-- DOWN (manual): ALTER POLICY ..__delete__owner ON .. USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())) and RENAME back to
--   ..__delete__tenant; re-run the 20261105001600 orders__mutable_columns trigger + orders_lifecycle_guard text.
SET LOCAL ROLE lims_owner;

DO $do$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'frontdesk.registration_drafts'::regclass AND polname = 'registration_drafts__delete__tenant') THEN
    ALTER POLICY registration_drafts__delete__tenant ON frontdesk.registration_drafts RENAME TO registration_drafts__delete__owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'frontdesk.registration_drafts'::regclass AND polname = 'registration_drafts__delete__owner') THEN
    ALTER POLICY registration_drafts__delete__owner ON frontdesk.registration_drafts
      USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND user_id = (SELECT app.current_membership_id()));
  ELSE
    CREATE POLICY registration_drafts__delete__owner ON frontdesk.registration_drafts FOR DELETE TO lims_app
      USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND user_id = (SELECT app.current_membership_id()));
  END IF;
END $do$;

DO $do$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'frontdesk.favourite_tests'::regclass AND polname = 'favourite_tests__delete__tenant') THEN
    ALTER POLICY favourite_tests__delete__tenant ON frontdesk.favourite_tests RENAME TO favourite_tests__delete__owner;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'frontdesk.favourite_tests'::regclass AND polname = 'favourite_tests__delete__owner') THEN
    ALTER POLICY favourite_tests__delete__owner ON frontdesk.favourite_tests
      USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND user_id = (SELECT app.current_membership_id()));
  ELSE
    CREATE POLICY favourite_tests__delete__owner ON frontdesk.favourite_tests FOR DELETE TO lims_app
      USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND user_id = (SELECT app.current_membership_id()));
  END IF;
END $do$;

-- ---------- (b) claim reversal on cancel ----------
CREATE OR REPLACE TRIGGER orders__mutable_columns BEFORE UPDATE ON frontdesk.orders FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
  'status','registered_at','items_version','requires_credit_note','catalog_revision','referrer_id','visit_type','priority',
  'scheduled_at','cancelled_at','cancelled_by','cancel_reason_code','cancel_reason_text','is_active',
  'updated_at','updated_by','version','insurance_claim_amount_paisa');

CREATE OR REPLACE FUNCTION frontdesk.orders_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- status: pre_registered→registered | pre_registered→cancelled | registered→cancelled; nothing out of cancelled
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT coalesce((OLD.status = 'pre_registered' AND NEW.status IN ('registered','cancelled'))
                      OR (OLD.status = 'registered' AND NEW.status = 'cancelled'), false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'frontdesk.orders';
  END IF;
  -- referrer_id / visit_type / priority / scheduled_at / catalog_revision only while OLD.status = 'pre_registered'
  -- (this includes the pre_registered→registered transition, on which catalog_revision is re-stamped)
  IF OLD.status <> 'pre_registered'
     AND (NEW.referrer_id, NEW.visit_type, NEW.priority, NEW.scheduled_at, NEW.catalog_revision)
         IS DISTINCT FROM (OLD.referrer_id, OLD.visit_type, OLD.priority, OLD.scheduled_at, OLD.catalog_revision) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'frontdesk.orders';
  END IF;
  -- cancelled_*: set only on the transition to cancelled, never changed afterwards
  IF (NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason_code, NEW.cancel_reason_text)
     IS DISTINCT FROM (OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason_code, OLD.cancel_reason_text)
     AND NOT (OLD.status <> 'cancelled' AND NEW.status = 'cancelled') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'frontdesk.orders';
  END IF;
  -- T0B-REGAPI-2 (LD-310 (7)): the insurance claim changes only to 0, only on the transition to cancelled
  IF NEW.insurance_claim_amount_paisa IS DISTINCT FROM OLD.insurance_claim_amount_paisa
     AND NOT (OLD.status <> 'cancelled' AND NEW.status = 'cancelled' AND NEW.insurance_claim_amount_paisa = 0) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'frontdesk.orders';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION frontdesk.orders_lifecycle_guard() OWNER TO lims_owner;
