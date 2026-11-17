-- T0B-13.C18: canonical CREATE POLICY set for migration_staging.* (C18 05-SCHEMA §5; AC-0B-2.3).
-- Copied from db/migrations/20261115180000_migration_staging__create_migration_staging_schema.sql (source of truth); CI diffs pg_policies against this file.
-- 53 policies, all TO lims_migration (PROPOSED EXCEPTION §1.2): select + insert on 16 tables, update on 12, purge delete on 8, issues delete.
CREATE POLICY runs__select__tenant ON migration_staging.runs FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY runs__insert__tenant ON migration_staging.runs FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY runs__update__tenant ON migration_staging.runs FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY run_events__select__tenant ON migration_staging.run_events FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY run_events__insert__tenant ON migration_staging.run_events FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY run_files__select__tenant ON migration_staging.run_files FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY run_files__insert__tenant ON migration_staging.run_files FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY run_files__update__tenant ON migration_staging.run_files FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY crosswalk_entries__select__tenant ON migration_staging.crosswalk_entries FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY crosswalk_entries__insert__tenant ON migration_staging.crosswalk_entries FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY crosswalk_entries__update__tenant ON migration_staging.crosswalk_entries FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY batches__select__tenant ON migration_staging.batches FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY batches__insert__tenant ON migration_staging.batches FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY batches__update__tenant ON migration_staging.batches FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reports__select__tenant ON migration_staging.reports FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reports__insert__tenant ON migration_staging.reports FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY signoffs__select__tenant ON migration_staging.signoffs FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY signoffs__insert__tenant ON migration_staging.signoffs FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_patients__select__tenant ON migration_staging.stg_patients FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_patients__insert__tenant ON migration_staging.stg_patients FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_patients__update__tenant ON migration_staging.stg_patients FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_patients__delete__tenant ON migration_staging.stg_patients FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = stg_patients.tenant_id AND r.id = stg_patients.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
CREATE POLICY stg_visits__select__tenant ON migration_staging.stg_visits FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_visits__insert__tenant ON migration_staging.stg_visits FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_visits__update__tenant ON migration_staging.stg_visits FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_visits__delete__tenant ON migration_staging.stg_visits FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = stg_visits.tenant_id AND r.id = stg_visits.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
CREATE POLICY stg_results__select__tenant ON migration_staging.stg_results FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_results__insert__tenant ON migration_staging.stg_results FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_results__update__tenant ON migration_staging.stg_results FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_results__delete__tenant ON migration_staging.stg_results FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = stg_results.tenant_id AND r.id = stg_results.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
CREATE POLICY stg_documents__select__tenant ON migration_staging.stg_documents FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_documents__insert__tenant ON migration_staging.stg_documents FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_documents__update__tenant ON migration_staging.stg_documents FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_documents__delete__tenant ON migration_staging.stg_documents FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = stg_documents.tenant_id AND r.id = stg_documents.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
CREATE POLICY stg_financial__select__tenant ON migration_staging.stg_financial FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_financial__insert__tenant ON migration_staging.stg_financial FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_financial__update__tenant ON migration_staging.stg_financial FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_financial__delete__tenant ON migration_staging.stg_financial FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = stg_financial.tenant_id AND r.id = stg_financial.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
CREATE POLICY stg_masters__select__tenant ON migration_staging.stg_masters FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_masters__insert__tenant ON migration_staging.stg_masters FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_masters__update__tenant ON migration_staging.stg_masters FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY stg_masters__delete__tenant ON migration_staging.stg_masters FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = stg_masters.tenant_id AND r.id = stg_masters.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
CREATE POLICY match_pairs__select__tenant ON migration_staging.match_pairs FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY match_pairs__insert__tenant ON migration_staging.match_pairs FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY match_pairs__update__tenant ON migration_staging.match_pairs FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY match_pairs__delete__tenant ON migration_staging.match_pairs FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = match_pairs.tenant_id AND r.id = match_pairs.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
CREATE POLICY issues__select__tenant ON migration_staging.issues FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY issues__insert__tenant ON migration_staging.issues FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY issues__delete__tenant ON migration_staging.issues FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY samples__select__tenant ON migration_staging.samples FOR SELECT TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY samples__insert__tenant ON migration_staging.samples FOR INSERT TO lims_migration
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY samples__update__tenant ON migration_staging.samples FOR UPDATE TO lims_migration
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY samples__delete__tenant ON migration_staging.samples FOR DELETE TO lims_migration
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND EXISTS (SELECT 1 FROM migration_staging.runs r
                     WHERE r.tenant_id = samples.tenant_id AND r.id = samples.run_id
                       AND r.status IN ('signed_off','voided','voided_partial','abandoned')
                       AND (r.purge_not_before IS NULL OR r.purge_not_before <= now()
                            OR EXISTS (SELECT 1 FROM migration_staging.signoffs s
                                       WHERE s.tenant_id = r.tenant_id AND s.run_id = r.id AND s.kind = 'early_purge_approval'))));
