-- T0B-06 test fixture: stand-in `identity.*` tables (C2 owns the real DDL; C2 05-SCHEMA §10.1) so the C0 identity DEFINERs can be
-- exercised before the C2 migration exists. Only the columns the §10.3 functions read or write are present. Every stand-in has
-- ENABLE + FORCE RLS and carries the REAL owner policies (C2 05-SCHEMA §10.1, verbatim) — a stand-in without them proves nothing
-- (AC-0B-2.4, C0 05-SCHEMA §10 schema test 13). Skipped entirely when the real identity tables already exist.
-- Included from db/tests/identity/*.test.sql with `\ir ../fixtures/T0B-06_identity_standin.sql` inside the test's transaction.
DO $standin$
BEGIN
  IF to_regclass('identity.sessions') IS NOT NULL THEN
    RAISE NOTICE 'identity tables exist; stand-ins not created';
    RETURN;
  END IF;
  EXECUTE $ddl$
    CREATE TABLE identity.platform_staff (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, email_normalized text NOT NULL, display_name text NOT NULL,
      role_code text NOT NULL, allowed_cidrs cidr[], is_active boolean NOT NULL DEFAULT true, last_login_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by uuid NOT NULL, version integer NOT NULL DEFAULT 1);
    CREATE TABLE identity.platform_events (
      id uuid PRIMARY KEY, event_type text NOT NULL, target_type text, target_id uuid, created_by uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE identity.auth_events (
      id uuid PRIMARY KEY, tenant_id uuid, user_id uuid, platform_staff_id uuid, session_id uuid, event_type text NOT NULL,
      reason_code text, email_hmac bytea, client_ip inet, user_agent text, request_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL);
    CREATE TABLE identity.tenant_settings (
      tenant_id uuid PRIMARY KEY, retention_audit_years integer NOT NULL DEFAULT 5, idle_timeout_minutes integer NOT NULL DEFAULT 30,
      absolute_session_hours integer NOT NULL DEFAULT 12);
    CREATE TABLE identity.sessions (
      id uuid PRIMARY KEY, tenant_id uuid, user_id uuid NOT NULL, kind text NOT NULL, state text NOT NULL DEFAULT 'active',
      aal text NOT NULL DEFAULT 'aal1', membership_id uuid, platform_staff_id uuid, support_session_id uuid,
      gotrue_session_id uuid, token_sha256 bytea, previous_token_sha256 bytea, refresh_token_enc bytea, access_token_enc bytea,
      enc_key_id text, access_expires_at timestamptz, last_seen_at timestamptz, idle_expires_at timestamptz,
      absolute_expires_at timestamptz, expires_at timestamptz NOT NULL, mfa_failed_attempts integer NOT NULL DEFAULT 0,
      revoked_at timestamptz, revoked_by uuid, revoke_reason text, created_at timestamptz NOT NULL DEFAULT now(),
      created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL, version integer NOT NULL DEFAULT 1);
    CREATE TABLE identity.admin_notices (
      id uuid PRIMARY KEY, tenant_id uuid, kind text NOT NULL, subject_id uuid, expires_at timestamptz NOT NULL);
    CREATE TABLE identity.mfa_factors (
      id uuid PRIMARY KEY, tenant_id uuid, user_id uuid NOT NULL, status text NOT NULL, verified_at timestamptz, removed_at timestamptz,
      removed_by uuid, removal_reason text, friendly_name text, is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by uuid NOT NULL, version integer NOT NULL DEFAULT 1);
    CREATE TABLE identity.support_sessions (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, status text NOT NULL, end_reason text, scope text NOT NULL DEFAULT 'read_only',
      requested_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, expires_at timestamptz, ended_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1);
    CREATE TABLE identity.invitations (
      id uuid PRIMARY KEY, tenant_id uuid, user_id uuid, email text, status text NOT NULL, expires_at timestamptz NOT NULL,
      accepted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, version integer NOT NULL DEFAULT 1);
    CREATE TABLE identity.audit_exports (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, status text NOT NULL, object_path text, expires_at timestamptz,
      downloads_remaining integer, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1);
  $ddl$;
  -- ownership and FORCE RLS exactly as the real tables (owner lims_owner; FORCE applies to the owner)
  ALTER TABLE identity.platform_staff OWNER TO lims_owner;   ALTER TABLE identity.platform_staff ENABLE ROW LEVEL SECURITY;   ALTER TABLE identity.platform_staff FORCE ROW LEVEL SECURITY;
  ALTER TABLE identity.platform_events OWNER TO lims_owner;  ALTER TABLE identity.platform_events ENABLE ROW LEVEL SECURITY;  ALTER TABLE identity.platform_events FORCE ROW LEVEL SECURITY;
  ALTER TABLE identity.auth_events OWNER TO lims_owner;      ALTER TABLE identity.auth_events ENABLE ROW LEVEL SECURITY;      ALTER TABLE identity.auth_events FORCE ROW LEVEL SECURITY;
  ALTER TABLE identity.tenant_settings OWNER TO lims_owner;  ALTER TABLE identity.tenant_settings ENABLE ROW LEVEL SECURITY;  ALTER TABLE identity.tenant_settings FORCE ROW LEVEL SECURITY;
  ALTER TABLE identity.sessions OWNER TO lims_owner;         ALTER TABLE identity.sessions ENABLE ROW LEVEL SECURITY;         ALTER TABLE identity.sessions FORCE ROW LEVEL SECURITY;
  ALTER TABLE identity.admin_notices OWNER TO lims_owner;    ALTER TABLE identity.admin_notices ENABLE ROW LEVEL SECURITY;    ALTER TABLE identity.admin_notices FORCE ROW LEVEL SECURITY;
  ALTER TABLE identity.mfa_factors OWNER TO lims_owner;      ALTER TABLE identity.mfa_factors ENABLE ROW LEVEL SECURITY;      ALTER TABLE identity.mfa_factors FORCE ROW LEVEL SECURITY;
  ALTER TABLE identity.support_sessions OWNER TO lims_owner; ALTER TABLE identity.support_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.support_sessions FORCE ROW LEVEL SECURITY;
  ALTER TABLE identity.invitations OWNER TO lims_owner;      ALTER TABLE identity.invitations ENABLE ROW LEVEL SECURITY;      ALTER TABLE identity.invitations FORCE ROW LEVEL SECURITY;
  ALTER TABLE identity.audit_exports OWNER TO lims_owner;    ALTER TABLE identity.audit_exports ENABLE ROW LEVEL SECURITY;    ALTER TABLE identity.audit_exports FORCE ROW LEVEL SECURITY;
  -- lims_app holds SELECT so that "a lims_app session that sets the GUCs itself sees 0 rows" is a row-count result, not a privilege error
  GRANT SELECT ON identity.platform_staff, identity.auth_events, identity.tenant_settings, identity.sessions, identity.admin_notices,
    identity.mfa_factors, identity.support_sessions, identity.invitations, identity.audit_exports TO lims_app;
  -- ---- the real owner policies, C2 05-SCHEMA §10.1 (verbatim) ----
  EXECUTE $pol$
    CREATE POLICY platform_staff__select__owner_only ON identity.platform_staff FOR SELECT TO lims_owner USING (true);
    CREATE POLICY platform_staff__insert__owner_only ON identity.platform_staff FOR INSERT TO lims_owner WITH CHECK (role_code = 'platform_superadmin');
    CREATE POLICY platform_events__insert__owner_only ON identity.platform_events FOR INSERT TO lims_owner WITH CHECK (event_type = 'bootstrap_admin_created');
    CREATE POLICY auth_events__insert__owner_only ON identity.auth_events FOR INSERT TO lims_owner WITH CHECK (tenant_id IS NULL);
    CREATE POLICY auth_events__select__owner_only ON identity.auth_events FOR SELECT TO lims_owner
      USING ((current_setting('app.maintenance', true) = 'identity_purge_auth_events' AND occurred_at < now() - interval '5 years')
          OR (current_setting('app.maintenance', true) = 'identity_notify_ip_throttle'
              AND tenant_id IS NULL AND event_type = 'login_failed' AND email_hmac IS NOT NULL));
    CREATE POLICY auth_events__delete__owner_only ON identity.auth_events FOR DELETE TO lims_owner
      USING (current_setting('app.maintenance', true) = 'identity_purge_auth_events' AND occurred_at < now() - interval '5 years');
    CREATE POLICY tenant_settings__select__owner_only ON identity.tenant_settings FOR SELECT TO lims_owner
      USING (tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid
          OR current_setting('app.maintenance', true) = 'identity_purge_auth_events');
    CREATE POLICY sessions__select__owner_only ON identity.sessions FOR SELECT TO lims_owner
      USING ((current_setting('app.maintenance', true) = 'identity_purge_sessions' AND expires_at < now())
          OR token_sha256 = decode(current_setting('app.pre_session_token_sha256', true), 'hex')
          OR previous_token_sha256 = decode(current_setting('app.pre_session_token_sha256', true), 'hex')
          OR gotrue_session_id = nullif(current_setting('app.pre_gotrue_session_id', true), '')::uuid
          OR (tenant_id IS NULL AND kind = 'platform' AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid));
    CREATE POLICY sessions__insert__owner_only ON identity.sessions FOR INSERT TO lims_owner
      WITH CHECK (tenant_id IS NULL AND kind = 'platform' AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
    CREATE POLICY sessions__update__owner_only ON identity.sessions FOR UPDATE TO lims_owner
      USING (tenant_id IS NULL AND kind = 'platform' AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid)
      WITH CHECK (tenant_id IS NULL AND kind = 'platform' AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
    CREATE POLICY sessions__delete__owner_only ON identity.sessions FOR DELETE TO lims_owner
      USING (current_setting('app.maintenance', true) = 'identity_purge_sessions' AND expires_at < now());
    CREATE POLICY admin_notices__select__owner_only ON identity.admin_notices FOR SELECT TO lims_owner
      USING (current_setting('app.maintenance', true) = 'identity_purge_sessions' AND expires_at < now());
    CREATE POLICY admin_notices__delete__owner_only ON identity.admin_notices FOR DELETE TO lims_owner
      USING (current_setting('app.maintenance', true) = 'identity_purge_sessions' AND expires_at < now());
    CREATE POLICY mfa_factors__select__owner_only ON identity.mfa_factors FOR SELECT TO lims_owner
      USING (user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid
             AND tenant_id IS NOT DISTINCT FROM nullif(current_setting('app.pre_tenant_id', true), '')::uuid);
    CREATE POLICY mfa_factors__insert__owner_only ON identity.mfa_factors FOR INSERT TO lims_owner
      WITH CHECK (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
    CREATE POLICY mfa_factors__update__owner_only ON identity.mfa_factors FOR UPDATE TO lims_owner
      USING (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid)
      WITH CHECK (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
    CREATE POLICY platform_staff__update__owner_only ON identity.platform_staff FOR UPDATE TO lims_owner
      USING (user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid)
      WITH CHECK (user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
    CREATE POLICY support_sessions__select__owner_only ON identity.support_sessions FOR SELECT TO lims_owner
      USING ((current_setting('app.maintenance', true) = 'identity_expire_support_sessions'
              AND ((status = 'requested' AND requested_at < now() - interval '24 hours')
                OR (status = 'approved'  AND decided_at   < now() - interval '60 minutes')
                OR (status = 'active'    AND expires_at   <= now())
                OR (status = 'expired'   AND end_reason = 'expired')))
          OR id = nullif(current_setting('app.pre_support_session_id', true), '')::uuid
          OR tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid);
    CREATE POLICY support_sessions__update__owner_only ON identity.support_sessions FOR UPDATE TO lims_owner
      USING (current_setting('app.maintenance', true) = 'identity_expire_support_sessions'
             AND ((status = 'requested' AND requested_at < now() - interval '24 hours')
               OR (status = 'approved'  AND decided_at   < now() - interval '60 minutes')
               OR (status = 'active'    AND expires_at   <= now())))
      WITH CHECK (current_setting('app.maintenance', true) = 'identity_expire_support_sessions'
                  AND status = 'expired' AND end_reason = 'expired');
    CREATE POLICY invitations__select__owner_only ON identity.invitations FOR SELECT TO lims_owner
      USING ((current_setting('app.maintenance', true) = 'identity_expire_invitations'
             AND ((status IN ('pending','sent') AND expires_at < now())
               OR (email IS NOT NULL AND status IN ('accepted','expired','revoked','failed') AND updated_at < now() - interval '30 days')
               OR status = 'expired'
               OR (email IS NULL AND status IN ('accepted','expired','revoked','failed'))))
          OR (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid));
    CREATE POLICY invitations__update__owner_only ON identity.invitations FOR UPDATE TO lims_owner
      USING ((current_setting('app.maintenance', true) = 'identity_expire_invitations'
              AND ((status IN ('pending','sent') AND expires_at < now())
                OR (email IS NOT NULL AND status IN ('accepted','expired','revoked','failed') AND updated_at < now() - interval '30 days')))
          OR (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid))
      WITH CHECK ((current_setting('app.maintenance', true) = 'identity_expire_invitations'
                   AND (status = 'expired' OR (email IS NULL AND status IN ('accepted','expired','revoked','failed'))))
               OR (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid));
    CREATE POLICY audit_exports__select__owner_only ON identity.audit_exports FOR SELECT TO lims_owner
      USING (current_setting('app.maintenance', true) = 'identity_expire_audit_exports'
             AND ((status = 'ready' AND (expires_at <= now() OR downloads_remaining = 0)) OR status = 'expired'
               OR (status IN ('expired','failed') AND created_at < now() - interval '1 year')));
    CREATE POLICY audit_exports__delete__owner_only ON identity.audit_exports FOR DELETE TO lims_owner
      USING (current_setting('app.maintenance', true) = 'identity_expire_audit_exports'
             AND status IN ('expired','failed') AND created_at < now() - interval '1 year');
    CREATE POLICY audit_exports__update__owner_only ON identity.audit_exports FOR UPDATE TO lims_owner
      USING (current_setting('app.maintenance', true) = 'identity_expire_audit_exports'
             AND status = 'ready' AND (expires_at <= now() OR downloads_remaining = 0))
      WITH CHECK (current_setting('app.maintenance', true) = 'identity_expire_audit_exports' AND status = 'expired');
  $pol$;
END
$standin$;
