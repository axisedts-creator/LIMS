-- T0B-13.C16: canonical CREATE POLICY set for engagement.* (C16 05-SCHEMA §5.2, §5.3, §6.5; AC-0B-2.3).
-- Copied from db/migrations/20261115160000_engagement__create_engagement_schema.sql (source of truth); CI diffs pg_policies against this file.
-- 162 policies TO lims_app (§5.2 matrix; scope names per the §5.3 lead note) + 13 owner policies TO lims_owner (§6.5).
-- No policy on the 3 g_cs_* tables (class G). engagement.event_inbox policies are T0B-05's.
CREATE POLICY settings__select__tenant ON engagement.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system','patient','device'));
CREATE POLICY settings__insert__tenant ON engagement.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY settings__update__tenant ON engagement.settings FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY accounts__select__tenant ON engagement.accounts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY accounts__select__patient_account ON engagement.accounts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND id = (SELECT app.engagement_account_id()));
CREATE POLICY accounts__select__preauth_account ON engagement.accounts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND (SELECT app.engagement_preauth_stage()) = 'pre_auth'
    AND phone_e164 = (SELECT c.phone_e164 FROM engagement.otp_challenges c WHERE c.tenant_id = accounts.tenant_id AND c.token_sha256 = (SELECT decode(app.current_claims() ->> 'otp_token_sha256', 'hex')) AND c.status = 'verified'));
CREATE POLICY accounts__insert__preauth_account ON engagement.accounts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND (SELECT app.engagement_preauth_stage()) = 'pre_auth'
    AND phone_e164 = (SELECT c.phone_e164 FROM engagement.otp_challenges c WHERE c.tenant_id = accounts.tenant_id AND c.token_sha256 = (SELECT decode(app.current_claims() ->> 'otp_token_sha256', 'hex')) AND c.status = 'verified'));
CREATE POLICY accounts__update__patient_account ON engagement.accounts FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND id = (SELECT app.engagement_account_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND id = (SELECT app.engagement_account_id()));
CREATE POLICY accounts__update__system ON engagement.accounts FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY accounts__update__preauth_account ON engagement.accounts FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND (SELECT app.engagement_preauth_stage()) = 'pre_auth'
    AND phone_e164 = (SELECT c.phone_e164 FROM engagement.otp_challenges c WHERE c.tenant_id = accounts.tenant_id AND c.token_sha256 = (SELECT decode(app.current_claims() ->> 'otp_token_sha256', 'hex')) AND c.status = 'verified'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND (SELECT app.engagement_preauth_stage()) = 'pre_auth'
    AND phone_e164 = (SELECT c.phone_e164 FROM engagement.otp_challenges c WHERE c.tenant_id = accounts.tenant_id AND c.token_sha256 = (SELECT decode(app.current_claims() ->> 'otp_token_sha256', 'hex')) AND c.status = 'verified'));
CREATE POLICY otp_challenges__select__preauth_token ON engagement.otp_challenges FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND (SELECT app.engagement_preauth_stage()) = 'pre_auth'
         AND token_sha256 = (SELECT decode(app.current_claims() ->> 'otp_token_sha256', 'hex')));
CREATE POLICY otp_challenges__select__system ON engagement.otp_challenges FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY otp_challenges__insert__preauth ON engagement.otp_challenges FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
              AND (SELECT app.engagement_preauth_stage()) = 'pre_auth');
CREATE POLICY otp_challenges__update__preauth_token ON engagement.otp_challenges FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
              AND (SELECT app.engagement_preauth_stage()) = 'pre_auth'
              AND token_sha256 = (SELECT decode(app.current_claims() ->> 'otp_token_sha256', 'hex')))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
              AND (SELECT app.engagement_preauth_stage()) = 'pre_auth'
              AND token_sha256 = (SELECT decode(app.current_claims() ->> 'otp_token_sha256', 'hex')));
CREATE POLICY otp_challenges__update__system ON engagement.otp_challenges FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY otp_challenges__delete__tenant ON engagement.otp_challenges FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now() - interval '24 hours');
CREATE POLICY link_codes__select__tenant ON engagement.link_codes FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY link_codes__insert__tenant ON engagement.link_codes FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND issued_by_membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid);
CREATE POLICY link_codes__update__tenant ON engagement.link_codes FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY link_codes__delete__tenant ON engagement.link_codes FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now() - interval '90 days'
         AND NOT EXISTS (SELECT 1 FROM engagement.account_patient_links l WHERE l.tenant_id = link_codes.tenant_id AND l.link_code_id = link_codes.id));
