-- T0B-04: canonical CREATE POLICY set for audit.* tables (05-SCHEMA §3.6, §6, §10; 08 A12.5, A23.3, A28.5, A28.6; AC-0B-2.3).
-- Copied from db/migrations/20261105000600_audit__create_audit_tables.sql, the source of truth; CI diffs pg_policies against this
-- file. Append-only: no UPDATE/DELETE policy. audit.g_cs_access_actions is class G (no RLS, no policy).

-- from 20261105000600_audit__create_audit_tables.sql
CREATE POLICY audit_log__select__tenant ON audit.audit_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())            -- guard added (08 A23.3)
         AND (centre_id IS NULL OR (SELECT app.has_all_centres())                                     -- CR-C2-010 centre clause,
              OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));                        -- cast form (08 A28.6, A16.1)
CREATE POLICY audit_log__insert__owner_only ON audit.audit_log FOR INSERT TO lims_owner
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id())
           OR ((SELECT app.current_tenant_id()) IS NULL                                   -- 08 A12.5: a core.tenants change in
               AND schema_name = 'core' AND table_name = 'tenants' AND row_id = tenant_id  -- platform context, audited under the
               AND (SELECT app.is_platform_actor()))                                      -- tenant row's own id
           OR ((SELECT app.current_actor_id()) IS NULL                                    -- 08 A28.5: a row changed inside a
               AND actor_id IS NULL AND actor_type = 'system'                             -- maintenance DEFINER (no claims),
               AND nullif(current_setting('app.maintenance', true), '') IS NOT NULL       -- audited under the row's tenant_id
               AND detail ->> 'maintenance' = current_setting('app.maintenance', true)));

CREATE POLICY access_log__select__tenant ON audit.access_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (centre_id IS NULL OR (SELECT app.has_all_centres())                                     -- CR-C2-010 centre clause
              OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));                        -- (08 A28.6, A16.1)
CREATE POLICY access_log__insert__tenant ON audit.access_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND (centre_id IS NULL OR (SELECT app.has_all_centres())                                -- LD-21 (CR-C0-T0B-08 item 2)
                   OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));                   -- centre clause on INSERT (08 A16.1)
CREATE POLICY access_log__insert__partner ON audit.access_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'partner');
CREATE POLICY access_log__insert__portal ON audit.access_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'portal');
CREATE POLICY access_log__insert__patient ON audit.access_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND actor_id = (SELECT app.current_actor_id())
              AND (SELECT app.current_actor_type()) = 'patient');
