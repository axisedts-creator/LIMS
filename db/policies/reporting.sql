-- T0B-10.C6: canonical CREATE POLICY set for reporting.* (C6 05-SCHEMA §6.1 + §6.2; AC-0B-2.3). Copied from
-- db/migrations/20261105001900_reporting__create_reporting_schema.sql (source of truth); CI diffs pg_policies against this file.
-- __tenant / __tenant_centre carry (SELECT app.is_staff_or_system()) (08 A17 P-16). reporting.event_inbox policies are C0's.
CREATE POLICY settings__select__portal ON reporting.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session');
CREATE POLICY settings__select__tenant ON reporting.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__insert__tenant ON reporting.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__update__tenant ON reporting.settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY staff_assignments__select__tenant ON reporting.staff_assignments FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY staff_assignments__insert__tenant ON reporting.staff_assignments FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY staff_assignments__update__tenant ON reporting.staff_assignments FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY centre_contacts__select__tenant_centre ON reporting.centre_contacts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY centre_contacts__insert__tenant_centre ON reporting.centre_contacts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY centre_contacts__update__tenant_centre ON reporting.centre_contacts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY referrer_preferences__select__tenant ON reporting.referrer_preferences FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY referrer_preferences__insert__tenant ON reporting.referrer_preferences FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY referrer_preferences__update__tenant ON reporting.referrer_preferences FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY channel_accounts__select__tenant ON reporting.channel_accounts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY channel_accounts__insert__tenant ON reporting.channel_accounts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY channel_accounts__update__tenant ON reporting.channel_accounts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY message_template_texts__select__tenant ON reporting.message_template_texts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY message_template_texts__insert__tenant ON reporting.message_template_texts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY message_template_texts__update__tenant ON reporting.message_template_texts FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_templates__select__tenant ON reporting.report_templates FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_templates__insert__tenant ON reporting.report_templates FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_templates__update__tenant ON reporting.report_templates FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_template_versions__select__tenant ON reporting.report_template_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_template_versions__insert__tenant ON reporting.report_template_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY report_template_versions__update__tenant ON reporting.report_template_versions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY narrative_templates__select__tenant ON reporting.narrative_templates FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY narrative_templates__insert__tenant ON reporting.narrative_templates FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY narrative_templates__update__tenant ON reporting.narrative_templates FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_reasons__select__tenant ON reporting.cs_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_reasons__insert__tenant ON reporting.cs_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY cs_reasons__update__tenant ON reporting.cs_reasons FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY reports__select__tenant_centre ON reporting.reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY reports__insert__tenant_centre ON reporting.reports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY reports__update__tenant_centre ON reporting.reports FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY reports__select__portal ON reporting.reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session'
         AND id = (SELECT nullif(app.current_claims() ->> 'portal_report_id', '')::uuid));
CREATE POLICY reports__select__partner ON reporting.reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id())
         AND EXISTS (SELECT 1 FROM reporting.report_versions v WHERE v.tenant_id = reports.tenant_id
                     AND v.report_id = reports.id AND v.status IN ('released','superseded')));
CREATE POLICY reports__select__patient ON reporting.reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[])
         AND EXISTS (SELECT 1 FROM reporting.report_versions v WHERE v.tenant_id = reports.tenant_id
                     AND v.report_id = reports.id AND v.status IN ('released','superseded')));
CREATE POLICY report_order_items__select__tenant_centre ON reporting.report_order_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY report_order_items__insert__tenant_centre ON reporting.report_order_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY report_order_items__update__tenant_centre ON reporting.report_order_items FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY report_versions__select__portal ON reporting.report_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session'
         AND (SELECT app.current_claims() ->> 'portal_link_purpose') = 'report'
         AND report_id = (SELECT nullif(app.current_claims() ->> 'portal_report_id', '')::uuid)
         AND status IN ('released','superseded'));
CREATE POLICY report_versions__select__partner ON reporting.report_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND status IN ('released','superseded')
         AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY report_versions__select__patient ON reporting.report_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND status IN ('released','superseded')
         AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[]));