CREATE POLICY link_consents__select__tenant ON engagement.link_consents FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY link_consents__select__patient_account ON engagement.link_consents FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id())
    AND source = 'app');
CREATE POLICY link_consents__insert__tenant ON engagement.link_consents FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY link_consents__insert__patient_account ON engagement.link_consents FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id())
    AND source = 'app');
CREATE POLICY account_patient_links__select__tenant ON engagement.account_patient_links FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY account_patient_links__select__patient_account ON engagement.account_patient_links FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY account_patient_links__insert__patient_account ON engagement.account_patient_links FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id())
    AND ((method = 'link_code' AND app.engagement_code_redeemed_by_me(link_code_id, patient_id)) OR method = 'report_link'));
CREATE POLICY account_patient_links__insert__system ON engagement.account_patient_links FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY account_patient_links__update__patient_account ON engagement.account_patient_links FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY account_patient_links__update__tenant ON engagement.account_patient_links FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY account_patient_links__update__system ON engagement.account_patient_links FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY self_registrations__select__patient_account ON engagement.self_registrations FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY self_registrations__select__system ON engagement.self_registrations FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY self_registrations__insert__patient_account ON engagement.self_registrations FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY self_registrations__update__system ON engagement.self_registrations FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY addresses__select__patient_account ON engagement.addresses FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY addresses__select__tenant ON engagement.addresses FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY addresses__insert__patient_account ON engagement.addresses FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id())
    AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[]));
CREATE POLICY addresses__insert__tenant ON engagement.addresses FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY addresses__update__patient_account ON engagement.addresses FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id())
    AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[]))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id())
    AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[]));
CREATE POLICY addresses__update__tenant ON engagement.addresses FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY bookable_items__select__tenant ON engagement.bookable_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY bookable_items__select__patient ON engagement.bookable_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND (SELECT app.engagement_account_id()) IS NOT NULL
    AND is_active);
CREATE POLICY bookable_items__insert__tenant ON engagement.bookable_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY bookable_items__update__tenant ON engagement.bookable_items FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY booking_centres__select__tenant ON engagement.booking_centres FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY booking_centres__select__patient ON engagement.booking_centres FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND (SELECT app.engagement_account_id()) IS NOT NULL);
CREATE POLICY booking_centres__select__display ON engagement.booking_centres FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'device'
    AND (SELECT app.current_claims() ->> 'device_kind') = 'queue_display' AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]));
CREATE POLICY booking_centres__insert__system ON engagement.booking_centres FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY booking_centres__update__system ON engagement.booking_centres FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY slot_templates__select__tenant_centre ON engagement.slot_templates FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY slot_templates__select__patient ON engagement.slot_templates FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND (SELECT app.engagement_account_id()) IS NOT NULL
    AND is_active);
CREATE POLICY slot_templates__insert__tenant_centre ON engagement.slot_templates FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY slot_templates__update__tenant_centre ON engagement.slot_templates FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY slot_blackouts__select__tenant_centre ON engagement.slot_blackouts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY slot_blackouts__select__patient ON engagement.slot_blackouts FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND (SELECT app.engagement_account_id()) IS NOT NULL
    AND is_active);
CREATE POLICY slot_blackouts__insert__tenant_centre ON engagement.slot_blackouts FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY slot_blackouts__update__tenant_centre ON engagement.slot_blackouts FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY slot_occupancy__select__tenant_centre ON engagement.slot_occupancy FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY slot_occupancy__select__patient ON engagement.slot_occupancy FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND (SELECT app.engagement_account_id()) IS NOT NULL);
CREATE POLICY slot_occupancy__insert__tenant_centre ON engagement.slot_occupancy FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY slot_occupancy__insert__patient ON engagement.slot_occupancy FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND (SELECT app.engagement_account_id()) IS NOT NULL);
CREATE POLICY slot_occupancy__update__tenant_centre ON engagement.slot_occupancy FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY slot_occupancy__update__patient ON engagement.slot_occupancy FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND (SELECT app.engagement_account_id()) IS NOT NULL)
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND (SELECT app.engagement_account_id()) IS NOT NULL);
CREATE POLICY bookings__select__tenant_centre ON engagement.bookings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY bookings__select__patient_account ON engagement.bookings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY bookings__insert__tenant_centre ON engagement.bookings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY bookings__insert__patient_account ON engagement.bookings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
              AND account_id = (SELECT app.engagement_account_id())
              AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[]));
