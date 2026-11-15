-- T0B-13.C10: canonical CREATE POLICY set for micro.* (C10 05-SCHEMA §4, §8; AC-0B-2.3). Copied from
-- db/migrations/20261115100000_micro__create_micro_schema.sql (source of truth); CI diffs pg_policies against this file.
-- pred_c and the purge DELETE carry the staff guard [CONV] (08 A17 P-16, gate 9). No policy on the class G g_* tables.
CREATE POLICY cultures__select__tenant_centre ON micro.cultures FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cultures__insert__tenant_centre ON micro.cultures FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cultures__update__tenant_centre ON micro.cultures FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY culture_plates__select__tenant_centre ON micro.culture_plates FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY culture_plates__insert__tenant_centre ON micro.culture_plates FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY culture_plates__update__tenant_centre ON micro.culture_plates FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY isolates__select__tenant_centre ON micro.isolates FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY isolates__insert__tenant_centre ON micro.isolates FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY isolates__update__tenant_centre ON micro.isolates FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ast_results__select__tenant_centre ON micro.ast_results FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ast_results__insert__tenant_centre ON micro.ast_results FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ast_results__update__tenant_centre ON micro.ast_results FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_records__select__tenant_centre ON micro.instrument_records FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_records__insert__tenant_centre ON micro.instrument_records FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_records__update__tenant_centre ON micro.instrument_records FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY culture_transitions__select__tenant_centre ON micro.culture_transitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY culture_transitions__insert__tenant_centre ON micro.culture_transitions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY culture_observations__select__tenant_centre ON micro.culture_observations FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY culture_observations__insert__tenant_centre ON micro.culture_observations FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_versions__select__tenant_centre ON micro.report_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_versions__insert__tenant_centre ON micro.report_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__select__tenant ON micro.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__insert__tenant ON micro.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__update__tenant ON micro.settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY plating_protocols__select__tenant ON micro.plating_protocols FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY plating_protocols__insert__tenant ON micro.plating_protocols FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY plating_protocols__update__tenant ON micro.plating_protocols FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY plating_protocol_media__select__tenant ON micro.plating_protocol_media FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY plating_protocol_media__insert__tenant ON micro.plating_protocol_media FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY plating_protocol_media__update__tenant ON micro.plating_protocol_media FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY plating_protocol_keys__select__tenant ON micro.plating_protocol_keys FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY plating_protocol_keys__insert__tenant ON micro.plating_protocol_keys FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY plating_protocol_keys__update__tenant ON micro.plating_protocol_keys FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ast_panels__select__tenant ON micro.ast_panels FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ast_panels__insert__tenant ON micro.ast_panels FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ast_panels__update__tenant ON micro.ast_panels FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ast_panel_antibiotics__select__tenant ON micro.ast_panel_antibiotics FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ast_panel_antibiotics__insert__tenant ON micro.ast_panel_antibiotics FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY ast_panel_antibiotics__update__tenant ON micro.ast_panel_antibiotics FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_vocab_maps__select__tenant ON micro.instrument_vocab_maps FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_vocab_maps__insert__tenant ON micro.instrument_vocab_maps FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_vocab_maps__update__tenant ON micro.instrument_vocab_maps FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_ast_defaults__select__tenant ON micro.instrument_ast_defaults FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_ast_defaults__insert__tenant ON micro.instrument_ast_defaults FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY instrument_ast_defaults__update__tenant ON micro.instrument_ast_defaults FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY breakpoint_sets__select__tenant ON micro.breakpoint_sets FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY breakpoint_sets__insert__tenant ON micro.breakpoint_sets FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY breakpoint_sets__update__tenant ON micro.breakpoint_sets FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimen_isolate_counters__select__tenant ON micro.specimen_isolate_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimen_isolate_counters__insert__tenant ON micro.specimen_isolate_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY specimen_isolate_counters__update__tenant ON micro.specimen_isolate_counters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_organisms__select__tenant ON micro.cs_organisms FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_organisms__insert__tenant ON micro.cs_organisms FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_organisms__update__tenant ON micro.cs_organisms FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_organism_groups__select__tenant ON micro.cs_organism_groups FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_organism_groups__insert__tenant ON micro.cs_organism_groups FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_organism_groups__update__tenant ON micro.cs_organism_groups FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_antibiotics__select__tenant ON micro.cs_antibiotics FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_antibiotics__insert__tenant ON micro.cs_antibiotics FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_antibiotics__update__tenant ON micro.cs_antibiotics FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_media__select__tenant ON micro.cs_media FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_media__insert__tenant ON micro.cs_media FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_media__update__tenant ON micro.cs_media FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_specimen_sites__select__tenant ON micro.cs_specimen_sites FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_specimen_sites__insert__tenant ON micro.cs_specimen_sites FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_specimen_sites__update__tenant ON micro.cs_specimen_sites FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_growth_codes__select__tenant ON micro.cs_growth_codes FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_growth_codes__insert__tenant ON micro.cs_growth_codes FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_growth_codes__update__tenant ON micro.cs_growth_codes FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_culture_outcomes__select__tenant ON micro.cs_culture_outcomes FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_culture_outcomes__insert__tenant ON micro.cs_culture_outcomes FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_culture_outcomes__update__tenant ON micro.cs_culture_outcomes FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_isolate_withdraw_reasons__select__tenant ON micro.cs_isolate_withdraw_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_isolate_withdraw_reasons__insert__tenant ON micro.cs_isolate_withdraw_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_isolate_withdraw_reasons__update__tenant ON micro.cs_isolate_withdraw_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_culture_cancel_reasons__select__tenant ON micro.cs_culture_cancel_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_culture_cancel_reasons__insert__tenant ON micro.cs_culture_cancel_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_culture_cancel_reasons__update__tenant ON micro.cs_culture_cancel_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_record_ignore_reasons__select__tenant ON micro.cs_record_ignore_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_record_ignore_reasons__insert__tenant ON micro.cs_record_ignore_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_record_ignore_reasons__update__tenant ON micro.cs_record_ignore_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY breakpoint_rows__select__tenant ON micro.breakpoint_rows FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY breakpoint_rows__insert__tenant ON micro.breakpoint_rows FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY breakpoint_bands__select__tenant ON micro.breakpoint_bands FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY breakpoint_bands__insert__tenant ON micro.breakpoint_bands FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY breakpoint_import_issues__select__tenant ON micro.breakpoint_import_issues FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY breakpoint_import_issues__insert__tenant ON micro.breakpoint_import_issues FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
-- [CONV] staff guard added (08 A17 P-16, gate 9 check-registry; C5..C9 precedent); otherwise spec §8 text (D-65, P-18(c) purge).
CREATE POLICY instrument_records__delete__tenant_centre ON micro.instrument_records FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now() AND (SELECT app.is_staff_or_system()));
