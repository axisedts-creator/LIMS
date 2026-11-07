-- T0B-03: canonical CREATE POLICY set for core.* tables (05-SCHEMA §6, §10; AC-0B-2.3). Copied from the db/migrations/*_core__create_*.sql
-- files, which are the source of truth; CI diffs pg_policies against this file. Do not edit by hand without the migration.

-- from 20261105000200_core__create_tenants.sql
CREATE POLICY tenants__select__tenant ON core.tenants FOR SELECT TO lims_app
  USING (id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenants__insert__tenant ON core.tenants FOR INSERT TO lims_app
  WITH CHECK (id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenants__update__tenant ON core.tenants FOR UPDATE TO lims_app
  USING (id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY tenants__select__owner_only ON core.tenants FOR SELECT TO lims_owner
  USING (id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid
      OR current_setting('app.maintenance', true) = 'platform_list_tenants'
      OR (current_setting('app.maintenance', true) = 'cron_tenant_ids'
          AND status IN ('active','suspended'))
      OR tenant_code = nullif(current_setting('app.pre_tenant_code', true), ''));

-- from 20261105000300_core__create_branches_and_centres.sql
CREATE POLICY branches__select__tenant ON core.branches FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY branches__insert__tenant ON core.branches FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY branches__update__tenant ON core.branches FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY collection_centres__select__tenant ON core.collection_centres FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY collection_centres__insert__tenant ON core.collection_centres FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY collection_centres__update__tenant ON core.collection_centres FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));

-- from 20261105000400_core__create_users_and_memberships.sql
CREATE POLICY users__select__tenant ON core.users FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY users__insert__tenant ON core.users FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY users__update__tenant ON core.users FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY users__select__owner_only ON core.users FOR SELECT TO lims_owner
  USING (id = nullif(current_setting('app.pre_user_id', true), '')::uuid
      OR (current_setting('app.maintenance', true) = 'identity_tenants_for_email_hmacs'
          AND email_hmac IS NOT NULL));
CREATE POLICY memberships__select__tenant ON core.memberships FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY memberships__insert__tenant ON core.memberships FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY memberships__update__tenant ON core.memberships FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY memberships__select__owner_only ON core.memberships FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id())
      OR user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid);
CREATE POLICY membership_centres__select__tenant ON core.membership_centres FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_centres__insert__tenant ON core.membership_centres FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_centres__delete__tenant ON core.membership_centres FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_centres__select__owner_only ON core.membership_centres FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id()));

-- from 20261105000700_core__create_membership_branches.sql
CREATE POLICY membership_branches__select__tenant ON core.membership_branches FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_branches__insert__tenant ON core.membership_branches FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_branches__delete__tenant ON core.membership_branches FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));

-- from 20261105000500_core__create_roles_and_permissions.sql
CREATE POLICY roles__select__tenant ON core.roles FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY roles__insert__tenant ON core.roles FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY roles__update__tenant ON core.roles FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY roles__select__owner_only ON core.roles FOR SELECT TO lims_owner
  USING (tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid);
CREATE POLICY role_permissions__select__tenant ON core.role_permissions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY role_permissions__insert__tenant ON core.role_permissions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY role_permissions__delete__tenant ON core.role_permissions FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_roles__select__tenant ON core.membership_roles FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_roles__insert__tenant ON core.membership_roles FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_roles__delete__tenant ON core.membership_roles FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY membership_roles__select__owner_only ON core.membership_roles FOR SELECT TO lims_owner
  USING (tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid
         AND EXISTS (SELECT 1 FROM core.memberships m
                     WHERE m.tenant_id = membership_roles.tenant_id AND m.id = membership_roles.membership_id
                       AND m.user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid));

-- from 20261105000900_core__create_event_log.sql
CREATE POLICY event_log__select__tenant ON core.event_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_log__insert__tenant ON core.event_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_log__insert__partner ON core.event_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND created_by = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY event_log__insert__portal ON core.event_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND created_by = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY event_log__insert__patient ON core.event_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND created_by = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'patient');
CREATE POLICY dead_letters__select__tenant ON core.dead_letters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY dead_letters__insert__tenant ON core.dead_letters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY dead_letters__update__tenant ON core.dead_letters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY idempotency_keys__select__tenant ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY idempotency_keys__insert__tenant ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY idempotency_keys__update__tenant ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY idempotency_keys__delete__tenant ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_staff_or_system())
         AND state = 'in_progress');
CREATE POLICY idempotency_keys__select__partner ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY idempotency_keys__insert__partner ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY idempotency_keys__update__partner ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY idempotency_keys__delete__partner ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND state = 'in_progress');
CREATE POLICY idempotency_keys__select__portal ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY idempotency_keys__insert__portal ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY idempotency_keys__update__portal ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY idempotency_keys__delete__portal ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND state = 'in_progress');
CREATE POLICY idempotency_keys__select__patient ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient');
CREATE POLICY idempotency_keys__insert__patient ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient');
CREATE POLICY idempotency_keys__update__patient ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient');
CREATE POLICY idempotency_keys__delete__patient ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND state = 'in_progress');
CREATE POLICY idempotency_keys__select__platform ON core.idempotency_keys FOR SELECT TO lims_app
  USING (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()));
CREATE POLICY idempotency_keys__insert__platform ON core.idempotency_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()));
CREATE POLICY idempotency_keys__update__platform ON core.idempotency_keys FOR UPDATE TO lims_app
  USING (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()))
  WITH CHECK (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()));
CREATE POLICY idempotency_keys__delete__platform ON core.idempotency_keys FOR DELETE TO lims_app
  USING (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()) AND state = 'in_progress');
CREATE POLICY idempotency_keys__delete__owner_only ON core.idempotency_keys FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_idempotency_keys' AND expires_at < now());
CREATE POLICY idempotency_keys__select__owner_only ON core.idempotency_keys FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_idempotency_keys' AND expires_at < now());
CREATE POLICY event_log__select__owner_only ON core.event_log FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_log' AND created_at < now() - interval '90 days');
CREATE POLICY event_log__delete__owner_only ON core.event_log FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_log' AND created_at < now() - interval '90 days');
CREATE POLICY dead_letters__select__owner_only ON core.dead_letters FOR SELECT TO lims_owner
  USING (tenant_id IS NULL
      OR (current_setting('app.maintenance', true) = 'purge_dead_letters'
          AND state <> 'open' AND resolved_at < now() - interval '90 days'));
CREATE POLICY dead_letters__delete__owner_only ON core.dead_letters FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_dead_letters'
         AND state <> 'open' AND resolved_at < now() - interval '90 days');
CREATE POLICY dead_letters__insert__owner_only ON core.dead_letters FOR INSERT TO lims_owner WITH CHECK (tenant_id IS NULL);
CREATE POLICY dead_letters__update__owner_only ON core.dead_letters FOR UPDATE TO lims_owner
  USING (tenant_id IS NULL) WITH CHECK (tenant_id IS NULL);
CREATE POLICY dead_letters__select__platform ON core.dead_letters FOR SELECT TO lims_app
  USING (tenant_id IS NOT NULL AND (SELECT app.is_platform_actor()));
CREATE POLICY dead_letters__update__platform ON core.dead_letters FOR UPDATE TO lims_app
  USING (tenant_id IS NOT NULL AND (SELECT app.is_platform_actor()))
  WITH CHECK (tenant_id IS NOT NULL AND (SELECT app.is_platform_actor()));

-- from 20261105001400_core__create_tenant_platform_policies.sql (C2 05-SCHEMA §10.2)
CREATE POLICY tenants__select__platform ON core.tenants FOR SELECT TO lims_app USING ((SELECT app.is_platform_actor()));
CREATE POLICY tenants__insert__platform ON core.tenants FOR INSERT TO lims_app WITH CHECK ((SELECT app.is_platform_actor()));
CREATE POLICY tenants__update__platform ON core.tenants FOR UPDATE TO lims_app
  USING ((SELECT app.is_platform_actor())) WITH CHECK ((SELECT app.is_platform_actor()));
