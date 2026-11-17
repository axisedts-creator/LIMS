-- CR-C16 (draft, AUTH-SENSITIVE; .orchestra/cr/C16-WIRE-PATIENT-WRITERS.md, .orchestra/cr/C2.T31.nonblocking.md item 2; LD-81):
-- the two privileged writes of patient sign-in (E3 verifyPatientOtp, TRD §4.1 step 3), as DEFINER functions in the pattern of
-- 20261105000800 (owner-only policies keyed to a transaction-local setting that the function sets and clears):
--   app.identity_patient_create_membership(p_account_id)  one core.users + one core.memberships row for a NEW patient account
--   app.identity_patient_open_session(p_row)                 one identity.sessions row (kind 'patient')
--   app.identity_patient_membership(p_membership_id)         read: user id / status / locked of ONE patient membership of the tenant (RLS hides
--                                                            core.memberships from a patient actor; openPatientSession needs the user id for the JWT sub)
-- Both run only in the patient pre-auth context (claims: actor_type 'patient' + patient_stage set, i.e. the verified OTP challenge).
-- No table or column changes. membership id = account id (the account id is the challenge id, TRD §4.1 step 3), so provisioning is
-- idempotent per accountId without a new mapping column; the user id is generated here. Patients get no GoTrue user (LD-81), so the
-- three GoTrue-shaped NOT NULL session columns are filled by the function, never by the caller: gotrue_session_id = the session id itself
-- (app.identity_resolve_session looks a session up by the JWT session_id claim in that column; the patient JWT carries the session row id),
-- and fixed placeholders for the two encrypted-token columns and enc_key_id.
-- Nothing in these functions reads or writes a phone number or e-mail.
SET LOCAL ROLE lims_owner;

-- owner-only policies: each is true only while the matching function has set app.maintenance (transaction-local, cleared before return)
CREATE POLICY users__insert__owner_patient ON core.users FOR INSERT TO lims_owner
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id())
              AND current_setting('app.maintenance', true) = 'identity_patient_provision');
CREATE POLICY memberships__insert__owner_patient ON core.memberships FOR INSERT TO lims_owner
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_type = 'patient'
              AND current_setting('app.maintenance', true) = 'identity_patient_provision');
CREATE POLICY sessions__insert__owner_patient ON identity.sessions FOR INSERT TO lims_owner
  WITH CHECK (kind = 'patient' AND tenant_id = (SELECT app.current_tenant_id())
              AND current_setting('app.maintenance', true) = 'identity_patient_session');

CREATE FUNCTION app.identity_patient_create_membership(p_account_id uuid)
RETURNS TABLE (membership_id uuid, user_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_actor  uuid := app.current_actor_id();
  v_user   uuid;
BEGIN
  -- only the verified challenge of this request may provision, and only for the account that carries its id
  IF v_tenant IS NULL OR v_actor IS NULL OR app.current_actor_type() IS DISTINCT FROM 'patient'
     OR app.engagement_preauth_stage() IS NULL OR p_account_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_patient_provision_invalid_input';
  END IF;
  -- idempotent: a retry after a rolled-back verify finds nothing; a repeat within the transaction returns the same ids
  SELECT m.user_id INTO v_user FROM core.memberships m
   WHERE m.tenant_id = v_tenant AND m.id = p_account_id AND m.actor_type = 'patient';
  IF v_user IS NULL THEN
    v_user := app.uuidv7();
    PERFORM set_config('app.maintenance', 'identity_patient_provision', true);
    INSERT INTO core.users (tenant_id, id, display_name, created_by, updated_by)
      VALUES (v_tenant, v_user, 'Patient', v_actor, v_actor);
    INSERT INTO core.memberships (id, tenant_id, user_id, actor_type, status, accepted_at, created_by, updated_by)
      VALUES (p_account_id, v_tenant, v_user, 'patient', 'active', now(), v_actor, v_actor);
    PERFORM set_config('app.maintenance', '', true);
  END IF;
  RETURN QUERY SELECT p_account_id, v_user;
END $$;

CREATE FUNCTION app.identity_patient_open_session(p_row jsonb) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v        identity.sessions%ROWTYPE;
  v_tenant uuid := app.current_tenant_id();
BEGIN
  IF v_tenant IS NULL OR app.current_actor_type() IS DISTINCT FROM 'patient' OR app.engagement_preauth_stage() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_patient_open_session_invalid_input';
  END IF;
  v := jsonb_populate_record(NULL::identity.sessions, p_row);
  -- shape: an active, aal1, patient-kind row of THIS tenant for an active patient membership of THIS tenant, bound to that membership's user
  IF v.kind IS DISTINCT FROM 'patient' OR v.tenant_id IS DISTINCT FROM v_tenant OR v.state IS DISTINCT FROM 'active'
     OR v.aal IS DISTINCT FROM 'aal1' OR v.membership_id IS NULL OR v.user_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM core.memberships m
                     WHERE m.tenant_id = v_tenant AND m.id = v.membership_id AND m.user_id = v.user_id
                       AND m.actor_type = 'patient' AND m.status = 'active' AND m.locked_at IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_patient_open_session_invalid_input';
  END IF;
  -- LD-81: no GoTrue session for the patient kind. gotrue_session_id = the session id (the resolver looks sessions up by the JWT session_id claim in that
  -- column); fixed placeholders for the other NOT NULL GoTrue columns; the caller cannot choose any of them.
  -- Explicit column list (jsonb_populate_record leaves unspecified columns NULL, bypassing defaults such as last_seen_at / version).
  PERFORM set_config('app.maintenance', 'identity_patient_session', true);
  INSERT INTO identity.sessions (id, tenant_id, kind, user_id, membership_id, gotrue_session_id, token_sha256, state, aal,
      refresh_token_enc, access_token_enc, enc_key_id, access_expires_at, idle_timeout_minutes, idle_expires_at,
      absolute_expires_at, app_instance_id, app_platform, expires_at, created_by, updated_by)
    VALUES (v.id, v_tenant, 'patient', v.user_id, v.membership_id, v.id, v.token_sha256, 'active', 'aal1',
      '\x'::bytea, '\x'::bytea, 'patient-no-gotrue', v.access_expires_at, v.idle_timeout_minutes, v.idle_expires_at,
      v.absolute_expires_at, v.app_instance_id, v.app_platform, v.expires_at, v.created_by, v.updated_by);
  PERFORM set_config('app.maintenance', '', true);
END $$;

CREATE FUNCTION app.identity_patient_membership(p_membership_id uuid)
RETURNS TABLE (user_id uuid, status text, locked boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE
  v_tenant uuid := app.current_tenant_id();
BEGIN
  IF v_tenant IS NULL OR app.current_actor_type() IS DISTINCT FROM 'patient' OR app.engagement_preauth_stage() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'identity_patient_membership_invalid_input';
  END IF;
  RETURN QUERY SELECT m.user_id, m.status, m.locked_at IS NOT NULL
    FROM core.memberships m
   WHERE m.tenant_id = v_tenant AND m.id = p_membership_id AND m.actor_type = 'patient';
END $$;

REVOKE ALL ON FUNCTION app.identity_patient_create_membership(uuid), app.identity_patient_open_session(jsonb),
  app.identity_patient_membership(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.identity_patient_create_membership(uuid), app.identity_patient_open_session(jsonb),
  app.identity_patient_membership(uuid) TO lims_api;
