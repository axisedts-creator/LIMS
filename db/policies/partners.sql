-- T0B-13.C13: canonical CREATE POLICY set for partners.* (C13 05-SCHEMA §2 predicates, §8 written-out policies + shapes A-D; AC-0B-2.3).
-- Copied from db/migrations/20261115130000_partners__create_partners_schema.sql (source of truth); CI diffs pg_policies against this file.
-- 93 policies: 86 TO lims_app, 7 __owner_only TO lims_owner (08 A10.5, A19 P-41). No policy on the class G table partners.g_cs_reasons.
CREATE POLICY partner_users__select__owner_only ON partners.partner_users FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid);
CREATE POLICY partners__select__owner_only ON partners.partners FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY manifest_lines__select__owner_only ON partners.manifest_lines FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY manifest_lines__update__owner_only ON partners.manifest_lines FOR UPDATE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()) AND NOT is_redacted)
  WITH CHECK (current_setting('app.maintenance', true) = 'partners_redact_lines'
              AND tenant_id = (SELECT app.current_tenant_id()) AND is_redacted);
CREATE POLICY order_reports__select__owner_only ON partners.order_reports FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY order_reports__update__owner_only ON partners.order_reports FOR UPDATE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()) AND panel_names IS NOT NULL)
  WITH CHECK (current_setting('app.maintenance', true) = 'partners_redact_lines'
              AND tenant_id = (SELECT app.current_tenant_id()) AND panel_names IS NULL);
