-- cr-approved-breaking: owner decision 2026-11-26 (PR 9) accepts the DROP in this already merged migration.
-- T0B-GREEN-3 / LD-365 (founder approved 2026-11-18 07:40 NPT; CR .orchestra/cr/T0B-GREEN-3.identity-platform-audit.nonblocking.md).
-- A platform-claims write (no tenant context) to one of four audited identity tables fires app.tg_row_audit (DEFINER), whose
-- audit row carries the target row's own tenant_id; the original policy (20261105000600) refused it. Same three clauses unchanged,
-- plus ONE new OR clause limited to exactly these four tables and to the platform actor writing under its own actor id.
-- lims_app keeps SELECT only (no grant change).
SET LOCAL ROLE lims_owner;

DROP POLICY audit_log__insert__owner_only ON audit.audit_log;
CREATE POLICY audit_log__insert__owner_only ON audit.audit_log FOR INSERT TO lims_owner
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id())
           OR ((SELECT app.current_tenant_id()) IS NULL                                   -- 08 A12.5: a core.tenants change in
               AND schema_name = 'core' AND table_name = 'tenants' AND row_id = tenant_id  -- platform context, audited under the
               AND (SELECT app.is_platform_actor()))                                      -- tenant row's own id
           OR ((SELECT app.current_actor_id()) IS NULL                                    -- 08 A28.5: a row changed inside a
               AND actor_id IS NULL AND actor_type = 'system'                             -- maintenance DEFINER (no claims),
               AND nullif(current_setting('app.maintenance', true), '') IS NOT NULL       -- audited under the row's tenant_id
               AND detail ->> 'maintenance' = current_setting('app.maintenance', true))
           OR ((SELECT app.current_tenant_id()) IS NULL                                   -- LD-365: platform write to one of four
               AND (SELECT app.is_platform_actor())                                       -- identity tables, audited under the
               AND actor_id = (SELECT app.current_actor_id())                             -- row's own tenant_id
               AND schema_name = 'identity'
               AND table_name IN ('support_sessions', 'ird_annex_records', 'feature_flags', 'tenant_settings')));