CREATE POLICY report_versions__select__tenant_centre ON reporting.report_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY report_versions__insert__tenant_centre ON reporting.report_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY report_versions__update__tenant_centre ON reporting.report_versions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY qr_tokens__select__portal ON reporting.qr_tokens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session'
         AND (SELECT app.current_claims() ->> 'portal_link_purpose') = 'report'
         AND report_id = (SELECT nullif(app.current_claims() ->> 'portal_report_id', '')::uuid));
CREATE POLICY qr_tokens__select__partner ON reporting.qr_tokens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND report_version_id IN (SELECT v.id FROM reporting.report_versions v WHERE v.tenant_id = qr_tokens.tenant_id
                                   AND v.status IN ('released','superseded') AND v.partner_id = (SELECT app.current_partner_id())));
CREATE POLICY qr_tokens__select__patient ON reporting.qr_tokens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND report_version_id IN (SELECT v.id FROM reporting.report_versions v WHERE v.tenant_id = qr_tokens.tenant_id
                                   AND v.status IN ('released','superseded') AND v.patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[])));
CREATE POLICY qr_tokens__select__tenant_centre ON reporting.qr_tokens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY qr_tokens__insert__tenant_centre ON reporting.qr_tokens FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY qr_tokens__update__tenant_centre ON reporting.qr_tokens FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY deliveries__select__tenant_centre ON reporting.deliveries FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY deliveries__insert__tenant_centre ON reporting.deliveries FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY deliveries__update__tenant_centre ON reporting.deliveries FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY portal_links__select__portal ON reporting.portal_links FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND id = (SELECT app.current_actor_id()));
CREATE POLICY portal_links__update__portal ON reporting.portal_links FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND id = (SELECT app.current_actor_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND id = (SELECT app.current_actor_id()));
CREATE POLICY portal_links__select__tenant_centre ON reporting.portal_links FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY portal_links__insert__tenant_centre ON reporting.portal_links FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY portal_links__update__tenant_centre ON reporting.portal_links FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY otp_challenges__select__portal ON reporting.otp_challenges FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY otp_challenges__insert__portal ON reporting.otp_challenges FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY otp_challenges__update__portal ON reporting.otp_challenges FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY otp_challenges__select__tenant_system ON reporting.otp_challenges FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY otp_challenges__update__tenant_system ON reporting.otp_challenges FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY otp_challenges__delete__tenant_expired ON reporting.otp_challenges FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system'
         AND expires_at < now() - interval '24 hours');
CREATE POLICY portal_sessions__select__portal ON reporting.portal_sessions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY portal_sessions__insert__portal ON reporting.portal_sessions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY portal_sessions__update__portal ON reporting.portal_sessions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY portal_sessions__select__tenant_system ON reporting.portal_sessions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY portal_sessions__update__tenant_system ON reporting.portal_sessions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY portal_sessions__delete__tenant_expired ON reporting.portal_sessions FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system' AND coalesce(ended_at, absolute_expires_at) < now() - interval '24 hours');
CREATE POLICY delivery_attempts__select__tenant ON reporting.delivery_attempts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY delivery_attempts__insert__tenant ON reporting.delivery_attempts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY provider_events__select__tenant ON reporting.provider_events FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY provider_events__insert__tenant ON reporting.provider_events FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY provider_events__update__tenant ON reporting.provider_events FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY narrative_reports__select__tenant_centre ON reporting.narrative_reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY narrative_reports__insert__tenant_centre ON reporting.narrative_reports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY narrative_reports__update__tenant_centre ON reporting.narrative_reports FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY input_files__select__tenant_centre ON reporting.input_files FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY input_files__insert__tenant_centre ON reporting.input_files FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY input_files__update__tenant_centre ON reporting.input_files FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY narrative_versions__select__tenant_centre ON reporting.narrative_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY narrative_versions__insert__tenant_centre ON reporting.narrative_versions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY narrative_versions__update__tenant_centre ON reporting.narrative_versions FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY print_jobs__select__tenant_centre ON reporting.print_jobs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY print_jobs__insert__tenant_centre ON reporting.print_jobs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY print_jobs__update__tenant_centre ON reporting.print_jobs FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY print_jobs__delete__tenant_expired ON reporting.print_jobs FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
CREATE POLICY portal_payment_requests__select__portal ON reporting.portal_payment_requests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY portal_payment_requests__insert__portal ON reporting.portal_payment_requests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
              AND (SELECT app.current_claims() ->> 'portal_stage') = 'session' AND link_id = (SELECT app.current_actor_id())
              AND report_id = (SELECT nullif(app.current_claims() ->> 'portal_report_id', '')::uuid)
              AND EXISTS (SELECT 1 FROM reporting.reports r WHERE r.tenant_id = portal_payment_requests.tenant_id
                          AND r.id = portal_payment_requests.report_id AND r.order_id = portal_payment_requests.order_id));