CREATE POLICY bookings__update__tenant_centre ON engagement.bookings FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY bookings__update__patient_account ON engagement.bookings FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
              AND account_id = (SELECT app.engagement_account_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
              AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY booking_items__select__tenant_centre ON engagement.booking_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY booking_items__select__patient_account ON engagement.booking_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY booking_items__insert__tenant_centre ON engagement.booking_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY booking_items__insert__patient_account ON engagement.booking_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY booking_transitions__select__tenant_centre ON engagement.booking_transitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY booking_transitions__select__patient_account ON engagement.booking_transitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY booking_transitions__insert__tenant_centre ON engagement.booking_transitions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY booking_transitions__insert__patient_account ON engagement.booking_transitions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY patient_orders__select__patient_visible ON engagement.patient_orders FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND app.engagement_patient_visible(patient_id, visible_at));
CREATE POLICY patient_orders__select__system ON engagement.patient_orders FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY patient_orders__insert__system ON engagement.patient_orders FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY patient_orders__update__system ON engagement.patient_orders FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY patient_orders__delete__system ON engagement.patient_orders FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY patient_order_specimens__select__patient ON engagement.patient_order_specimens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[]));
CREATE POLICY patient_order_specimens__select__system ON engagement.patient_order_specimens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY patient_order_specimens__insert__system ON engagement.patient_order_specimens FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY patient_order_specimens__update__system ON engagement.patient_order_specimens FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY patient_order_specimens__delete__system ON engagement.patient_order_specimens FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY patient_reports__select__patient_visible ON engagement.patient_reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND app.engagement_patient_visible(patient_id, released_at));
CREATE POLICY patient_reports__select__system ON engagement.patient_reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY patient_reports__insert__system ON engagement.patient_reports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY patient_reports__update__system ON engagement.patient_reports FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY patient_reports__delete__system ON engagement.patient_reports FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY smart_summaries__select__patient ON engagement.smart_summaries FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[]));
CREATE POLICY smart_summaries__select__system ON engagement.smart_summaries FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY smart_summaries__insert__system ON engagement.smart_summaries FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY smart_summaries__update__system ON engagement.smart_summaries FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY smart_summaries__delete__system ON engagement.smart_summaries FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY notifications__select__patient_account ON engagement.notifications FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY notifications__select__system ON engagement.notifications FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY notifications__insert__system ON engagement.notifications FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY notifications__update__patient_account ON engagement.notifications FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY notifications__update__system ON engagement.notifications FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY notifications__delete__tenant ON engagement.notifications FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
CREATE POLICY payment_requests__select__patient_account ON engagement.payment_requests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY payment_requests__select__system ON engagement.payment_requests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY payment_requests__insert__patient_account ON engagement.payment_requests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id())
    AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[]));
CREATE POLICY payment_requests__update__patient_account ON engagement.payment_requests FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY payment_requests__update__system ON engagement.payment_requests FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY queue_definitions__select__tenant_centre ON engagement.queue_definitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_definitions__select__display ON engagement.queue_definitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'device'
    AND (SELECT app.current_claims() ->> 'device_kind') = 'queue_display' AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]));
CREATE POLICY queue_definitions__insert__tenant_centre ON engagement.queue_definitions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_definitions__update__tenant_centre ON engagement.queue_definitions FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_counters__select__tenant_centre ON engagement.queue_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_counters__select__display ON engagement.queue_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'device'
    AND (SELECT app.current_claims() ->> 'device_kind') = 'queue_display' AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]));
CREATE POLICY queue_counters__insert__tenant_centre ON engagement.queue_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_counters__update__tenant_centre ON engagement.queue_counters FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_day_counters__select__tenant_centre ON engagement.queue_day_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_day_counters__insert__tenant_centre ON engagement.queue_day_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_day_counters__update__tenant_centre ON engagement.queue_day_counters FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_tokens__select__tenant_centre ON engagement.queue_tokens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_tokens__select__display ON engagement.queue_tokens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'device'
    AND (SELECT app.current_claims() ->> 'device_kind') = 'queue_display' AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]));
CREATE POLICY queue_tokens__insert__tenant_centre ON engagement.queue_tokens FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_tokens__update__tenant_centre ON engagement.queue_tokens FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_displays__select__tenant_centre ON engagement.queue_displays FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_displays__select__display ON engagement.queue_displays FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'device'
    AND (SELECT app.current_claims() ->> 'device_kind') = 'queue_display' AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])
    AND id = app.current_actor_id());
