-- T0B-13.C17: canonical CREATE POLICY set for homecollection.* (C17 05-SCHEMA §4.1, §4.2; AC-0B-2.3).
-- Copied from db/migrations/20261115170000_homecollection__create_homecollection_schema.sql (source of truth); CI diffs pg_policies against this file.
-- 41 policies TO lims_app (34 from the §4.1 DO block, 7 literal) + 4 owner policies TO lims_owner (§4.2).
-- No policy on homecollection.g_cs_reasons (class G). homecollection.event_inbox policies are T0B-05's.
CREATE POLICY visits__select__tenant_centre ON homecollection.visits FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visits__insert__tenant_centre ON homecollection.visits FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visits__update__tenant_centre ON homecollection.visits FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY routes__select__tenant_centre ON homecollection.routes FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY routes__insert__tenant_centre ON homecollection.routes FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY routes__update__tenant_centre ON homecollection.routes FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visit_specimens__select__tenant_centre ON homecollection.visit_specimens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visit_specimens__insert__tenant_centre ON homecollection.visit_specimens FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visit_specimens__update__tenant_centre ON homecollection.visit_specimens FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY collections__select__tenant_centre ON homecollection.collections FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY collections__insert__tenant_centre ON homecollection.collections FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY collections__update__tenant_centre ON homecollection.collections FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visit_flags__select__tenant_centre ON homecollection.visit_flags FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visit_flags__insert__tenant_centre ON homecollection.visit_flags FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visit_flags__update__tenant_centre ON homecollection.visit_flags FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visit_transitions__select__tenant_centre ON homecollection.visit_transitions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visit_transitions__insert__tenant_centre ON homecollection.visit_transitions FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visit_assignments__select__tenant_centre ON homecollection.visit_assignments FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visit_assignments__insert__tenant_centre ON homecollection.visit_assignments FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY mutations__select__tenant_centre ON homecollection.mutations FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY mutations__insert__tenant_centre ON homecollection.mutations FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visit_locations__select__tenant_centre ON homecollection.visit_locations FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visit_locations__insert__tenant_centre ON homecollection.visit_locations FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY settings__select__tenant ON homecollection.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__insert__tenant ON homecollection.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY settings__update__tenant ON homecollection.settings FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY booking_refs__select__tenant ON homecollection.booking_refs FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY booking_refs__insert__tenant ON homecollection.booking_refs FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY booking_refs__update__tenant ON homecollection.booking_refs FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY devices__select__tenant ON homecollection.devices FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY devices__insert__tenant ON homecollection.devices FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY devices__update__tenant ON homecollection.devices FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY sync_batches__select__tenant ON homecollection.sync_batches FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY sync_batches__insert__tenant ON homecollection.sync_batches FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY handovers__select__tenant_centre ON homecollection.handovers FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND ((SELECT app.has_all_centres())
              OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])
              OR to_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY handovers__insert__tenant_centre ON homecollection.handovers FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY handovers__update__tenant_centre ON homecollection.handovers FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id())
         AND ((SELECT app.has_all_centres()) OR to_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id())
         AND ((SELECT app.has_all_centres()) OR to_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY handover_items__select__tenant_centre ON homecollection.handover_items FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND ((SELECT app.has_all_centres())
              OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])
              OR to_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY handover_items__insert__tenant_centre ON homecollection.handover_items FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY handover_items__update__tenant_centre ON homecollection.handover_items FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id())
         AND ((SELECT app.has_all_centres()) OR to_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id())
         AND ((SELECT app.has_all_centres()) OR to_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY visit_locations__delete__tenant_centre ON homecollection.visit_locations FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))
         AND (SELECT app.current_actor_type()) = 'system'
         AND expires_at < now());
CREATE POLICY visits__select__owner_only ON homecollection.visits FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'homecollection_anonymise_retired_visits'
         AND tenant_id = (SELECT app.current_tenant_id())
         AND status IN ('completed','failed','cancelled'));
CREATE POLICY visits__update__owner_only ON homecollection.visits FOR UPDATE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'homecollection_anonymise_retired_visits'
         AND tenant_id = (SELECT app.current_tenant_id())
         AND status IN ('completed','failed','cancelled'))
  WITH CHECK (current_setting('app.maintenance', true) = 'homecollection_anonymise_retired_visits'
         AND tenant_id = (SELECT app.current_tenant_id())
         AND status IN ('completed','failed','cancelled'));
CREATE POLICY handover_items__select__owner_only ON homecollection.handover_items FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'homecollection_anonymise_retired_visits'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY handover_items__update__owner_only ON homecollection.handover_items FOR UPDATE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'homecollection_anonymise_retired_visits'
         AND tenant_id = (SELECT app.current_tenant_id()))
  WITH CHECK (current_setting('app.maintenance', true) = 'homecollection_anonymise_retired_visits'
         AND tenant_id = (SELECT app.current_tenant_id())
         AND barcode = 'ANONYMISED');
