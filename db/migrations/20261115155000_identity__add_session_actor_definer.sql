-- SESSION-ACTOR-1 (LD-208, founder-approved 2026-11-15, AUTH-SENSITIVE LD-189): one ADDITIVE read-only DEFINER that gives the identity
-- service the SessionState.actor of a session (contracts/openapi/identity.yaml: display_name 1-120, roles <= 20, tenant_code optional).
-- No table, column, policy, FORCE RLS, trigger or existing function changes; EXECUTE for lims_api only. Modelled on
-- app.identity_login_context (08 A12.1): sets app.pre_user_id / app.pre_tenant_id, reads through the existing TO lims_owner policies
-- (users__select__owner_only, memberships__select__owner_only, tenants__select__owner_only, roles__select__owner_only,
-- membership_roles__select__owner_only, platform_staff__select__owner_only) and resets both GUCs to '' before returning.
-- Until C0 transcribes it into C2 05-SCHEMA s10.3 this file is the SQL body of record (see .orchestra/cr/SESSION-ACTOR-1.md).
SET LOCAL ROLE lims_owner;

CREATE FUNCTION app.identity_session_actor(p_user_id uuid, p_tenant_id uuid, p_membership_id uuid)
RETURNS TABLE (display_name text, role_codes text[], tenant_code text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);      -- GoTrue sub (08 A12.1)
  PERFORM set_config('app.pre_tenant_id', coalesce(p_tenant_id::text, ''), true);
  IF p_tenant_id IS NULL THEN
    -- platform session: the ACTIVE platform_staff row of the user; tenant_code NULL (never falls back to core.users)
    RETURN QUERY
    SELECT ps.display_name, ARRAY[ps.role_code], NULL::text
      FROM identity.platform_staff ps
     WHERE ps.user_id = p_user_id AND ps.is_active;
  ELSE
    -- tenant / partner / mobile session: user, ACTIVE membership of that user in that tenant, ACTIVE tenant; roles = ACTIVE roles of the membership
    RETURN QUERY
    SELECT u.display_name,
           coalesce(ARRAY(SELECT r.role_code FROM core.membership_roles mr
                          JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.is_active
                          WHERE mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
                          ORDER BY r.role_code LIMIT 20), '{}'::text[]),
           t.tenant_code
      FROM core.users u
      JOIN core.memberships m ON m.tenant_id = u.tenant_id AND m.user_id = u.id AND m.id = p_membership_id AND m.status = 'active'
      JOIN core.tenants t ON t.id = m.tenant_id AND t.status = 'active'
     WHERE u.id = p_user_id AND u.tenant_id = p_tenant_id;
  END IF;
  PERFORM set_config('app.pre_user_id', '', true);
  PERFORM set_config('app.pre_tenant_id', '', true);
  RETURN;
END $$;

REVOKE ALL ON FUNCTION app.identity_session_actor(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.identity_session_actor(uuid, uuid, uuid) TO lims_api;
