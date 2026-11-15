-- AUTH-PLATFORM-SESSION-1 (LD-216, founder-approved 2026-11-15, AUTH-SENSITIVE LD-189): two ADDITIVE read-only DEFINER functions so the
-- platform admin can read back the platform session and the tenant-less MFA factors in identityAuthTx (system claims, no tenant, no scope).
-- Live evidence: loginStaff 200 then startMfaEnrolment 401 auth.session_expired in 15-17 ms: a plain SELECT on identity.sessions finds no row
-- because the owner-only policies (TO lims_owner, app.pre_user_id) are reachable only through a DEFINER (C2 05-SCHEMA s5.4; 08 A12.1, A28.1).
-- No table, column, policy, FORCE RLS, trigger, existing function or table grant changes; EXECUTE for lims_api only. Modelled on
-- app.identity_platform_auth_write_session_update / _write_mfa_factor (20261105000800). Reads through sessions__select__owner_only,
-- platform_staff__select__owner_only and mfa_factors__select__owner_only; GUCs reset to '' before returning.
-- Until C0 transcribes it into C2 05-SCHEMA s5.4 / s6 / s10.3 this file is the SQL body of record (see .orchestra/cr/AUTH-PLATFORM-SESSION-1.md).
SET LOCAL ROLE lims_owner;

CREATE FUNCTION app.identity_platform_auth_load_session(p_user_id uuid, p_session_id uuid)
RETURNS TABLE (aal text, access_token_enc bytea, refresh_token_enc bytea, enc_key_id text, mfa_failed_attempts integer,
               access_expires_at timestamptz, idle_expires_at timestamptz, absolute_expires_at timestamptz, email text, state text,
               last_seen_at timestamptz, idle_timeout_minutes integer, app_instance_id uuid, app_platform text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- sessions__select__owner_only, platform_staff__select__owner_only
  -- row lock (FOR UPDATE OF s) exactly as the tenant LOAD_SQL: parallel codes stay serialised; e-mail of the same user's platform_staff row
  RETURN QUERY
  SELECT s.aal, s.access_token_enc, s.refresh_token_enc, s.enc_key_id, s.mfa_failed_attempts, s.access_expires_at,
         s.idle_expires_at, s.absolute_expires_at, p.email_normalized, s.state, s.last_seen_at, s.idle_timeout_minutes,
         s.app_instance_id, s.app_platform
    FROM identity.sessions s
    LEFT JOIN identity.platform_staff p ON p.id = s.platform_staff_id AND p.user_id = p_user_id
   WHERE s.id = p_session_id AND s.user_id = p_user_id AND s.kind = 'platform' AND s.tenant_id IS NULL
     FOR UPDATE OF s;
  PERFORM set_config('app.pre_user_id', '', true);
  RETURN;
END $$;

CREATE FUNCTION app.identity_platform_auth_read_mfa_factors(p_user_id uuid)
RETURNS TABLE (id uuid, gotrue_factor_id uuid, status text, verified_at timestamptz, friendly_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- mfa_factors__select__owner_only
  PERFORM set_config('app.pre_tenant_id', '', true);                             -- tenant-less factors only (A15.2 select branch)
  RETURN QUERY
  SELECT f.id, f.gotrue_factor_id, f.status, f.verified_at, f.friendly_name
    FROM identity.mfa_factors f
   WHERE f.tenant_id IS NULL AND f.user_id = p_user_id AND f.status <> 'removed';
  PERFORM set_config('app.pre_user_id', '', true);
  PERFORM set_config('app.pre_tenant_id', '', true);
  RETURN;
END $$;

REVOKE ALL ON FUNCTION app.identity_platform_auth_load_session(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.identity_platform_auth_read_mfa_factors(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.identity_platform_auth_load_session(uuid, uuid) TO lims_api;
GRANT EXECUTE ON FUNCTION app.identity_platform_auth_read_mfa_factors(uuid) TO lims_api;
