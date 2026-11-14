-- T0B-10.C5: canonical CREATE POLICY set for lab.* (C5 05-SCHEMA §3.1, DO block expanded; AC-0B-2.3). Copied from
-- db/migrations/20261105001800_lab__create_lab_schema.sql (source of truth); CI diffs pg_policies against this file.
-- Every policy carries (SELECT app.is_staff_or_system()) (08 A17 P-16). lab.event_inbox policies are C0's (20261105001000).
CREATE POLICY specimens__select__tenant_centre ON lab.specimens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimens__insert__tenant_centre ON lab.specimens FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimens__update__tenant_centre ON lab.specimens FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY order_tests__select__tenant_centre ON lab.order_tests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY order_tests__insert__tenant_centre ON lab.order_tests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY order_tests__update__tenant_centre ON lab.order_tests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY results__select__tenant_centre ON lab.results FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY results__insert__tenant_centre ON lab.results FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY results__update__tenant_centre ON lab.results FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY result_versions__select__tenant_centre ON lab.result_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY result_versions__insert__tenant_centre ON lab.result_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY result_versions__update__tenant_centre ON lab.result_versions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_value_log__select__tenant_centre ON lab.critical_value_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_value_log__insert__tenant_centre ON lab.critical_value_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_value_log__update__tenant_centre ON lab.critical_value_log FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY worksheets__select__tenant_centre ON lab.worksheets FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY worksheets__insert__tenant_centre ON lab.worksheets FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY worksheets__update__tenant_centre ON lab.worksheets FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ingest_exceptions__select__tenant_centre ON lab.ingest_exceptions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ingest_exceptions__insert__tenant_centre ON lab.ingest_exceptions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ingest_exceptions__update__tenant_centre ON lab.ingest_exceptions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ingest_log__select__tenant_centre ON lab.ingest_log FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ingest_log__insert__tenant_centre ON lab.ingest_log FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ingest_log__update__tenant_centre ON lab.ingest_log FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimen_transitions__select__tenant_centre ON lab.specimen_transitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimen_transitions__insert__tenant_centre ON lab.specimen_transitions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY result_observations__select__tenant_centre ON lab.result_observations FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY result_observations__insert__tenant_centre ON lab.result_observations FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY result_attachments__select__tenant_centre ON lab.result_attachments FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY result_attachments__insert__tenant_centre ON lab.result_attachments FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY verifications__select__tenant_centre ON lab.verifications FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY verifications__insert__tenant_centre ON lab.verifications FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY approvals__select__tenant_centre ON lab.approvals FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY approvals__insert__tenant_centre ON lab.approvals FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_notifications__select__tenant_centre ON lab.critical_notifications FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY critical_notifications__insert__tenant_centre ON lab.critical_notifications FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY worksheet_items__select__tenant_centre ON lab.worksheet_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY worksheet_items__insert__tenant_centre ON lab.worksheet_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]) OR processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY lab_settings__select__tenant ON lab.lab_settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY lab_settings__insert__tenant ON lab.lab_settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY lab_settings__update__tenant ON lab.lab_settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY barcode_counters__select__tenant ON lab.barcode_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY barcode_counters__insert__tenant ON lab.barcode_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY barcode_counters__update__tenant ON lab.barcode_counters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY delta_check_rules__select__tenant ON lab.delta_check_rules FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY delta_check_rules__insert__tenant ON lab.delta_check_rules FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY delta_check_rules__update__tenant ON lab.delta_check_rules FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY order_readiness__select__tenant ON lab.order_readiness FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY order_readiness__insert__tenant ON lab.order_readiness FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY order_readiness__update__tenant ON lab.order_readiness FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_holds__select__tenant ON lab.qc_holds FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_holds__insert__tenant ON lab.qc_holds FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_holds__update__tenant ON lab.qc_holds FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_rejection_reasons__select__tenant ON lab.cs_rejection_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_rejection_reasons__insert__tenant ON lab.cs_rejection_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_rejection_reasons__update__tenant ON lab.cs_rejection_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_return_reasons__select__tenant ON lab.cs_return_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_return_reasons__insert__tenant ON lab.cs_return_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_return_reasons__update__tenant ON lab.cs_return_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_amendment_reasons__select__tenant ON lab.cs_amendment_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_amendment_reasons__insert__tenant ON lab.cs_amendment_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_amendment_reasons__update__tenant ON lab.cs_amendment_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_exception_discard_reasons__select__tenant ON lab.cs_exception_discard_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_exception_discard_reasons__insert__tenant ON lab.cs_exception_discard_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_exception_discard_reasons__update__tenant ON lab.cs_exception_discard_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_releases__select__tenant ON lab.report_releases FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_releases__insert__tenant ON lab.report_releases FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY module_submissions__select__tenant ON lab.module_submissions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY module_submissions__insert__tenant ON lab.module_submissions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_results__select__tenant_centre ON lab.qc_results FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY qc_results__insert__tenant_centre ON lab.qc_results FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY orders__select__tenant_centre ON lab.orders FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])
         OR EXISTS (SELECT 1 FROM lab.specimens s
                    WHERE s.tenant_id = orders.tenant_id AND s.order_id = orders.id
                      AND s.processing_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))) AND (SELECT app.is_staff_or_system()));
CREATE POLICY orders__insert__tenant ON lab.orders FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.has_all_centres()));   -- only system consumers create
CREATE POLICY orders__update__tenant ON lab.orders FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.has_all_centres()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.has_all_centres()));