CREATE POLICY queue_displays__insert__tenant_centre ON engagement.queue_displays FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_displays__update__tenant_centre ON engagement.queue_displays FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY queue_displays__update__display ON engagement.queue_displays FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'device'
    AND (SELECT app.current_claims() ->> 'device_kind') = 'queue_display' AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])
    AND id = app.current_actor_id())
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'device'
    AND (SELECT app.current_claims() ->> 'device_kind') = 'queue_display' AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])
    AND id = app.current_actor_id());
CREATE POLICY reminders__select__tenant ON engagement.reminders FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY reminders__insert__tenant ON engagement.reminders FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY reminders__update__tenant ON engagement.reminders FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY membership_plans__select__tenant ON engagement.membership_plans FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY membership_plans__select__patient ON engagement.membership_plans FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND (SELECT app.engagement_account_id()) IS NOT NULL);
CREATE POLICY membership_plans__insert__tenant ON engagement.membership_plans FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY membership_plans__update__tenant ON engagement.membership_plans FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY patient_memberships__select__tenant ON engagement.patient_memberships FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY patient_memberships__select__patient ON engagement.patient_memberships FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[]));
CREATE POLICY patient_memberships__insert__tenant ON engagement.patient_memberships FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY patient_memberships__update__tenant ON engagement.patient_memberships FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY number_counters__select__tenant ON engagement.number_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system','patient','device'));
CREATE POLICY number_counters__insert__tenant ON engagement.number_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system','patient','device'));
CREATE POLICY number_counters__update__tenant ON engagement.number_counters FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system','patient','device'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system','patient','device'));
CREATE POLICY number_counters__delete__tenant ON engagement.number_counters FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at IS NOT NULL AND expires_at < now());
-- T0B-CNTPOL-1 (migration 20261116030000), LD-232 item 3 (CR-C0-T0B-REVIEW-1-002): non-staff actors only on their own rate / booking keys; no device access
CREATE POLICY number_counters__select__nonstaff_keys ON engagement.number_counters AS RESTRICTIVE FOR SELECT TO lims_app
  USING ((SELECT app.current_actor_type()) IN ('user','system')
         OR ((SELECT app.current_actor_type()) = 'patient' AND counter_key ~ '^(booking_no:[0-9]{2}|otp_day:[0-9]{8}|linkfail:[0-9a-f-]{36}:[0-9]{10})$'));
CREATE POLICY number_counters__insert__nonstaff_keys ON engagement.number_counters AS RESTRICTIVE FOR INSERT TO lims_app
  WITH CHECK ((SELECT app.current_actor_type()) IN ('user','system')
         OR ((SELECT app.current_actor_type()) = 'patient' AND counter_key ~ '^(booking_no:[0-9]{2}|otp_day:[0-9]{8}|linkfail:[0-9a-f-]{36}:[0-9]{10})$'));
CREATE POLICY number_counters__update__nonstaff_keys ON engagement.number_counters AS RESTRICTIVE FOR UPDATE TO lims_app
  USING ((SELECT app.current_actor_type()) IN ('user','system')
         OR ((SELECT app.current_actor_type()) = 'patient' AND counter_key ~ '^(booking_no:[0-9]{2}|otp_day:[0-9]{8}|linkfail:[0-9a-f-]{36}:[0-9]{10})$'))
  WITH CHECK ((SELECT app.current_actor_type()) IN ('user','system')
         OR ((SELECT app.current_actor_type()) = 'patient' AND counter_key ~ '^(booking_no:[0-9]{2}|otp_day:[0-9]{8}|linkfail:[0-9a-f-]{36}:[0-9]{10})$'));

-- LD-257: a patient actor can never lower a counter (OTP cap, link failure limit); equal or higher is fine.
CREATE FUNCTION engagement.guard_counter_decrease() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_actor text := app.current_actor_type();
BEGIN
  IF v_actor = 'patient' AND NEW.last_value < OLD.last_value THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER number_counters__patient_no_decrease BEFORE UPDATE ON engagement.number_counters
  FOR EACH ROW EXECUTE FUNCTION engagement.guard_counter_decrease();
CREATE POLICY enquiries__select__tenant ON engagement.enquiries FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY enquiries__select__patient_account ON engagement.enquiries FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY enquiries__insert__patient_account ON engagement.enquiries FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id())
    AND (patient_id IS NULL OR patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[])));
