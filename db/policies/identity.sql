-- T0B-10.C2: canonical CREATE POLICY set for identity.* (C2 05-SCHEMA §5, §10.1; AC-0B-2.3). Copied from
-- db/migrations/20261105001300_identity__create_identity_schema.sql (source of truth); CI diffs pg_policies against this file.
-- Not here yet: identity.event_inbox policies (T0B-05; see .orchestra/notes/T0B-10.C2-dispute.md). Do not edit by hand without the migration.
CREATE POLICY sessions__select__tenant ON identity.sessions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY sessions__insert__tenant ON identity.sessions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY sessions__update__tenant ON identity.sessions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY mfa_factors__select__tenant ON identity.mfa_factors FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY mfa_factors__insert__tenant ON identity.mfa_factors FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY mfa_factors__update__tenant ON identity.mfa_factors FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY auth_events__select__tenant ON identity.auth_events FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY auth_events__insert__tenant ON identity.auth_events FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY invitations__select__tenant ON identity.invitations FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY invitations__insert__tenant ON identity.invitations FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY invitations__update__tenant ON identity.invitations FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenant_settings__select__tenant ON identity.tenant_settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenant_settings__insert__tenant ON identity.tenant_settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenant_settings__update__tenant ON identity.tenant_settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY feature_flags__select__tenant ON identity.feature_flags FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY feature_flags__insert__tenant ON identity.feature_flags FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY feature_flags__update__tenant ON identity.feature_flags FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY branding_assets__select__tenant ON identity.branding_assets FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY branding_assets__insert__tenant ON identity.branding_assets FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY branding_assets__update__tenant ON identity.branding_assets FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY support_sessions__select__tenant ON identity.support_sessions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY support_sessions__update__tenant ON identity.support_sessions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ird_annex_records__select__tenant ON identity.ird_annex_records FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ird_annex_events__select__tenant ON identity.ird_annex_events FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ird_annex_documents__select__tenant ON identity.ird_annex_documents FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY audit_exports__select__tenant ON identity.audit_exports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY audit_exports__insert__tenant ON identity.audit_exports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY audit_exports__update__tenant ON identity.audit_exports FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY access_reviews__select__tenant ON identity.access_reviews FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY access_reviews__insert__tenant ON identity.access_reviews FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY admin_notices__select__tenant ON identity.admin_notices FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY admin_notices__insert__tenant ON identity.admin_notices FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY admin_notices__update__tenant ON identity.admin_notices FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ird_annex_records__select__tenant_platform_ref ON identity.ird_annex_records FOR SELECT TO lims_app
  USING (tenant_id IS NULL AND annex_code = 'annex_1'
         AND id = (SELECT ts.ird_annex_1_record_id FROM identity.tenant_settings ts WHERE ts.tenant_id = (SELECT app.current_tenant_id()))
         AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenant_settings__select__platform ON identity.tenant_settings FOR SELECT TO lims_app
  USING ((SELECT app.is_platform_actor()));
CREATE POLICY tenant_settings__update__platform ON identity.tenant_settings FOR UPDATE TO lims_app
  USING ((SELECT app.is_platform_actor())) WITH CHECK ((SELECT app.is_platform_actor()));
CREATE POLICY sessions__select__own ON identity.sessions FOR SELECT TO lims_app
  USING (id = (SELECT app.current_lims_session_id()) AND user_id = (SELECT app.current_actor_id())
         AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY sessions__insert__own ON identity.sessions FOR INSERT TO lims_app
  WITH CHECK (id = (SELECT app.current_lims_session_id()) AND user_id = (SELECT app.current_actor_id())
              AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY sessions__update__own ON identity.sessions FOR UPDATE TO lims_app
  USING (id = (SELECT app.current_lims_session_id()) AND user_id = (SELECT app.current_actor_id())
         AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()))
  WITH CHECK (id = (SELECT app.current_lims_session_id()) AND user_id = (SELECT app.current_actor_id())
         AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY sessions__select__own_user ON identity.sessions FOR SELECT TO lims_app
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY sessions__update__own_user ON identity.sessions FOR UPDATE TO lims_app
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY mfa_factors__select__own ON identity.mfa_factors FOR SELECT TO lims_app
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY mfa_factors__insert__own ON identity.mfa_factors FOR INSERT TO lims_app
  WITH CHECK (user_id = (SELECT app.current_actor_id()) AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY mfa_factors__update__own ON identity.mfa_factors FOR UPDATE TO lims_app
  USING (user_id = (SELECT app.current_actor_id()) AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()))
  WITH CHECK (user_id = (SELECT app.current_actor_id()) AND tenant_id IS NOT DISTINCT FROM (SELECT app.current_tenant_id()));
CREATE POLICY sessions__select__platform ON identity.sessions FOR SELECT TO lims_app
  USING (kind = 'platform' AND tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY sessions__update__platform ON identity.sessions FOR UPDATE TO lims_app
  USING (kind = 'platform' AND tenant_id IS NULL AND (SELECT app.is_platform_actor()))
  WITH CHECK (kind = 'platform' AND tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY mfa_factors__select__platform ON identity.mfa_factors FOR SELECT TO lims_app
  USING (tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY mfa_factors__insert__platform ON identity.mfa_factors FOR INSERT TO lims_app
  WITH CHECK (tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY mfa_factors__update__platform ON identity.mfa_factors FOR UPDATE TO lims_app
  USING (tenant_id IS NULL AND (SELECT app.is_platform_actor()))
  WITH CHECK (tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY invitations__select__platform ON identity.invitations FOR SELECT TO lims_app
  USING (tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY invitations__insert__platform ON identity.invitations FOR INSERT TO lims_app
  WITH CHECK (tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY invitations__update__platform ON identity.invitations FOR UPDATE TO lims_app
  USING (tenant_id IS NULL AND (SELECT app.is_platform_actor()))
  WITH CHECK (tenant_id IS NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY platform_staff__select__owner_only ON identity.platform_staff FOR SELECT TO lims_owner
  USING (true);
CREATE POLICY platform_staff__insert__owner_only ON identity.platform_staff FOR INSERT TO lims_owner
  WITH CHECK (role_code = 'platform_superadmin');
CREATE POLICY platform_events__insert__owner_only ON identity.platform_events FOR INSERT TO lims_owner
  WITH CHECK (event_type = 'bootstrap_admin_created');
CREATE POLICY auth_events__insert__owner_only ON identity.auth_events FOR INSERT TO lims_owner
  WITH CHECK (tenant_id IS NULL);
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
  USING (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid) WITH CHECK (tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
CREATE POLICY platform_staff__update__owner_only ON identity.platform_staff FOR UPDATE TO lims_owner
  USING (user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid) WITH CHECK (user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
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
