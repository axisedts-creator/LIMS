-- T0B-10.C8: canonical CREATE POLICY set for analytics.* (C8 05-SCHEMA §3 / §6; AC-0B-2.3). Copied from
-- db/migrations/20261105002100_analytics__create_analytics_schema.sql (source of truth); CI diffs pg_policies against this file.
-- The §6 DO block is expanded literally; pred_c carries the staff guard (08 A17 P-16). No policy on the class G g_cs_* tables.
CREATE POLICY daily_orders__select__tenant_centre ON analytics.daily_orders FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_orders__insert__tenant ON analytics.daily_orders FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_orders__delete__tenant ON analytics.daily_orders FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_centre_volume__select__tenant_centre ON analytics.daily_centre_volume FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_centre_volume__insert__tenant ON analytics.daily_centre_volume FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_centre_volume__delete__tenant ON analytics.daily_centre_volume FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_referrer_volume__select__tenant_centre ON analytics.daily_referrer_volume FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_referrer_volume__insert__tenant ON analytics.daily_referrer_volume FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_referrer_volume__delete__tenant ON analytics.daily_referrer_volume FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_income__select__tenant_centre ON analytics.daily_income FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_income__insert__tenant ON analytics.daily_income FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_income__delete__tenant ON analytics.daily_income FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_department_income__select__tenant_centre ON analytics.daily_department_income FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_department_income__insert__tenant ON analytics.daily_department_income FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_department_income__delete__tenant ON analytics.daily_department_income FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_collections__select__tenant_centre ON analytics.daily_collections FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_collections__insert__tenant ON analytics.daily_collections FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_collections__delete__tenant ON analytics.daily_collections FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_referrer_billing__select__tenant_centre ON analytics.daily_referrer_billing FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_referrer_billing__insert__tenant ON analytics.daily_referrer_billing FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_referrer_billing__delete__tenant ON analytics.daily_referrer_billing FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_results__select__tenant_centre ON analytics.daily_results FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_results__insert__tenant ON analytics.daily_results FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_results__delete__tenant ON analytics.daily_results FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_specimens__select__tenant_centre ON analytics.daily_specimens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_specimens__insert__tenant ON analytics.daily_specimens FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_specimens__delete__tenant ON analytics.daily_specimens FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_rejections__select__tenant_centre ON analytics.daily_rejections FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_rejections__insert__tenant ON analytics.daily_rejections FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_rejections__delete__tenant ON analytics.daily_rejections FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_critical_values__select__tenant_centre ON analytics.daily_critical_values FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_critical_values__insert__tenant ON analytics.daily_critical_values FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_critical_values__delete__tenant ON analytics.daily_critical_values FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY tat_facts__select__tenant_centre ON analytics.tat_facts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY tat_facts__insert__tenant ON analytics.tat_facts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY tat_facts__delete__tenant ON analytics.tat_facts FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_releases__select__tenant_centre ON analytics.daily_releases FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_releases__insert__tenant ON analytics.daily_releases FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_releases__delete__tenant ON analytics.daily_releases FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_deliveries__select__tenant_centre ON analytics.daily_deliveries FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_deliveries__insert__tenant ON analytics.daily_deliveries FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_deliveries__delete__tenant ON analytics.daily_deliveries FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_interface_messages__select__tenant_centre ON analytics.daily_interface_messages FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY daily_interface_messages__insert__tenant ON analytics.daily_interface_messages FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY daily_interface_messages__delete__tenant ON analytics.daily_interface_messages FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY report_backlog__select__tenant_centre ON analytics.report_backlog FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY report_backlog__insert__tenant ON analytics.report_backlog FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY report_backlog__delete__tenant ON analytics.report_backlog FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY refresh_state__select__tenant ON analytics.refresh_state FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY refresh_state__insert__tenant ON analytics.refresh_state FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY refresh_state__insert__tenant_manual ON analytics.refresh_state FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND family = '_manual');
CREATE POLICY refresh_state__update__tenant ON analytics.refresh_state FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY refresh_state__update__tenant_manual ON analytics.refresh_state FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND family = '_manual')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND family = '_manual');
CREATE POLICY dirty_partitions__select__tenant ON analytics.dirty_partitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY dirty_partitions__insert__tenant ON analytics.dirty_partitions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY dirty_partitions__update__tenant ON analytics.dirty_partitions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY dirty_partitions__delete__tenant ON analytics.dirty_partitions FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY refresh_runs__select__tenant ON analytics.refresh_runs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY refresh_runs__insert__tenant ON analytics.refresh_runs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY refresh_runs__update__tenant ON analytics.refresh_runs FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY refresh_runs__delete__tenant ON analytics.refresh_runs FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
CREATE POLICY order_index__select__tenant ON analytics.order_index FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY order_index__insert__tenant ON analytics.order_index FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY order_index__update__tenant ON analytics.order_index FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY order_index__delete__tenant ON analytics.order_index FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
CREATE POLICY schedules__select__tenant ON analytics.schedules FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY schedules__insert__tenant ON analytics.schedules FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY schedules__update__tenant ON analytics.schedules FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY schedule_recipients__select__tenant ON analytics.schedule_recipients FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY schedule_recipients__insert__tenant ON analytics.schedule_recipients FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY schedule_recipients__update__tenant ON analytics.schedule_recipients FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY exports__select__tenant ON analytics.exports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.current_actor_type()) = 'system'
              OR requested_by_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid)));
CREATE POLICY exports__insert__tenant ON analytics.exports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND status = 'queued'
              AND requested_by_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid));
CREATE POLICY exports__update__tenant ON analytics.exports FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.current_actor_type()) = 'system'
              OR requested_by_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid)))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.current_actor_type()) = 'system'
              OR requested_by_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid)));
CREATE POLICY exports__delete__tenant ON analytics.exports FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND requested_at < now() - interval '400 days');
CREATE POLICY export_files__select__tenant ON analytics.export_files FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.current_actor_type()) = 'system'
              OR EXISTS (SELECT 1 FROM analytics.exports e
                         WHERE e.tenant_id = export_files.tenant_id AND e.id = export_files.export_id
                           AND e.requested_by_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid))));
CREATE POLICY export_files__insert__tenant ON analytics.export_files FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY export_files__delete__tenant ON analytics.export_files FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY report_runs__select__tenant ON analytics.report_runs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.current_actor_type()) = 'system'
              OR EXISTS (SELECT 1 FROM analytics.report_run_recipients r
                         WHERE r.tenant_id = report_runs.tenant_id AND r.report_run_id = report_runs.id
                           AND r.membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid))
              OR EXISTS (SELECT 1 FROM analytics.schedules s
                         WHERE s.tenant_id = report_runs.tenant_id AND s.id = report_runs.schedule_id
                           AND s.owner_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid))));
CREATE POLICY report_runs__insert__tenant ON analytics.report_runs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY report_runs__update__tenant ON analytics.report_runs FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY report_runs__delete__tenant ON analytics.report_runs FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
CREATE POLICY report_run_recipients__select__tenant ON analytics.report_run_recipients FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.current_actor_type()) = 'system'
              OR membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid)
              OR EXISTS (SELECT 1 FROM analytics.schedules s
                         WHERE s.tenant_id = report_run_recipients.tenant_id AND s.id = report_run_recipients.schedule_id
                           AND s.owner_membership_id = (SELECT nullif(app.current_claims() ->> 'membership_id', '')::uuid))));
CREATE POLICY report_run_recipients__insert__tenant ON analytics.report_run_recipients FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY report_run_recipients__delete__tenant ON analytics.report_run_recipients FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
