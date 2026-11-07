-- T0B-10.C7: canonical CREATE POLICY set for instruments.* (C7 05-SCHEMA §5; AC-0B-2.3). Copied from
-- db/migrations/20261105002000_instruments__create_instruments_schema.sql (source of truth); CI diffs pg_policies against this file.
-- Centre template (02-CV §5.8) on the 16 centre tables (staff guard per 02-CV §5.8 / 08 A17 P-16; true for device, §1.1); settings __tenant with
-- app.is_staff_or_system(); owner_only policies TO lims_owner bound to app.pre_* / app.maintenance GUCs (08 A10.5, A12.1, A12.2).
CREATE POLICY agents__select__tenant_centre ON instruments.agents FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agents__insert__tenant_centre ON instruments.agents FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agents__update__tenant_centre ON instruments.agents FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_credentials__select__tenant_centre ON instruments.agent_credentials FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_credentials__insert__tenant_centre ON instruments.agent_credentials FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_credentials__update__tenant_centre ON instruments.agent_credentials FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_status__select__tenant_centre ON instruments.agent_status FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_status__insert__tenant_centre ON instruments.agent_status FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_status__update__tenant_centre ON instruments.agent_status FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_health_transitions__select__tenant_centre ON instruments.agent_health_transitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_health_transitions__insert__tenant_centre ON instruments.agent_health_transitions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_config_versions__select__tenant_centre ON instruments.agent_config_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_config_versions__insert__tenant_centre ON instruments.agent_config_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_commands__select__tenant_centre ON instruments.agent_commands FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_commands__insert__tenant_centre ON instruments.agent_commands FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_commands__update__tenant_centre ON instruments.agent_commands FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_log_bundles__select__tenant_centre ON instruments.agent_log_bundles FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY agent_log_bundles__insert__tenant_centre ON instruments.agent_log_bundles FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY instruments__select__tenant_centre ON instruments.instruments FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY instruments__insert__tenant_centre ON instruments.instruments FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY instruments__update__tenant_centre ON instruments.instruments FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY instrument_status__select__tenant_centre ON instruments.instrument_status FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY instrument_status__insert__tenant_centre ON instruments.instrument_status FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY instrument_status__update__tenant_centre ON instruments.instrument_status FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY messages__select__tenant_centre ON instruments.messages FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY messages__insert__tenant_centre ON instruments.messages FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY processing_runs__select__tenant_centre ON instruments.processing_runs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY processing_runs__insert__tenant_centre ON instruments.processing_runs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY message_records__select__tenant_centre ON instruments.message_records FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY message_records__insert__tenant_centre ON instruments.message_records FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY message_duplicates__select__tenant_centre ON instruments.message_duplicates FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY message_duplicates__insert__tenant_centre ON instruments.message_duplicates FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY message_rejections__select__tenant_centre ON instruments.message_rejections FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY message_rejections__insert__tenant_centre ON instruments.message_rejections FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY attachments__select__tenant_centre ON instruments.attachments FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY attachments__insert__tenant_centre ON instruments.attachments FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY attachments__update__tenant_centre ON instruments.attachments FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY observed_codes__select__tenant_centre ON instruments.observed_codes FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY observed_codes__insert__tenant_centre ON instruments.observed_codes FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY observed_codes__update__tenant_centre ON instruments.observed_codes FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY settings__select__tenant ON instruments.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__insert__tenant ON instruments.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__update__tenant ON instruments.settings FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY agent_credentials__select__owner_only ON instruments.agent_credentials FOR SELECT TO lims_owner
  USING (secret_sha256 = decode(nullif(current_setting('app.pre_device_secret_sha256', true), ''), 'hex'));
CREATE POLICY agents__select__owner_only ON instruments.agents FOR SELECT TO lims_owner
  USING (id = nullif(current_setting('app.pre_device_agent_id', true), '')::uuid
         OR current_setting('app.maintenance', true) = 'instruments_agent_state_snapshot');
CREATE POLICY agent_status__select__owner_only ON instruments.agent_status FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'instruments_agent_state_snapshot');
CREATE POLICY messages__select__owner_only ON instruments.messages FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY messages__delete__owner_only ON instruments.messages FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY processing_runs__select__owner_only ON instruments.processing_runs FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY processing_runs__delete__owner_only ON instruments.processing_runs FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY message_records__select__owner_only ON instruments.message_records FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY message_records__delete__owner_only ON instruments.message_records FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY message_duplicates__select__owner_only ON instruments.message_duplicates FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY message_duplicates__delete__owner_only ON instruments.message_duplicates FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY message_rejections__select__owner_only ON instruments.message_rejections FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY message_rejections__delete__owner_only ON instruments.message_rejections FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY attachments__select__owner_only ON instruments.attachments FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY attachments__delete__owner_only ON instruments.attachments FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY agent_log_bundles__select__owner_only ON instruments.agent_log_bundles FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY agent_log_bundles__delete__owner_only ON instruments.agent_log_bundles FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY agent_commands__select__owner_only ON instruments.agent_commands FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY agent_commands__delete__owner_only ON instruments.agent_commands FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY agent_health_transitions__select__owner_only ON instruments.agent_health_transitions FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY agent_health_transitions__delete__owner_only ON instruments.agent_health_transitions FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY observed_codes__select__owner_only ON instruments.observed_codes FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY observed_codes__delete__owner_only ON instruments.observed_codes FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_instruments_archive'
         AND tenant_id = (SELECT app.current_tenant_id()));