CREATE POLICY enquiries__update__tenant ON engagement.enquiries FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY enquiries__update__patient_account ON engagement.enquiries FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY enquiry_messages__select__tenant ON engagement.enquiry_messages FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY enquiry_messages__select__patient_account ON engagement.enquiry_messages FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id()));
CREATE POLICY enquiry_messages__insert__tenant ON engagement.enquiry_messages FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system')
    AND author_kind = 'staff');
CREATE POLICY enquiry_messages__insert__patient_account ON engagement.enquiry_messages FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
    AND account_id = (SELECT app.engagement_account_id())
    AND author_kind = 'patient');
CREATE POLICY cs_booking_cancel_reasons__select__tenant ON engagement.cs_booking_cancel_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system','patient','device'));
CREATE POLICY cs_booking_cancel_reasons__insert__tenant ON engagement.cs_booking_cancel_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY cs_booking_cancel_reasons__update__tenant ON engagement.cs_booking_cancel_reasons FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY cs_reminder_reasons__select__tenant ON engagement.cs_reminder_reasons FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system','patient','device'));
CREATE POLICY cs_reminder_reasons__insert__tenant ON engagement.cs_reminder_reasons FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY cs_reminder_reasons__update__tenant ON engagement.cs_reminder_reasons FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY cs_enquiry_categories__select__tenant ON engagement.cs_enquiry_categories FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system','patient','device'));
CREATE POLICY cs_enquiry_categories__insert__tenant ON engagement.cs_enquiry_categories FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY cs_enquiry_categories__update__tenant ON engagement.cs_enquiry_categories FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY accounts__select__owner_only ON engagement.accounts FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid);
CREATE POLICY account_patient_links__select__owner_only ON engagement.account_patient_links FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id()) AND account_id = app.engagement_account_id());
CREATE POLICY account_patient_links__update__owner_only ON engagement.account_patient_links FOR UPDATE TO lims_owner
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND account_id = app.engagement_account_id())
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND account_id = app.engagement_account_id());
CREATE POLICY link_codes__select__owner_only ON engagement.link_codes FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND (status = 'issued' OR redeemed_account_id = app.engagement_account_id()));
CREATE POLICY link_codes__update__owner_only ON engagement.link_codes FOR UPDATE TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id()) AND status = 'issued')
  WITH CHECK (redeemed_account_id = app.engagement_account_id());
CREATE POLICY otp_challenges__select__owner_only ON engagement.otp_challenges FOR SELECT TO lims_owner
  USING (token_sha256 = decode(current_setting('app.pre_engagement_otp_token_sha256', true), 'hex'));
CREATE POLICY queue_displays__select__owner_only ON engagement.queue_displays FOR SELECT TO lims_owner
  USING (token_sha256 = decode(current_setting('app.pre_engagement_display_token_sha256', true), 'hex'));
CREATE POLICY payment_requests__select__owner_only ON engagement.payment_requests FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'engagement_purge_payment_requests'
         AND tenant_id = (SELECT app.current_tenant_id()) AND status IN ('completed','failed','expired')
         AND updated_at < now() - interval '90 days');
CREATE POLICY payment_requests__delete__owner_only ON engagement.payment_requests FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'engagement_purge_payment_requests'
         AND tenant_id = (SELECT app.current_tenant_id()) AND status IN ('completed','failed','expired')
         AND updated_at < now() - interval '90 days');
CREATE POLICY queue_tokens__select__owner_only ON engagement.queue_tokens FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'engagement_purge_queue'
         AND tenant_id = (SELECT app.current_tenant_id())
         AND business_date < (now() AT TIME ZONE 'Asia/Kathmandu')::date - 365);
CREATE POLICY queue_tokens__delete__owner_only ON engagement.queue_tokens FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'engagement_purge_queue'
         AND tenant_id = (SELECT app.current_tenant_id())
         AND business_date < (now() AT TIME ZONE 'Asia/Kathmandu')::date - 365);
CREATE POLICY queue_day_counters__select__owner_only ON engagement.queue_day_counters FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'engagement_purge_queue'
         AND tenant_id = (SELECT app.current_tenant_id())
         AND business_date < (now() AT TIME ZONE 'Asia/Kathmandu')::date - 365);
CREATE POLICY queue_day_counters__delete__owner_only ON engagement.queue_day_counters FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'engagement_purge_queue'
         AND tenant_id = (SELECT app.current_tenant_id())
         AND business_date < (now() AT TIME ZONE 'Asia/Kathmandu')::date - 365);
