-- T0B-02: helpers stage (05-SCHEMA §4.5 stage 3; DDL verbatim from 05-SCHEMA §10; 08 A15.6, A20.2, A30.1).
-- Created before every policy or function that references these helpers. EXECUTE on the CV §5.8 context helpers is granted in
-- the "app helper grants" block of the core stage (05-SCHEMA §10), together with app.has_all_centres / app.current_centre_ids.
SET LOCAL ROLE lims_owner;

-- ===================================================================== app: context helpers (CV §5.8)
CREATE FUNCTION app.current_claims() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
CREATE FUNCTION app.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(app.current_claims() ->> 'tenant_id', '')::uuid
$$;
CREATE FUNCTION app.current_actor_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(app.current_claims() ->> 'sub', '')::uuid
$$;
CREATE FUNCTION app.current_actor_type() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT app.current_claims() ->> 'actor_type'
$$;
CREATE FUNCTION app.current_membership_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid
$$;
CREATE FUNCTION app.is_staff_or_system() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(app.current_actor_type() IN ('user','system','device'), false)
$$;   -- every __tenant policy has it (08 A17 P-16, A23.3); shared_with tables add separate actor policies (05-SCHEMA §6)
-- C0-owned since 08 A20.2 (moved from C2 with app.is_platform_actor()); C2 05-SCHEMA §5.1 references it and keeps its tests.
CREATE FUNCTION app.current_lims_session_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(app.current_claims() ->> 'lims_session_id', '')::uuid
$$;
GRANT EXECUTE ON FUNCTION app.current_lims_session_id() TO lims_app, lims_api, lims_worker;   -- 08 A20.2 (as listed there)

-- Platform-context predicate (CR-C2-004). C0-owned (08 A15.6). It reads identity.platform_staff, which the identity migration
-- creates later in the DAG, so this one statement is created with check_function_bodies off; the body is resolved at its first
-- call. Under FORCE RLS it reads through platform_staff__select__owner_only (C2 05-SCHEMA §5.4, 08 A10.5).
-- Contract tests: C2 05-SCHEMA §11 test 21 (T0B-06); grants and creation order: 05-SCHEMA §10 schema test 21.
SET LOCAL check_function_bodies = off;
CREATE FUNCTION app.is_platform_actor() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(
    (app.current_claims() ->> 'scope') = 'platform'
    AND (app.current_claims() ->> 'aal') = 'aal2'
    AND EXISTS (SELECT 1 FROM identity.platform_staff ps
                WHERE ps.id = nullif(app.current_claims() ->> 'platform_staff_id', '')::uuid
                  AND ps.user_id = app.current_actor_id()
                  AND ps.is_active), false)
$$;
SET LOCAL check_function_bodies = on;
REVOKE ALL ON FUNCTION app.is_platform_actor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_platform_actor() TO lims_app;   -- 05-SCHEMA §4.3 inventory: lims_app (lims_api, lims_worker are members)

-- Module policy helpers (08 A30.1; 05-SCHEMA §4.5). Bodies verbatim from C13 05-SCHEMA (app.current_partner_id) and
-- C16 05-SCHEMA §6.1 (the four app.engagement_* helpers); they read module tables, so check_function_bodies is off.
-- The owning modules' migrations use CREATE OR REPLACE with the same text.
SET LOCAL check_function_bodies = off;
CREATE FUNCTION app.current_partner_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN app.current_actor_type() = 'partner' THEN (
    SELECT pu.partner_id
    FROM partners.partner_users pu
    JOIN partners.partners p ON p.tenant_id = pu.tenant_id AND p.id = pu.partner_id
    WHERE pu.tenant_id = app.current_tenant_id()
      AND pu.membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
      AND pu.status IN ('invited','active')
      AND p.status = 'active') END
$$;
CREATE FUNCTION app.engagement_preauth_stage() RETURNS text LANGUAGE sql STABLE AS $$   -- INVOKER (no table read)
  SELECT app.current_claims() ->> 'patient_stage'
$$;
CREATE FUNCTION app.engagement_account_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN app.current_actor_type() = 'patient' AND app.engagement_preauth_stage() IS NULL THEN (
    SELECT a.id FROM engagement.accounts a
    JOIN core.memberships m ON m.tenant_id = a.tenant_id AND m.id = a.membership_id
    WHERE a.tenant_id = app.current_tenant_id()
      AND a.membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
      AND a.status = 'active' AND m.actor_type = 'patient' AND m.is_active) END
$$;
CREATE FUNCTION app.engagement_patient_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(array_agg(l.patient_id), '{}') FROM engagement.account_patient_links l
  WHERE l.tenant_id = app.current_tenant_id() AND l.account_id = app.engagement_account_id() AND l.status = 'active'
$$;
CREATE FUNCTION app.engagement_patient_visible(p_patient_id uuid, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM engagement.account_patient_links l
    WHERE l.tenant_id = app.current_tenant_id() AND l.account_id = app.engagement_account_id()
      AND l.patient_id = p_patient_id AND l.status = 'active'
      AND (l.visible_from IS NULL OR p_at >= l.visible_from))
$$;
SET LOCAL check_function_bodies = on;
REVOKE ALL ON FUNCTION app.current_partner_id(), app.engagement_preauth_stage(), app.engagement_account_id(),
  app.engagement_patient_ids(), app.engagement_patient_visible(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_partner_id(), app.engagement_preauth_stage(), app.engagement_account_id(),
  app.engagement_patient_ids(), app.engagement_patient_visible(uuid, timestamptz) TO lims_app;   -- 05-SCHEMA §4.3 (C16 §6.1: EXECUTE lims_app)

-- RFC 9562 UUIDv7 for trigger-side ids only (04 D9). App code uses @lims/shared-ts/uuidv7.
CREATE FUNCTION app.uuidv7() RETURNS uuid LANGUAGE sql VOLATILE AS $$
  SELECT encode(
           set_bit(set_bit(
             overlay(uuid_send(gen_random_uuid())
                     PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                     FROM 1 FOR 6),
           52, 1), 53, 1),
         'hex')::uuid
$$;
-- golden test: output matches IC §2.1 Uuidv7 regex; timestamp prefix within +-5 ms of clock_timestamp()
