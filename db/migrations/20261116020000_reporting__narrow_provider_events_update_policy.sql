-- T0B-PEVPOL-1 (LD-257, CR-C0-T0B-REVIEW-1-001, LD-232 item 2): narrow reporting.provider_events__update__tenant to the system actor
-- and to rows not yet applied (USING applied_at IS NULL, WITH CHECK applied_at IS NOT NULL), so a provider event is applied once, by the worker.
-- The lims_app UPDATE grant stays (C6-T29 apply task); the mutable-columns trigger still limits UPDATE to applied_at, delivery_id, ignored_reason.
-- Narrowing only: no DROP, REVOKE, GRANT, table, column, function, trigger or other policy change. Same text in db/policies/reporting.sql.
-- NOT RUN in the lane: this migration and db/tests/reporting/T0B-PEVPOL-1_provider_events_update.test.sql; founder runs db/tests/run-suites.sh before push-cloud.ps1.
SET LOCAL ROLE lims_owner;

ALTER POLICY provider_events__update__tenant ON reporting.provider_events
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system' AND applied_at IS NULL)
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system' AND applied_at IS NOT NULL);