CREATE POLICY portal_payment_requests__select__tenant_system ON reporting.portal_payment_requests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY portal_payment_requests__update__tenant_system ON reporting.portal_payment_requests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY portal_payment_requests__delete__tenant_expired ON reporting.portal_payment_requests FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
-- §6.2 lookup / owner_only policies (TO lims_reporting_lookup, bound to app.pre_* GUCs — 08 A21.4, A13 D-30)
CREATE POLICY qr_tokens__select__lookup ON reporting.qr_tokens FOR SELECT TO lims_reporting_lookup
  USING (token_sha256 = decode(nullif(current_setting('app.pre_qr_token_sha256', true), ''), 'hex'));
CREATE POLICY report_versions__select__lookup ON reporting.report_versions FOR SELECT TO lims_reporting_lookup
  USING (id IN (SELECT q.report_version_id FROM reporting.qr_tokens q
                WHERE q.token_sha256 = decode(nullif(current_setting('app.pre_qr_token_sha256', true), ''), 'hex')));
CREATE POLICY portal_links__select__lookup ON reporting.portal_links FOR SELECT TO lims_reporting_lookup
  USING (token_sha256 = decode(nullif(current_setting('app.pre_portal_credential_sha256', true), ''), 'hex'));
CREATE POLICY portal_links__select__owner_only ON reporting.portal_links FOR SELECT TO lims_reporting_lookup
  USING (token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex'));
CREATE POLICY portal_links__update__owner_only ON reporting.portal_links FOR UPDATE TO lims_reporting_lookup
  USING      (token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex'))
  WITH CHECK (token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex'));
CREATE POLICY reports__select__owner_only ON reporting.reports FOR SELECT TO lims_reporting_lookup
  USING (id IN (SELECT l.report_id FROM reporting.portal_links l
                WHERE l.token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex')));
CREATE POLICY report_versions__select__owner_only ON reporting.report_versions FOR SELECT TO lims_reporting_lookup
  USING (report_id IN (SELECT l.report_id FROM reporting.portal_links l
                WHERE l.token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex')));
CREATE POLICY deliveries__select__owner_only ON reporting.deliveries FOR SELECT TO lims_reporting_lookup
  USING (id IN (SELECT l.delivery_id FROM reporting.portal_links l
                WHERE l.token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex')));
CREATE POLICY portal_sessions__select__lookup ON reporting.portal_sessions FOR SELECT TO lims_reporting_lookup
  USING (token_sha256 = decode(nullif(current_setting('app.pre_portal_credential_sha256', true), ''), 'hex'));
CREATE POLICY channel_accounts__select__lookup ON reporting.channel_accounts FOR SELECT TO lims_reporting_lookup
  USING (callback_token_sha256 = decode(nullif(current_setting('app.pre_callback_token_sha256', true), ''), 'hex'));
CREATE POLICY provider_events__insert__lookup ON reporting.provider_events FOR INSERT TO lims_reporting_lookup
  WITH CHECK (tenant_id = nullif(current_setting('app.pre_callback_tenant_id', true), '')::uuid
              AND channel_account_id = nullif(current_setting('app.pre_callback_channel_account_id', true), '')::uuid);
CREATE POLICY provider_events__select__lookup ON reporting.provider_events FOR SELECT TO lims_reporting_lookup
  USING (tenant_id = nullif(current_setting('app.pre_callback_tenant_id', true), '')::uuid
         AND channel_account_id = nullif(current_setting('app.pre_callback_channel_account_id', true), '')::uuid);
