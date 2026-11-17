-- T0B-06: identity SECURITY DEFINER inventory (C0 05-SCHEMA §4.3 rows for C2); text verbatim from C2 05-SCHEMA §10.3
-- (08 A12.1, A12.2, A12.6, A15.1-A15.3, A20.1, A28.1, A28.4). The identity.* tables and their TO lims_owner policies
-- (C2 §5.4 / §10.1) are C2 DDL of a later stage, hence check_function_bodies = off.
-- app.identity_is_breached / app.identity_tenants_for_email_hmacs are not created here (T0B-05 / C2).
SET LOCAL ROLE lims_owner;
SET LOCAL check_function_bodies = off;

-- Pre-tenant lookups (08 A12.1). Each sets the transaction-local app.pre_* GUCs with set_config(name, value, true) before each
-- read, so the TO lims_owner policies of §5.4 / §10.1 / C0 §10 admit exactly the looked-up rows, and resets every GUC it set to ''
-- before returning. VOLATILE because set_config changes session state.
CREATE FUNCTION app.identity_resolve_session(p_gotrue_session_id uuid, p_sub uuid)
RETURNS TABLE (session_id uuid, kind text, state text, session_aal text, tenant_id uuid, tenant_status text,
               membership_id uuid, membership_status text, membership_locked boolean,   -- = m.locked_at IS NOT NULL (08 A3.4)
               partner_role text,                                                       -- = m.partner_role (08 A28.3; claims partner_role)
               platform_staff_id uuid, platform_role text, platform_allowed_cidrs cidr[],
               support_session_id uuid, support_tenant_id uuid, support_tenant_status text, support_scope text,
               support_expires_at timestamptz, idle_expires_at timestamptz, absolute_expires_at timestamptz,
               revoked_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_tenant_id          uuid;
  v_support_session_id uuid;
  v_support_tenant_id  uuid;
BEGIN
  PERFORM set_config('app.pre_gotrue_session_id', coalesce(p_gotrue_session_id::text, ''), true);   -- sessions__select__owner_only
  PERFORM set_config('app.pre_user_id', coalesce(p_sub::text, ''), true);                           -- memberships__select__owner_only
  SELECT s.tenant_id, s.support_session_id INTO v_tenant_id, v_support_session_id
    FROM identity.sessions s
   WHERE s.gotrue_session_id = p_gotrue_session_id AND s.user_id = p_sub;
  -- a platform session has tenant_id NULL; its support session is admitted by its id (support_sessions__select__owner_only, 08 A15.1)
  PERFORM set_config('app.pre_support_session_id', coalesce(v_support_session_id::text, ''), true);
  IF v_tenant_id IS NULL AND v_support_session_id IS NOT NULL THEN
    -- 08 A20.1: the active, unexpired support session names the tenant whose status is support_tenant_status
    SELECT ss.tenant_id INTO v_support_tenant_id
      FROM identity.support_sessions ss
     WHERE ss.id = v_support_session_id AND ss.status = 'active' AND ss.expires_at > now();
  END IF;
  -- the session's tenant (tenant kinds; 08 A12.1) or the support tenant (platform kind; 08 A20.1) admits core.tenants and
  -- identity.support_sessions; '' when there is none
  PERFORM set_config('app.pre_tenant_id', coalesce(v_tenant_id::text, v_support_tenant_id::text, ''), true);
  RETURN QUERY
  SELECT s.id, s.kind, s.state, s.aal, s.tenant_id, t.status,
         s.membership_id, m.status, (m.locked_at IS NOT NULL), m.partner_role,
         s.platform_staff_id, ps.role_code, ps.allowed_cidrs,
         ss.id, ss.tenant_id, st.status, ss.scope, ss.expires_at,
         s.idle_expires_at, s.absolute_expires_at, s.revoked_at
  FROM identity.sessions s
  LEFT JOIN core.tenants t            ON t.id = s.tenant_id
  LEFT JOIN core.memberships m        ON m.tenant_id = s.tenant_id AND m.id = s.membership_id
  LEFT JOIN identity.platform_staff ps ON ps.id = s.platform_staff_id AND ps.is_active
  LEFT JOIN identity.support_sessions ss ON ss.id = s.support_session_id AND ss.status = 'active' AND ss.expires_at > now()
  LEFT JOIN core.tenants st           ON st.id = ss.tenant_id
  WHERE s.gotrue_session_id = p_gotrue_session_id AND s.user_id = p_sub;
  PERFORM set_config('app.pre_gotrue_session_id', '', true);
  PERFORM set_config('app.pre_user_id', '', true);
  PERFORM set_config('app.pre_tenant_id', '', true);
  PERFORM set_config('app.pre_support_session_id', '', true);
  RETURN;
END $$;

CREATE FUNCTION app.identity_session_by_token(p_token_sha256 bytea)
RETURNS TABLE (session_id uuid, kind text, state text, tenant_id uuid, user_id uuid, membership_id uuid,
               platform_staff_id uuid, support_session_id uuid, token_reused boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  PERFORM set_config('app.pre_session_token_sha256', coalesce(encode(p_token_sha256, 'hex'), ''), true);   -- 08 A12.1
  RETURN QUERY
  SELECT s.id, s.kind, s.state, s.tenant_id, s.user_id, s.membership_id, s.platform_staff_id, s.support_session_id, false
  FROM identity.sessions s
  WHERE s.token_sha256 = p_token_sha256 AND s.state NOT IN ('revoked','expired')
  UNION ALL
  -- CR-C2-018 (08 Addendum A3.1): rotated-out app token presented again. The caller (identity auth service) revokes the
  -- session (revoke_reason 'token_reuse') and writes auth event 'session_token_reused' in the same transaction.
  SELECT s.id, s.kind, s.state, s.tenant_id, s.user_id, s.membership_id, s.platform_staff_id, s.support_session_id, true
  FROM identity.sessions s
  WHERE s.previous_token_sha256 = p_token_sha256 AND s.state NOT IN ('revoked','expired');
  PERFORM set_config('app.pre_session_token_sha256', '', true);
  RETURN;
END $$;

CREATE FUNCTION app.identity_login_context(p_user_id uuid)
RETURNS TABLE (platform_staff_id uuid, platform_role text, platform_active boolean, platform_allowed_cidrs cidr[],
               membership_count integer, tenant_id uuid, tenant_status text, membership_id uuid,
               membership_status text, membership_locked boolean, mfa_required boolean, has_verified_factor boolean,   -- membership_locked = locked_at IS NOT NULL (08 A3.4)
               idle_timeout_minutes integer, absolute_session_hours integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_count integer;
  v_one   core.memberships%ROWTYPE;
BEGIN
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- p_user_id = GoTrue sub (08 A12.1)
  -- 08 A6.6: only status = 'active' AND actor_type = 'user' count; deactivated never trigger identity_multi_membership
  SELECT count(*)::int INTO v_count
    FROM core.memberships m WHERE m.user_id = p_user_id AND m.actor_type = 'user' AND m.status = 'active';
  -- 08 A8.1: the active membership (at most one, R27/A3.4); if none is active, the most recently updated one
  SELECT m.* INTO v_one
    FROM core.memberships m WHERE m.user_id = p_user_id AND m.actor_type = 'user'
   ORDER BY (m.status = 'active') DESC, m.updated_at DESC LIMIT 1;
  -- set after the membership is chosen (08 A12.1); '' when the user has no user membership (platform staff only)
  PERFORM set_config('app.pre_tenant_id', coalesce(v_one.tenant_id::text, ''), true);
  RETURN QUERY
  SELECT ps.id, ps.role_code, ps.is_active, ps.allowed_cidrs,
         v_count,
         v_one.tenant_id, t.status, v_one.id, v_one.status, (v_one.locked_at IS NOT NULL),
         coalesce(ps.id IS NOT NULL, false) OR coalesce((
           SELECT bool_or(r.mfa_required) FROM core.membership_roles mr
           JOIN core.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.is_active
           WHERE mr.tenant_id = v_one.tenant_id AND mr.membership_id = v_one.id), false),
         -- with no membership (platform staff) v_one.tenant_id is NULL and the tenant-less factors are admitted (08 A15.2)
         EXISTS (SELECT 1 FROM identity.mfa_factors f WHERE f.user_id = p_user_id AND f.status = 'verified'
                 AND f.tenant_id IS NOT DISTINCT FROM v_one.tenant_id),
         ts.idle_timeout_minutes, ts.absolute_session_hours
  FROM (SELECT 1) x
  LEFT JOIN core.tenants t ON t.id = v_one.tenant_id
  LEFT JOIN identity.tenant_settings ts ON ts.tenant_id = v_one.tenant_id
  LEFT JOIN identity.platform_staff ps ON ps.user_id = p_user_id;
  PERFORM set_config('app.pre_user_id', '', true);
  PERFORM set_config('app.pre_tenant_id', '', true);
  RETURN;
END $$;

CREATE FUNCTION app.identity_user_exists(p_user_id uuid) RETURNS boolean   -- p_user_id = GoTrue user id (sub), 08 A12.1
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_exists boolean;
BEGIN
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- users__select__owner_only (C0)
  v_exists := EXISTS (SELECT 1 FROM core.users u WHERE u.id = p_user_id)
           OR EXISTS (SELECT 1 FROM identity.platform_staff ps WHERE ps.user_id = p_user_id);
  PERFORM set_config('app.pre_user_id', '', true);
  RETURN v_exists;
END $$;

CREATE FUNCTION app.identity_record_auth_event(p jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p ? 'tenant_id' AND (p ->> 'tenant_id') IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'tenant_events_use_rls_path';
  END IF;
  INSERT INTO identity.auth_events (id, tenant_id, user_id, platform_staff_id, session_id, event_type, reason_code,
                                    email_hmac, client_ip, user_agent, request_id, occurred_at, created_by)
  VALUES ((p ->> 'id')::uuid, NULL, nullif(p ->> 'user_id','')::uuid, nullif(p ->> 'platform_staff_id','')::uuid,
          nullif(p ->> 'session_id','')::uuid, p ->> 'event_type', p ->> 'reason_code',
          decode(nullif(p ->> 'email_hmac_hex',''), 'hex'), nullif(p ->> 'client_ip','')::inet,
          left(p ->> 'user_agent', 512), nullif(p ->> 'request_id','')::uuid, now(), (p ->> 'created_by')::uuid);
END $$;

CREATE FUNCTION app.identity_bootstrap_platform_admin(p_staff_id uuid, p_user_id uuid, p_email text,
                                                     p_display_name text, p_event_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('identity_bootstrap_platform_admin'));
  IF EXISTS (SELECT 1 FROM identity.platform_staff WHERE role_code = 'platform_superadmin' AND is_active) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'bootstrap_closed';
  END IF;
  INSERT INTO identity.platform_staff (id, user_id, email_normalized, display_name, role_code, created_by, updated_by)
  VALUES (p_staff_id, p_user_id, lower(btrim(p_email)), p_display_name, 'platform_superadmin', p_user_id, p_user_id);
  INSERT INTO identity.platform_events (id, event_type, target_type, target_id, created_by)
  VALUES (p_event_id, 'bootstrap_admin_created', 'platform_staff', p_staff_id, p_user_id);
END $$;

CREATE FUNCTION app.identity_purge_sessions() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_n integer;
BEGIN
  -- 08 A15.3: admits sessions__{select,delete}__owner_only and admin_notices__{select,delete}__owner_only; reset before return
  PERFORM set_config('app.maintenance', 'identity_purge_sessions', true);
  WITH d AS (DELETE FROM identity.sessions WHERE expires_at < now() RETURNING 1),
       n AS (DELETE FROM identity.admin_notices WHERE expires_at < now() RETURNING 1)
  SELECT (SELECT count(*) FROM d)::int + (SELECT count(*) FROM n)::int INTO v_n;
  PERFORM set_config('app.maintenance', '', true);
  RETURN v_n;
END $$;
CREATE FUNCTION app.identity_expire_support_sessions() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_n integer;
BEGIN
  -- 08 A15.3: admits support_sessions__{select,update}__owner_only (maintenance branch); reset before return
  PERFORM set_config('app.maintenance', 'identity_expire_support_sessions', true);
  WITH u AS (
    UPDATE identity.support_sessions SET status = 'expired', end_reason = 'expired', ended_at = now(),
           updated_at = now(), version = version + 1
    WHERE (status = 'requested' AND requested_at < now() - interval '24 hours')
       OR (status = 'approved'  AND decided_at   < now() - interval '60 minutes')
       OR (status = 'active'    AND expires_at   <= now())
    RETURNING id)
  SELECT count(*)::int INTO v_n FROM u;
  PERFORM set_config('app.maintenance', '', true);
  RETURN v_n;
END $$;
CREATE FUNCTION app.identity_expire_invitations() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_n integer;
BEGIN
  -- 08 A15.3: admits invitations__{select,update}__owner_only; reset before return.
  -- 08 A12.6: one UPDATE (no two CTEs updating the same table). <e> expire pending/sent past expires_at; <r> clear email
  -- 30 days after a terminal state. The branches are disjoint (non-terminal vs terminal status); SET expressions read the old row.
  PERFORM set_config('app.maintenance', 'identity_expire_invitations', true);
  WITH u AS (
    UPDATE identity.invitations
       SET status     = CASE WHEN status IN ('pending','sent') AND expires_at < now() THEN 'expired' ELSE status END,
           email      = CASE WHEN email IS NOT NULL AND status IN ('accepted','expired','revoked','failed')
                                  AND updated_at < now() - interval '30 days' THEN NULL ELSE email END,
           updated_at = now(), version = version + 1
     WHERE (status IN ('pending','sent') AND expires_at < now())                                                         -- <e>
        OR (email IS NOT NULL AND status IN ('accepted','expired','revoked','failed') AND updated_at < now() - interval '30 days')   -- <r>
    RETURNING 1)
  SELECT count(*)::int INTO v_n FROM u;
  PERFORM set_config('app.maintenance', '', true);
  RETURN v_n;
END $$;
CREATE FUNCTION app.identity_expire_audit_exports() RETURNS TABLE (object_path text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  -- 08 A15.3: admits audit_exports__{select,update}__owner_only; reset before return
  PERFORM set_config('app.maintenance', 'identity_expire_audit_exports', true);
  RETURN QUERY
  UPDATE identity.audit_exports SET status = 'expired', updated_at = now(), version = version + 1
  WHERE status = 'ready' AND (expires_at <= now() OR downloads_remaining = 0)
  RETURNING identity.audit_exports.object_path;
  -- class E retention (§9; 08 A17 P-18(c)): rows that ended more than 1 year ago; their objects were deleted at expiry
  DELETE FROM identity.audit_exports
   WHERE status IN ('expired','failed') AND created_at < now() - interval '1 year';
  PERFORM set_config('app.maintenance', '', true);
  RETURN;
END $$;
CREATE FUNCTION app.identity_purge_auth_events() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_n integer;
BEGIN
  -- 08 A12.2: admits tenant_settings__select__owner_only and auth_events__{select,delete}__owner_only; reset before return
  PERFORM set_config('app.maintenance', 'identity_purge_auth_events', true);
  WITH d AS (
    DELETE FROM identity.auth_events e
    USING (SELECT tenant_id, retention_audit_years FROM identity.tenant_settings) ts
    WHERE e.tenant_id = ts.tenant_id AND e.occurred_at < now() - make_interval(years => ts.retention_audit_years)
    RETURNING 1),
  p AS (DELETE FROM identity.auth_events WHERE tenant_id IS NULL AND occurred_at < now() - interval '5 years' RETURNING 1)
  SELECT (SELECT count(*) FROM d)::int + (SELECT count(*) FROM p)::int INTO v_n;
  PERFORM set_config('app.maintenance', '', true);
  RETURN v_n;
END $$;
CREATE FUNCTION app.identity_load_breached_batch(p_hashes bytea[], p_version text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH i AS (INSERT INTO identity.g_breached_passwords (sha1, list_version)
             SELECT h, p_version FROM unnest(p_hashes) h WHERE octet_length(h) = 20
             ON CONFLICT (sha1) DO UPDATE SET list_version = EXCLUDED.list_version RETURNING 1)
  SELECT count(*)::int FROM i
$$;
-- after the final batch the task calls: DELETE of rows with list_version <> current via
CREATE FUNCTION app.identity_finish_breached_import(p_version text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH d AS (DELETE FROM identity.g_breached_passwords WHERE list_version <> p_version RETURNING 1) SELECT count(*)::int FROM d
$$;
REVOKE ALL ON FUNCTION app.identity_resolve_session(uuid,uuid), app.identity_session_by_token(bytea),
  app.identity_login_context(uuid), app.identity_user_exists(uuid), app.identity_record_auth_event(jsonb),
  app.identity_bootstrap_platform_admin(uuid,uuid,text,text,uuid),
  app.identity_purge_sessions(), app.identity_expire_support_sessions(), app.identity_expire_invitations(),
  app.identity_expire_audit_exports(), app.identity_purge_auth_events(),
  app.identity_load_breached_batch(bytea[],text), app.identity_finish_breached_import(text) FROM PUBLIC;
-- 08 A28.1 — platform-staff writes during authentication (before a platform session exists). Called by the identity auth service
-- inside ctx.db.identityAuthTx (claims: identity system actor, no tenant) after app.identity_login_context /
-- app.identity_session_by_token identified the platform staff user. Each sets app.pre_user_id = p_user_id before its write; the
-- owner policies match tenant_id IS NULL AND user_id = app.pre_user_id (A12.1 pattern) and the GUC is reset before return.
-- Unknown keys or a non-platform target → P0001 identity_platform_auth_write_invalid_input [CONV].
CREATE FUNCTION app.identity_platform_auth_write_session_insert(p_user_id uuid, p_row jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v identity.sessions%ROWTYPE;
BEGIN
  v := jsonb_populate_record(NULL::identity.sessions, p_row);
  IF v.kind IS DISTINCT FROM 'platform' OR v.tenant_id IS NOT NULL OR v.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_platform_auth_write_invalid_input';
  END IF;
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- sessions__insert__owner_only
  INSERT INTO identity.sessions SELECT v.*;
  PERFORM set_config('app.pre_user_id', '', true);
END $$;

CREATE FUNCTION app.identity_platform_auth_write_session_update(p_user_id uuid, p_session_id uuid, p_set jsonb) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v identity.sessions%ROWTYPE;
  v_n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_set) k WHERE k NOT IN ('state','aal','refresh_token_enc','access_token_enc','enc_key_id',
       'access_expires_at','last_seen_at','idle_expires_at','mfa_failed_attempts','support_session_id','revoked_at','revoked_by',
       'revoke_reason','updated_by')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_platform_auth_write_invalid_input';
  END IF;
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- sessions__{select,update}__owner_only
  SELECT * INTO v FROM identity.sessions s
   WHERE s.id = p_session_id AND s.user_id = p_user_id AND s.kind = 'platform' AND s.tenant_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.pre_user_id', '', true);
    RETURN 0;
  END IF;
  v := jsonb_populate_record(v, p_set);
  UPDATE identity.sessions s
     SET state = v.state, aal = v.aal, refresh_token_enc = v.refresh_token_enc, access_token_enc = v.access_token_enc,
         enc_key_id = v.enc_key_id, access_expires_at = v.access_expires_at, last_seen_at = v.last_seen_at,
         idle_expires_at = v.idle_expires_at, mfa_failed_attempts = v.mfa_failed_attempts, support_session_id = v.support_session_id,
         revoked_at = v.revoked_at, revoked_by = v.revoked_by, revoke_reason = v.revoke_reason, updated_by = v.updated_by,
         updated_at = now(), version = s.version + 1
   WHERE s.id = p_session_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.pre_user_id', '', true);
  RETURN v_n;
END $$;

CREATE FUNCTION app.identity_platform_auth_write_mfa_factor(p_user_id uuid, p_factor_id uuid, p_row jsonb) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
-- p_factor_id NULL → insert p_row (startMfaEnrolment); else update the factor's status columns (completeMfaEnrolment, re-enrol)
DECLARE
  v identity.mfa_factors%ROWTYPE;
  v_n integer;
BEGIN
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- mfa_factors__{select,insert,update}__owner_only
  PERFORM set_config('app.pre_tenant_id', '', true);                             -- tenant-less factors only (A15.2 select branch)
  IF p_factor_id IS NULL THEN
    v := jsonb_populate_record(NULL::identity.mfa_factors, p_row);
    IF v.tenant_id IS NOT NULL OR v.user_id IS DISTINCT FROM p_user_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_platform_auth_write_invalid_input';
    END IF;
    INSERT INTO identity.mfa_factors SELECT v.*;
    v_n := 1;
  ELSE
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_row) k WHERE k NOT IN ('status','verified_at','removed_at','removed_by',
         'removal_reason','friendly_name','is_active','updated_by')) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_platform_auth_write_invalid_input';
    END IF;
    SELECT * INTO v FROM identity.mfa_factors f
     WHERE f.id = p_factor_id AND f.user_id = p_user_id AND f.tenant_id IS NULL FOR UPDATE;
    IF FOUND THEN
      v := jsonb_populate_record(v, p_row);
      UPDATE identity.mfa_factors f
         SET status = v.status, verified_at = v.verified_at, removed_at = v.removed_at, removed_by = v.removed_by,
             removal_reason = v.removal_reason, friendly_name = v.friendly_name, is_active = v.is_active, updated_by = v.updated_by,
             updated_at = now(), version = f.version + 1
       WHERE f.id = p_factor_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
    ELSE
      v_n := 0;
    END IF;
  END IF;
  PERFORM set_config('app.pre_user_id', '', true);
  RETURN v_n;
END $$;

CREATE FUNCTION app.identity_platform_auth_write_invitation_accept(p_user_id uuid, p_invitation_id uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
-- setPasswordFromSetup for a platform-staff invite: sent → accepted; also stamps platform_staff.last_login_at
DECLARE
  v_n integer;
BEGIN
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- invitations__{select,update}__owner_only
  UPDATE identity.invitations i SET status = 'accepted', accepted_at = now(), updated_at = now(), updated_by = p_user_id,
         version = i.version + 1
   WHERE i.id = p_invitation_id AND i.tenant_id IS NULL AND i.user_id = p_user_id AND i.status = 'sent' AND i.expires_at > now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.pre_user_id', '', true);
  RETURN v_n;
END $$;

-- 08 A38-1(a) (LD-99): setPasswordFromSetup for a platform user — revoke the user's other platform sessions (password_change)
CREATE FUNCTION app.identity_platform_auth_write_revoke_other_sessions(p_user_id uuid, p_except_session_id uuid, p_reason text)
RETURNS uuid[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_ids uuid[];
BEGIN
  IF p_reason IS DISTINCT FROM 'password_change' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_platform_auth_write_invalid_input';
  END IF;
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- sessions__{select,update}__owner_only
  WITH r AS (
    UPDATE identity.sessions s SET state = 'revoked', revoked_at = now(), revoked_by = p_user_id, revoke_reason = p_reason,
           updated_at = now(), updated_by = p_user_id, version = s.version + 1
     WHERE s.user_id = p_user_id AND s.kind = 'platform' AND s.tenant_id IS NULL AND s.id <> p_except_session_id
       AND s.state NOT IN ('revoked','expired')
    RETURNING s.id)
  SELECT coalesce(array_agg(r.id), '{}') INTO v_ids FROM r;
  PERFORM set_config('app.pre_user_id', '', true);
  RETURN v_ids;
END $$;

-- 08 A38-1(b) (LD-99): setPasswordFromSetup for a platform-staff invite — accept the user's sent, unexpired platform invitations
CREATE FUNCTION app.identity_platform_auth_write_invitation_accept_by_user(p_user_id uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_n integer;
BEGIN
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- invitations__{select,update}__owner_only
  UPDATE identity.invitations i SET status = 'accepted', accepted_at = now(), updated_at = now(), updated_by = p_user_id,
         version = i.version + 1
   WHERE i.tenant_id IS NULL AND i.user_id = p_user_id AND i.status = 'sent' AND i.expires_at > now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.pre_user_id', '', true);
  RETURN v_n;
END $$;

CREATE FUNCTION app.identity_platform_auth_write_staff_login(p_user_id uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
-- successful platform-staff login: platform_staff.last_login_at (platform-only table, no tenant_id column)
DECLARE
  v_n integer;
BEGIN
  PERFORM set_config('app.pre_user_id', coalesce(p_user_id::text, ''), true);   -- platform_staff__update__owner_only
  UPDATE identity.platform_staff ps SET last_login_at = now(), updated_at = now(), updated_by = p_user_id, version = ps.version + 1
   WHERE ps.user_id = p_user_id AND ps.is_active;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.pre_user_id', '', true);
  RETURN v_n;
END $$;

-- 08 A28.4 — e-mail HMACs of one IP's failure window, for the worker task identity.notify_ip_throttle (no claims). Gated by
-- app.maintenance = 'identity_notify_ip_throttle' (A12.2 pattern); at most 100 distinct values (the D-217 cap of the next call).
CREATE FUNCTION app.identity_notify_ip_throttle_hmacs(p_client_ip inet, p_since timestamptz) RETURNS SETOF bytea
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM set_config('app.maintenance', 'identity_notify_ip_throttle', true);   -- auth_events__select__owner_only
  RETURN QUERY
    SELECT DISTINCT e.email_hmac FROM identity.auth_events e
     WHERE e.tenant_id IS NULL AND e.event_type = 'login_failed' AND e.email_hmac IS NOT NULL
       AND e.client_ip = p_client_ip AND e.occurred_at >= p_since
     LIMIT 100;
  PERFORM set_config('app.maintenance', '', true);
  RETURN;
END $$;
REVOKE ALL ON FUNCTION app.identity_platform_auth_write_session_insert(uuid,jsonb),
  app.identity_platform_auth_write_session_update(uuid,uuid,jsonb), app.identity_platform_auth_write_mfa_factor(uuid,uuid,jsonb),
  app.identity_platform_auth_write_invitation_accept(uuid,uuid), app.identity_platform_auth_write_staff_login(uuid),
  app.identity_notify_ip_throttle_hmacs(inet,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.identity_platform_auth_write_revoke_other_sessions(uuid,uuid,text),
  app.identity_platform_auth_write_invitation_accept_by_user(uuid) FROM PUBLIC;   -- 08 A38-1
GRANT EXECUTE ON FUNCTION app.identity_platform_auth_write_revoke_other_sessions(uuid,uuid,text),
  app.identity_platform_auth_write_invitation_accept_by_user(uuid) TO lims_api;   -- 08 A38-1
GRANT EXECUTE ON FUNCTION app.identity_platform_auth_write_session_insert(uuid,jsonb),
  app.identity_platform_auth_write_session_update(uuid,uuid,jsonb), app.identity_platform_auth_write_mfa_factor(uuid,uuid,jsonb),
  app.identity_platform_auth_write_invitation_accept(uuid,uuid), app.identity_platform_auth_write_staff_login(uuid) TO lims_api;
GRANT EXECUTE ON FUNCTION app.identity_notify_ip_throttle_hmacs(inet,timestamptz) TO lims_worker;
GRANT EXECUTE ON FUNCTION app.identity_resolve_session(uuid,uuid), app.identity_session_by_token(bytea),
  app.identity_login_context(uuid), app.identity_user_exists(uuid), app.identity_record_auth_event(jsonb),
  app.identity_bootstrap_platform_admin(uuid,uuid,text,text,uuid) TO lims_api;
GRANT EXECUTE ON FUNCTION app.identity_purge_sessions(), app.identity_expire_support_sessions(),
  app.identity_expire_invitations(), app.identity_expire_audit_exports(), app.identity_purge_auth_events(),
  app.identity_load_breached_batch(bytea[],text), app.identity_finish_breached_import(text) TO lims_worker;
