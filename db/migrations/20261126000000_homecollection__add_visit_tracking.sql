-- PHLEBO-UI-FULL-1 (founder approval 2026-11-25/26, .orchestra/cr/PHLEBO-UI-FULL-1.md): live tracking of a home visit.
-- One row per visit, overwritten in place: the phlebotomist app starts it with "On my way", sends its position while the
-- app is open, and it stops at arrival / completion / failure / cancellation. Only the LATEST position is kept (no trail);
-- the coordinates are cleared when tracking stops. P2 (staff location). Not synced through the offline outbox: a late
-- position is worthless. booking_id and collector_display_name are copied at start so the patient's read needs no other table.
SET LOCAL ROLE lims_owner;

CREATE TABLE homecollection.visit_tracking (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, visit_id uuid NOT NULL, membership_id uuid NOT NULL,
  booking_id uuid, collector_display_name text NOT NULL,
  state text NOT NULL, stop_reason text,
  started_at timestamptz NOT NULL, stopped_at timestamptz,
  latitude numeric(9,6), longitude numeric(9,6), accuracy_m integer, position_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT visit_tracking__pk PRIMARY KEY (id),
  CONSTRAINT visit_tracking__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT visit_tracking__tenant_visit__uq UNIQUE (tenant_id, visit_id),
  CONSTRAINT visit_tracking__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT visit_tracking__visit__fk FOREIGN KEY (tenant_id, visit_id) REFERENCES homecollection.visits (tenant_id, id),
  CONSTRAINT visit_tracking__member__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT visit_tracking__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT visit_tracking__state__ck CHECK (state IN ('en_route','stopped')),
  CONSTRAINT visit_tracking__stopped__ck CHECK ((state = 'stopped') = (stopped_at IS NOT NULL) AND (state = 'stopped') = (stop_reason IS NOT NULL)),
  CONSTRAINT visit_tracking__stop_reason__ck CHECK (stop_reason IS NULL OR stop_reason IN ('arrived','completed','failed','cancelled','stopped')),
  CONSTRAINT visit_tracking__name__ck CHECK (char_length(collector_display_name) BETWEEN 1 AND 120),
  CONSTRAINT visit_tracking__coords__ck CHECK ((latitude IS NULL) = (longitude IS NULL) AND (latitude IS NULL) = (position_at IS NULL)
             AND (latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))),
  CONSTRAINT visit_tracking__no_position_when_stopped__ck CHECK (state = 'en_route' OR latitude IS NULL),
  CONSTRAINT visit_tracking__accuracy__ck CHECK (accuracy_m IS NULL OR accuracy_m BETWEEN 0 AND 10000)
);
CREATE INDEX visit_tracking__tenant_id_booking__p_idx ON homecollection.visit_tracking (tenant_id, booking_id) WHERE booking_id IS NOT NULL;

ALTER TABLE homecollection.visit_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.visit_tracking FORCE ROW LEVEL SECURITY;

CREATE POLICY visit_tracking__select__tenant_centre ON homecollection.visit_tracking FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY visit_tracking__insert__tenant_centre ON homecollection.visit_tracking FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));
CREATE POLICY visit_tracking__update__tenant_centre ON homecollection.visit_tracking FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])) AND (SELECT app.is_staff_or_system()));

GRANT SELECT, INSERT, UPDATE ON homecollection.visit_tracking TO lims_app;

-- The patient's read: a patient actor sees a tracking row only through a booking it can already see
-- (engagement.bookings RLS: own account only). No staff phone or staff id is in this table.
CREATE POLICY visit_tracking__select__patient_booking ON homecollection.visit_tracking FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND booking_id IS NOT NULL
         AND booking_id IN (SELECT b.id FROM engagement.bookings b WHERE b.account_id = (SELECT app.engagement_account_id())));
