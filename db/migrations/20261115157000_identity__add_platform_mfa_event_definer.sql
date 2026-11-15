-- AUTH-MFA-COMPLETE-1 (LD-221, founder-approved 2026-11-15 17:10 NPT, AUTH-SENSITIVE LD-189): ONE DEFINER function and ONE additive owner policy so a platform admin who is
-- still aal1 (first enrolment, completeMfaEnrolment) can write the platform_mfa_enrolled audit event (C2 03-APP-FLOW SS7; 05-SCHEMA s4.10 platform_events, s5.4; 08 A25 D-215).
-- Live evidence (staging, 2026-11-15): completeMfaEnrolment 404 x6 and "new row violates row-level security policy for table platform_events" at 16:58:17/21/25 NPT. The handler did a PLAIN
-- INSERT as the system actor: platform_events__insert__platform needs platform claims at aal2 and platform_events__insert__owner_only admits bootstrap_admin_created only -> 42501.
-- 08 A28.1: platform writes before a platform session exists go through DEFINERs (precedent app.identity_bootstrap_platform_admin, app.identity_platform_auth_write_mfa_factor).
-- No table, column, existing policy, grant, trigger, FORCE RLS or existing function changes; EXECUTE for lims_api only; app.pre_user_id is set from p_user_id and reset to '' before returning (08 A12.1).
-- Until C0 transcribes it into C2 05-SCHEMA s4.10 / s5.4 / s10.3 this file is the SQL body of record (see .orchestra/cr/AUTH-MFA-COMPLETE-1.schema.nonblocking.md).
-- NOT RUN in the lane (no psql / docker): db/tests/identity/AUTH-MFA-COMPLETE-1_platform_event.test.sql has to be run against a migrated database.

-- (1) the one additive policy (run as the migration role, before the role switch below)
CREATE POLICY platform_events__insert__owner_mfa_enrolled ON identity.platform_events FOR INSERT TO lims_owner
  WITH CHECK (event_type = 'platform_mfa_enrolled' AND target_type = 'platform_staff' AND target_id = actor_platform_staff_id
    AND EXISTS (SELECT 1 FROM identity.platform_staff s
                 WHERE s.id = target_id AND s.user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid));

-- (2) the one function, owned by lims_owner as in 20261115156000
SET LOCAL ROLE lims_owner;

CREATE FUNCTION app.identity_platform_auth_write_mfa_enrolled_event(p_user_id uuid, p_row jsonb) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
-- accepts ONLY event_type platform_mfa_enrolled, target_type platform_staff, target = actor = the platform_staff row of p_user_id; anything else is refused
DECLARE
  v identity.platform_events%ROWTYPE;
  v_n integer;
BEGIN
  IF p_user_id IS NULL OR p_row IS NULL OR pg_catalog.jsonb_typeof(p_row) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_platform_auth_write_invalid_input';
  END IF;
  v := pg_catalog.jsonb_populate_record(NULL::identity.platform_events, p_row - 'client_ip');   -- client_ip is cast below ('' = none)
  IF v.event_type IS DISTINCT FROM 'platform_mfa_enrolled' OR v.target_type IS DISTINCT FROM 'platform_staff'
     OR v.target_id IS NULL OR v.target_id IS DISTINCT FROM v.actor_platform_staff_id OR v.target_tenant_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_platform_auth_write_invalid_input';
  END IF;
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- platform_events__insert__owner_mfa_enrolled, platform_staff__select__owner_only
  IF NOT EXISTS (SELECT 1 FROM identity.platform_staff s WHERE s.id = v.target_id AND s.user_id = p_user_id) THEN
    PERFORM set_config('app.pre_user_id', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_platform_auth_write_invalid_input';
  END IF;
  INSERT INTO identity.platform_events (id, event_type, target_type, target_id, target_tenant_id, detail, actor_platform_staff_id, request_id, client_ip, created_by)
  VALUES (v.id, v.event_type, v.target_type, v.target_id, NULL, coalesce(v.detail, '{}'), v.actor_platform_staff_id, v.request_id,
          nullif(p_row->>'client_ip', '')::inet, v.created_by);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.pre_user_id', '', true);
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION app.identity_platform_auth_write_mfa_enrolled_event(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.identity_platform_auth_write_mfa_enrolled_event(uuid, jsonb) TO lims_api;