CREATE POLICY order_tracking__select__owner_only ON partners.order_tracking FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY settings__select__staff ON partners.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY settings__select__partner ON partners.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND (SELECT app.current_partner_id()) IS NOT NULL);
CREATE POLICY settings__insert__staff ON partners.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY settings__update__staff ON partners.settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partners__select__staff ON partners.partners FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partners__select__partner ON partners.partners FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND id = (SELECT app.current_partner_id()));
CREATE POLICY partners__insert__staff ON partners.partners FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partners__update__staff ON partners.partners FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partner_users__select__staff ON partners.partner_users FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partner_users__insert__staff ON partners.partner_users FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partner_users__update__staff ON partners.partner_users FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partner_users__select__partner ON partners.partner_users FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY partner_users__insert__partner ON partners.partner_users FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY partner_users__update__partner ON partners.partner_users FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY partner_referrers__select__staff ON partners.partner_referrers FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partner_referrers__insert__staff ON partners.partner_referrers FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partner_referrers__update__staff ON partners.partner_referrers FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partner_referrers__select__partner ON partners.partner_referrers FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY partner_referrers__insert__partner ON partners.partner_referrers FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY partner_referrers__update__partner ON partners.partner_referrers FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifest_counters__select__staff ON partners.manifest_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY manifest_counters__insert__staff ON partners.manifest_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY manifest_counters__update__staff ON partners.manifest_counters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY manifest_counters__select__partner ON partners.manifest_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifest_counters__insert__partner ON partners.manifest_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifest_counters__update__partner ON partners.manifest_counters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifest_lines__select__staff_centre ON partners.manifest_lines FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifest_lines__insert__staff_centre ON partners.manifest_lines FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifest_lines__update__staff_centre ON partners.manifest_lines FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifest_lines__select__partner ON partners.manifest_lines FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifest_lines__insert__partner ON partners.manifest_lines FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifest_lines__update__partner ON partners.manifest_lines FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY pickup_requests__select__staff_centre ON partners.pickup_requests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY pickup_requests__insert__staff_centre ON partners.pickup_requests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY pickup_requests__update__staff_centre ON partners.pickup_requests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY pickup_requests__select__partner ON partners.pickup_requests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY pickup_requests__insert__partner ON partners.pickup_requests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY pickup_requests__update__partner ON partners.pickup_requests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY pickup_request_manifests__select__staff_centre ON partners.pickup_request_manifests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY pickup_request_manifests__insert__staff_centre ON partners.pickup_request_manifests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY pickup_request_manifests__update__staff_centre ON partners.pickup_request_manifests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY pickup_request_manifests__select__partner ON partners.pickup_request_manifests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY pickup_request_manifests__insert__partner ON partners.pickup_request_manifests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY pickup_request_manifests__update__partner ON partners.pickup_request_manifests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY order_tracking__select__staff_centre ON partners.order_tracking FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY order_tracking__select__partner ON partners.order_tracking FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY order_tracking__insert__system ON partners.order_tracking FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY order_tracking__update__system ON partners.order_tracking FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY tracked_specimens__select__staff_centre ON partners.tracked_specimens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY tracked_specimens__select__partner ON partners.tracked_specimens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY tracked_specimens__insert__system ON partners.tracked_specimens FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY tracked_specimens__update__system ON partners.tracked_specimens FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY order_reports__select__staff_centre ON partners.order_reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY order_reports__select__partner ON partners.order_reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY order_reports__insert__system ON partners.order_reports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY order_reports__update__system ON partners.order_reports FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY order_reports__update__partner ON partners.order_reports FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY price_list_items__select__staff ON partners.price_list_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY price_list_items__select__partner ON partners.price_list_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY price_list_items__insert__system ON partners.price_list_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY price_list_items__update__system ON partners.price_list_items FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY price_list_items__delete__system ON partners.price_list_items FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY price_list_syncs__select__staff ON partners.price_list_syncs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY price_list_syncs__select__partner ON partners.price_list_syncs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY price_list_syncs__insert__system ON partners.price_list_syncs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY price_list_syncs__update__system ON partners.price_list_syncs FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY statement_months__select__staff ON partners.statement_months FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY statement_months__select__partner ON partners.statement_months FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY statement_months__insert__system ON partners.statement_months FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY statement_months__update__system ON partners.statement_months FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY download_counters__select__staff ON partners.download_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY download_counters__select__partner ON partners.download_counters FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()) AND partner_user_id = (SELECT pu.id FROM partners.partner_users pu WHERE pu.tenant_id = (SELECT app.current_tenant_id()) AND pu.membership_id = nullif((SELECT app.current_claims()) ->> 'membership_id','')::uuid));
CREATE POLICY download_counters__insert__partner ON partners.download_counters FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()) AND partner_user_id = (SELECT pu.id FROM partners.partner_users pu WHERE pu.tenant_id = (SELECT app.current_tenant_id()) AND pu.membership_id = nullif((SELECT app.current_claims()) ->> 'membership_id','')::uuid));
CREATE POLICY download_counters__update__partner ON partners.download_counters FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()) AND partner_user_id = (SELECT pu.id FROM partners.partner_users pu WHERE pu.tenant_id = (SELECT app.current_tenant_id()) AND pu.membership_id = nullif((SELECT app.current_claims()) ->> 'membership_id','')::uuid))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id()) AND partner_user_id = (SELECT pu.id FROM partners.partner_users pu WHERE pu.tenant_id = (SELECT app.current_tenant_id()) AND pu.membership_id = nullif((SELECT app.current_claims()) ->> 'membership_id','')::uuid));
CREATE POLICY manifests__select__staff_centre ON partners.manifests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifests__insert__staff_centre ON partners.manifests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifests__update__staff_centre ON partners.manifests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifests__select__partner ON partners.manifests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifests__insert__partner ON partners.manifests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifests__update__partner ON partners.manifests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifest_lines__delete__partner ON partners.manifest_lines FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()) AND state = 'draft');
CREATE POLICY download_counters__delete__tenant ON partners.download_counters FOR DELETE TO lims_app   -- A17 P-18(c)
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
CREATE POLICY access_slips__select__staff ON partners.access_slips FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY access_slips__select__partner ON partners.access_slips FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY access_slips__insert__partner ON partners.access_slips FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()) AND state = 'requested');
CREATE POLICY access_slips__update__system ON partners.access_slips FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
-- T0C-SALES-1 (LD-321): db/migrations/20261117210000_partners__add_sales_hierarchy.sql; no DELETE policy (deactivate / close, never delete)
CREATE POLICY sales_designation__select__tenant ON partners.sales_designation FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY sales_designation__insert__tenant ON partners.sales_designation FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY sales_designation__update__tenant ON partners.sales_designation FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY sales_representative__select__tenant ON partners.sales_representative FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY sales_representative__insert__tenant ON partners.sales_representative FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY sales_representative__update__tenant ON partners.sales_representative FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY party_sales_assignment__select__tenant ON partners.party_sales_assignment FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY party_sales_assignment__insert__tenant ON partners.party_sales_assignment FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY party_sales_assignment__update__tenant ON partners.party_sales_assignment FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY service_area__select__tenant ON partners.service_area FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY service_area__insert__tenant ON partners.service_area FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY service_area__update__tenant ON partners.service_area FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
