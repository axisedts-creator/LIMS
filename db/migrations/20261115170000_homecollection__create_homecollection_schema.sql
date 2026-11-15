-- T0B-13.C17 (LD-202): homecollection schema — C17 05-SCHEMA Part A §4 DDL verbatim (16 tables: 15 tenant + 1 G; 32 indexes;
-- 6 mutable-column triggers), §4.1 RLS / policies / grants (the DO/format() loop expanded into literal statements, the
-- other statements verbatim), §4.2 owner policies + the one DEFINER verbatim, §2 coded-set seed. C0 transcription steps:
-- the missing <t>__tenant__fk (C0 05-SCHEMA §9 rule 1), booking_refs__visit__fk (§4 "added after visits exists"), the two
-- transition guards §4 assigns to C0, row-audit triggers on the class M / C tables (C0 §2). Policies are copied 1:1 to
-- db/policies/homecollection.sql (AC-0B-2.3). homecollection.event_inbox belongs to T0B-05. Schema exists since T0B-01.
SET LOCAL ROLE lims_owner;

-- ===================================================== §4 DDL (verbatim)
-- ===================== settings =====================
CREATE TABLE homecollection.settings (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  min_app_version text NOT NULL DEFAULT '1.0.0',
  sync_interval_seconds integer NOT NULL DEFAULT 300,
  offline_purge_hours integer NOT NULL DEFAULT 16,
  capture_gps boolean NOT NULL DEFAULT false,
  gps_retention_days integer NOT NULL DEFAULT 90,
  map_handoff_enabled boolean NOT NULL DEFAULT true,   -- 08 A2.5 (founder-approved hand-off; tenant operational switch)
  manual_barcode_entry_allowed boolean NOT NULL DEFAULT true,
  second_identifier text NOT NULL DEFAULT 'phone',
  collection_consent_text_version text NOT NULL DEFAULT 'hc-consent-v1',
  collection_consent_text text NOT NULL,
  payment_methods jsonb NOT NULL,
  handover_confirmation_required boolean NOT NULL DEFAULT true,
  handover_overdue_hours integer NOT NULL DEFAULT 4,
  max_visits_per_route integer NOT NULL DEFAULT 40,
  notify_phlebotomist_on_assign boolean NOT NULL DEFAULT false,
  notify_patient_on_assign boolean NOT NULL DEFAULT false,
  clock_tolerance_seconds integer NOT NULL DEFAULT 600,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT settings__pk PRIMARY KEY (id),
  CONSTRAINT settings__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT settings__tenant_id__uq UNIQUE (tenant_id),
  CONSTRAINT settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT settings__min_app_version__ck CHECK (min_app_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'),
  CONSTRAINT settings__sync_interval__ck CHECK (sync_interval_seconds BETWEEN 60 AND 900),
  CONSTRAINT settings__purge_hours__ck CHECK (offline_purge_hours BETWEEN 4 AND 24),
  CONSTRAINT settings__gps_retention__ck CHECK (gps_retention_days BETWEEN 7 AND 365),
  CONSTRAINT settings__second_identifier__ck CHECK (second_identifier IN ('phone','birth_date')),
  CONSTRAINT settings__consent_version__ck CHECK (char_length(collection_consent_text_version) BETWEEN 1 AND 40),
  CONSTRAINT settings__consent_text__ck CHECK (char_length(collection_consent_text) BETWEEN 1 AND 2000),
  CONSTRAINT settings__payment_methods__ck CHECK (jsonb_typeof(payment_methods) = 'array'
             AND jsonb_array_length(payment_methods) BETWEEN 1 AND 10),
  CONSTRAINT settings__handover_hours__ck CHECK (handover_overdue_hours BETWEEN 1 AND 24),
  CONSTRAINT settings__max_visits__ck CHECK (max_visits_per_route BETWEEN 1 AND 60),
  CONSTRAINT settings__clock_tolerance__ck CHECK (clock_tolerance_seconds BETWEEN 60 AND 3600)
);
-- payment_methods element shape {code ^[a-z0-9_]{1,64}$, display 1..40, requires_reference bool} is validated
-- by the API (spec schema) — JSON shape checks are not expressed in SQL [DECISION].

-- ===================== coded sets =====================
CREATE TABLE homecollection.g_cs_reasons (
  id uuid NOT NULL,
  set_code text NOT NULL, code text NOT NULL, display text NOT NULL, requires_text boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0, system text NOT NULL DEFAULT 'lims', system_version text NOT NULL DEFAULT '1',
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_reasons__pk PRIMARY KEY (id),
  CONSTRAINT g_cs_reasons__set_code__uq UNIQUE (set_code, code),
  CONSTRAINT g_cs_reasons__set__ck CHECK (set_code IN ('visit_cancel_reasons','unassign_reasons','visit_fail_reasons',
     'specimen_not_collected_reasons','revisit_reasons','review_reasons','flag_resolutions','wipe_reasons')),
  CONSTRAINT g_cs_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT g_cs_reasons__display__ck CHECK (char_length(display) BETWEEN 1 AND 80)
);
-- No tenant reasons table in v1 (08 A19 D-130): homecollection.cs_reasons is dropped from the design.

-- ===================== booking_refs =====================
CREATE TABLE homecollection.booking_refs (
  id uuid NOT NULL, tenant_id uuid NOT NULL, booking_id uuid NOT NULL, state text NOT NULL, last_seq integer NOT NULL,
  visit_id uuid,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT booking_refs__pk PRIMARY KEY (id),
  CONSTRAINT booking_refs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT booking_refs__tenant_booking__uq UNIQUE (tenant_id, booking_id),        -- natural key (review m#23)
  CONSTRAINT booking_refs__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT booking_refs__state__ck CHECK (state IN ('confirmed','cancelled')),
  CONSTRAINT booking_refs__seq__ck CHECK (last_seq >= 1)
);
-- visit FK added after visits exists:
-- ALTER TABLE homecollection.booking_refs ADD CONSTRAINT booking_refs__visit__fk
--   FOREIGN KEY (tenant_id, visit_id) REFERENCES homecollection.visits (tenant_id, id);

-- ===================== routes =====================
CREATE TABLE homecollection.routes (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL,
  phlebotomist_membership_id uuid NOT NULL, route_date date NOT NULL,
  last_snapshot_at timestamptz, last_ack_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT routes__pk PRIMARY KEY (id),
  CONSTRAINT routes__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT routes__tenant_centre_member_date__uq UNIQUE (tenant_id, centre_id, phlebotomist_membership_id, route_date),
  CONSTRAINT routes__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT routes__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT routes__member__fk FOREIGN KEY (tenant_id, phlebotomist_membership_id) REFERENCES core.memberships (tenant_id, id)
);
CREATE INDEX routes__tenant_id_member_date__idx ON homecollection.routes (tenant_id, phlebotomist_membership_id, route_date);
CREATE INDEX routes__tenant_id_date_centre__idx ON homecollection.routes (tenant_id, route_date, centre_id);

-- ===================== visits =====================
CREATE TABLE homecollection.visits (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, branch_id uuid NOT NULL,
  kind text NOT NULL, status text NOT NULL DEFAULT 'unassigned', outcome text,
  booking_id uuid, parent_visit_id uuid, recollection_of_specimen_id uuid,
  patient_id uuid NOT NULL, order_id uuid, order_registered_at timestamptz,
  orderable_ids uuid[], referrer_id uuid, home_address_id uuid,
  address_text text, landmark text, latitude numeric(9,6), longitude numeric(9,6), note_for_phlebotomist text,
  window_start timestamptz, window_end timestamptz,
  route_id uuid, route_date date, route_sequence integer, assigned_membership_id uuid,
  assigned_at timestamptz, arrived_at timestamptz, completed_at timestamptz, failed_at timestamptz, cancelled_at timestamptz,
  status_reason_code text, status_reason_text text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT visits__pk PRIMARY KEY (id),
  CONSTRAINT visits__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT visits__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT visits__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT visits__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT visits__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT visits__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT visits__parent__fk FOREIGN KEY (tenant_id, parent_visit_id) REFERENCES homecollection.visits (tenant_id, id),
  CONSTRAINT visits__recollection_specimen__fk FOREIGN KEY (tenant_id, recollection_of_specimen_id) REFERENCES lab.specimens (tenant_id, id),
  CONSTRAINT visits__route__fk FOREIGN KEY (tenant_id, route_id) REFERENCES homecollection.routes (tenant_id, id),
  CONSTRAINT visits__member__fk FOREIGN KEY (tenant_id, assigned_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT visits__kind__ck CHECK (kind IN ('booking','front_desk','recollection','revisit')),
  CONSTRAINT visits__status__ck CHECK (status IN ('unassigned','assigned','in_progress','completed','failed','cancelled')),
  CONSTRAINT visits__outcome__ck CHECK (outcome IS NULL OR outcome IN ('collected','partial','none')),
  CONSTRAINT visits__kind_refs__ck CHECK (
        (kind = 'booking'      AND booking_id IS NOT NULL AND orderable_ids IS NOT NULL)
     OR (kind = 'front_desk'   AND order_id IS NOT NULL)
     OR (kind = 'recollection' AND recollection_of_specimen_id IS NOT NULL AND parent_visit_id IS NOT NULL AND order_id IS NOT NULL)
     OR (kind = 'revisit'      AND parent_visit_id IS NOT NULL AND order_id IS NOT NULL)),
  CONSTRAINT visits__orderables__ck CHECK (orderable_ids IS NULL OR cardinality(orderable_ids) BETWEEN 1 AND 50),
  CONSTRAINT visits__order_when_active__ck CHECK (status IN ('unassigned','cancelled') OR order_id IS NOT NULL),
  CONSTRAINT visits__assignment__ck CHECK (status NOT IN ('assigned','in_progress')
             OR (route_id IS NOT NULL AND route_date IS NOT NULL AND assigned_membership_id IS NOT NULL AND route_sequence IS NOT NULL)),
  CONSTRAINT visits__window__ck CHECK ((window_start IS NULL) = (window_end IS NULL)
             AND (window_start IS NULL OR (window_end > window_start AND window_end - window_start <= interval '12 hours'))),
  CONSTRAINT visits__coords__ck CHECK ((latitude IS NULL) = (longitude IS NULL)
             AND (latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))),
  CONSTRAINT visits__sequence__ck CHECK (route_sequence IS NULL OR route_sequence BETWEEN 1 AND 60),
  CONSTRAINT visits__texts__ck CHECK ((address_text IS NULL OR char_length(address_text) BETWEEN 1 AND 500)
             AND (landmark IS NULL OR char_length(landmark) <= 200)
             AND (note_for_phlebotomist IS NULL OR char_length(note_for_phlebotomist) <= 500)
             AND (status_reason_text IS NULL OR char_length(status_reason_text) <= 500))
);
CREATE UNIQUE INDEX visits__tenant_id_booking_id__p_uq ON homecollection.visits (tenant_id, booking_id) WHERE booking_id IS NOT NULL;
CREATE UNIQUE INDEX visits__tenant_id_order_id__p_uq ON homecollection.visits (tenant_id, order_id) WHERE kind = 'front_desk';
CREATE UNIQUE INDEX visits__tenant_id_recollection__p_uq ON homecollection.visits (tenant_id, recollection_of_specimen_id) WHERE recollection_of_specimen_id IS NOT NULL;
CREATE INDEX visits__tenant_id_order_id__idx ON homecollection.visits (tenant_id, order_id);                 -- consumers
CREATE INDEX visits__tenant_id_route_seq__idx ON homecollection.visits (tenant_id, route_id, route_sequence);  -- snapshot, lanes
CREATE INDEX visits__tenant_id_centre_status_window__idx ON homecollection.visits (tenant_id, centre_id, status, window_start); -- H1
CREATE INDEX visits__tenant_id_member_date__p_idx ON homecollection.visits (tenant_id, assigned_membership_id, route_date)
  WHERE status IN ('assigned','in_progress');                                                                   -- missed sweep, H12 counts
CREATE INDEX visits__tenant_id_unassigned__p_idx ON homecollection.visits (tenant_id, centre_id, window_start)
  WHERE status = 'unassigned';                                                                                  -- board left column
CREATE INDEX visits__tenant_id_parent__idx ON homecollection.visits (tenant_id, parent_visit_id) WHERE parent_visit_id IS NOT NULL;

CREATE TRIGGER visits__mutable_columns BEFORE UPDATE ON homecollection.visits
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
    'status','outcome','order_id','order_registered_at','address_text','landmark','latitude','longitude',
    'note_for_phlebotomist','window_start','window_end','route_id','route_date','route_sequence',
    'assigned_membership_id','assigned_at','arrived_at','completed_at','failed_at','cancelled_at',
    'status_reason_code','status_reason_text','updated_at','updated_by','version');
-- C0 adds homecollection.visits__transition_guard (BEFORE UPDATE, SECURITY INVOKER, search_path ''):
--  * order_id may change only from NULL to a value;
--  * status transitions only per 03-APP-FLOW §1.1 (V5..V11); nothing out of completed/failed/cancelled;
--  * address/window/note columns may change only while OLD.status IN ('unassigned','assigned') — EXCEPT the
--    retention anonymisation: when current_user = 'lims_owner' AND current_setting('app.maintenance', true)
--    = 'homecollection_anonymise_retired_visits' (set only inside app.homecollection_anonymise_retired_visits, §4.2),
--    the guard allows exactly address_text, landmark, latitude, longitude, note_for_phlebotomist, status_reason_text
--    to change to NULL (plus updated_at/updated_by/version) on a closed visit. A lims_app session that sets the same
--    GUC still fails the guard, because current_user is not lims_owner (08 A19 P-41; test §4.2 T2).
-- Raised as P0001 'immutable_row' → 409 homecollection.visit_closed (mapped in the module).

-- ===================== visit_transitions (A) =====================
CREATE TABLE homecollection.visit_transitions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, visit_id uuid NOT NULL,
  from_status text, to_status text NOT NULL, cause text NOT NULL, reason_code text, reason_text text,
  mutation_id uuid, at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT visit_transitions__pk PRIMARY KEY (id),
  CONSTRAINT visit_transitions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT visit_transitions__visit__fk FOREIGN KEY (tenant_id, visit_id) REFERENCES homecollection.visits (tenant_id, id),
  CONSTRAINT visit_transitions__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT visit_transitions__to__ck CHECK (to_status IN ('unassigned','assigned','in_progress','completed','failed','cancelled')),
  CONSTRAINT visit_transitions__cause__ck CHECK (cause IN ('consumer','dispatcher','sync','review','cron')),
  CONSTRAINT visit_transitions__text__ck CHECK (reason_text IS NULL OR char_length(reason_text) <= 500)
);
CREATE INDEX visit_transitions__tenant_id_visit_at__idx ON homecollection.visit_transitions (tenant_id, visit_id, at);

-- ===================== visit_assignments (A) =====================
CREATE TABLE homecollection.visit_assignments (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, visit_id uuid NOT NULL,
  route_id uuid, membership_id uuid, route_date date, action text NOT NULL, reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT visit_assignments__pk PRIMARY KEY (id),
  CONSTRAINT visit_assignments__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT visit_assignments__visit__fk FOREIGN KEY (tenant_id, visit_id) REFERENCES homecollection.visits (tenant_id, id),
  CONSTRAINT visit_assignments__route__fk FOREIGN KEY (tenant_id, route_id) REFERENCES homecollection.routes (tenant_id, id),
  CONSTRAINT visit_assignments__member__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT visit_assignments__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT visit_assignments__action__ck CHECK (action IN ('assign','reassign','unassign','missed')),
  CONSTRAINT visit_assignments__shape__ck CHECK ((action IN ('assign','reassign')) = (membership_id IS NOT NULL AND route_id IS NOT NULL))
);
CREATE INDEX visit_assignments__tenant_id_visit_created__idx ON homecollection.visit_assignments (tenant_id, visit_id, created_at);

-- ===================== visit_specimens (read model) =====================
CREATE TABLE homecollection.visit_specimens (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, visit_id uuid NOT NULL, specimen_id uuid NOT NULL, order_id uuid NOT NULL,
  specimen_type_code text NOT NULL, container_code text, status text NOT NULL, is_active boolean NOT NULL DEFAULT true,
  replaces_specimen_id uuid, last_seq integer NOT NULL DEFAULT 0, refreshed_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT visit_specimens__pk PRIMARY KEY (id),
  CONSTRAINT visit_specimens__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT visit_specimens__tenant_visit_specimen__uq UNIQUE (tenant_id, visit_id, specimen_id),   -- natural key (review m#23)
  CONSTRAINT visit_specimens__visit__fk FOREIGN KEY (tenant_id, visit_id) REFERENCES homecollection.visits (tenant_id, id),
  CONSTRAINT visit_specimens__specimen__fk FOREIGN KEY (tenant_id, specimen_id) REFERENCES lab.specimens (tenant_id, id),
  CONSTRAINT visit_specimens__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT visit_specimens__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT visit_specimens__status__ck CHECK (status IN ('ordered','collected','in_transit','received','aliquoted','in_process',
             'resulted','verified','approved','reported','rejected','recollection_ordered','stored','discarded')),
  CONSTRAINT visit_specimens__seq__ck CHECK (last_seq >= 0)
);
CREATE INDEX visit_specimens__tenant_id_specimen__idx ON homecollection.visit_specimens (tenant_id, specimen_id);
CREATE INDEX visit_specimens__tenant_id_order__idx ON homecollection.visit_specimens (tenant_id, order_id);
CREATE TRIGGER visit_specimens__mutable_columns BEFORE UPDATE ON homecollection.visit_specimens
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
    'specimen_type_code','container_code','status','is_active','replaces_specimen_id','last_seq','refreshed_at',
    'updated_at','updated_by','version');

-- ===================== devices =====================
CREATE TABLE homecollection.devices (
  id uuid NOT NULL, tenant_id uuid NOT NULL, membership_id uuid NOT NULL,
  platform text NOT NULL, os_version text NOT NULL, app_version text NOT NULL, model text,
  status text NOT NULL DEFAULT 'active',
  registered_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz, last_snapshot_at timestamptz,
  last_push_at timestamptz, last_ack_at timestamptz, last_ack_cursor text,
  max_device_seq_received bigint NOT NULL DEFAULT 0,
  wipe_requested_at timestamptz, wipe_requested_by uuid, wipe_reason_code text, wipe_reason_text text,
  wiped_at timestamptz, signed_off_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT devices__pk PRIMARY KEY (id),
  CONSTRAINT devices__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT devices__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT devices__member__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT devices__platform__ck CHECK (platform IN ('android','ios')),
  CONSTRAINT devices__status__ck CHECK (status IN ('active','signed_off','wipe_requested','wiped')),
  CONSTRAINT devices__texts__ck CHECK (char_length(os_version) <= 40 AND char_length(app_version) <= 20
             AND (model IS NULL OR char_length(model) <= 80) AND (last_ack_cursor IS NULL OR char_length(last_ack_cursor) <= 512)
             AND (wipe_reason_text IS NULL OR char_length(wipe_reason_text) <= 500)),
  CONSTRAINT devices__seq__ck CHECK (max_device_seq_received >= 0)
);
CREATE INDEX devices__tenant_id_member_status__idx ON homecollection.devices (tenant_id, membership_id, status);
CREATE INDEX devices__tenant_id_status_seen__idx ON homecollection.devices (tenant_id, status, last_seen_at);

-- ===================== sync_batches (A) =====================
CREATE TABLE homecollection.sync_batches (
  id uuid NOT NULL, tenant_id uuid NOT NULL, device_id uuid NOT NULL, membership_id uuid NOT NULL,
  sent_at_device timestamptz NOT NULL, now_device_wall_time timestamptz NOT NULL, now_monotonic_ms bigint NOT NULL,
  now_boot_id text NOT NULL, anchors jsonb NOT NULL,
  mutation_count integer NOT NULL, applied_count integer NOT NULL, held_count integer NOT NULL,
  rejected_count integer NOT NULL, duplicate_count integer NOT NULL, unresolved_mutations jsonb,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT sync_batches__pk PRIMARY KEY (id),
  CONSTRAINT sync_batches__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT sync_batches__device__fk FOREIGN KEY (tenant_id, device_id) REFERENCES homecollection.devices (tenant_id, id),
  CONSTRAINT sync_batches__counts__ck CHECK (mutation_count BETWEEN 1 AND 100
             AND applied_count + held_count + rejected_count + duplicate_count = mutation_count),
  CONSTRAINT sync_batches__boot__ck CHECK (char_length(now_boot_id) BETWEEN 1 AND 64)
);
CREATE INDEX sync_batches__tenant_id_device_received__idx ON homecollection.sync_batches (tenant_id, device_id, received_at);

-- ===================== mutations (A) =====================
CREATE TABLE homecollection.mutations (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL,
  client_mutation_id uuid NOT NULL, device_id uuid NOT NULL, batch_id uuid NOT NULL, membership_id uuid NOT NULL,
  device_seq bigint NOT NULL, type text NOT NULL, visit_id uuid,
  payload jsonb NOT NULL, payload_sha256 text NOT NULL,
  captured_at_device timestamptz NOT NULL, captured_at timestamptz NOT NULL,
  clock_source text NOT NULL, clock_suspect boolean NOT NULL DEFAULT false,
  outcome text NOT NULL, outcome_code text, received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT mutations__pk PRIMARY KEY (id),
  CONSTRAINT mutations__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT mutations__tenant_client_id__uq UNIQUE (tenant_id, client_mutation_id),
  CONSTRAINT mutations__visit__fk FOREIGN KEY (tenant_id, visit_id) REFERENCES homecollection.visits (tenant_id, id),
  CONSTRAINT mutations__batch__fk FOREIGN KEY (tenant_id, batch_id) REFERENCES homecollection.sync_batches (tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,   -- the batch row is inserted last, with its final counts (sync_batches is append-only; TRD §6.3 step 6)
  CONSTRAINT mutations__device__fk FOREIGN KEY (tenant_id, device_id) REFERENCES homecollection.devices (tenant_id, id),
  CONSTRAINT mutations__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT mutations__type__ck CHECK (type IN ('visit.arrived','visit.identity_checked','visit.consent_recorded',
             'specimen.collected','specimen.not_collected','payment.captured','visit.completed','visit.failed','handover.recorded')),
  CONSTRAINT mutations__visit_required__ck CHECK ((type = 'handover.recorded') = (visit_id IS NULL)),
  CONSTRAINT mutations__outcome__ck CHECK (outcome IN ('applied','held','rejected')),
  CONSTRAINT mutations__clock__ck CHECK (clock_source IN ('anchor','offset','device')),
  CONSTRAINT mutations__sha__ck CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mutations__seq__ck CHECK (device_seq >= 1),
  CONSTRAINT mutations__payload__ck CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 8192)
);
CREATE INDEX mutations__tenant_id_visit_seq__idx ON homecollection.mutations (tenant_id, visit_id, device_seq);   -- guards, H2
CREATE INDEX mutations__tenant_id_device_seq__idx ON homecollection.mutations (tenant_id, device_id, device_seq); -- sign-off
CREATE INDEX mutations__tenant_id_payments__p_idx ON homecollection.mutations (tenant_id, visit_id)
  WHERE type = 'payment.captured';

-- ===================== collections (C) =====================
CREATE TABLE homecollection.collections (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL,
  visit_id uuid NOT NULL, specimen_id uuid NOT NULL, order_id uuid NOT NULL,
  mutation_id uuid NOT NULL, client_mutation_id uuid NOT NULL, collected_by_membership_id uuid NOT NULL,
  scan_method text NOT NULL, barcode_verified boolean NOT NULL,
  collected_at timestamptz NOT NULL, collected_at_device timestamptz NOT NULL, clock_suspect boolean NOT NULL DEFAULT false,
  status text NOT NULL, hold_code text,
  review_decision text, review_reason_code text, review_reason_text text, reviewed_by uuid, reviewed_at timestamptz,
  applied_event_id uuid,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT collections__pk PRIMARY KEY (id),
  CONSTRAINT collections__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT collections__tenant_client_id__uq UNIQUE (tenant_id, client_mutation_id),
  CONSTRAINT collections__visit__fk FOREIGN KEY (tenant_id, visit_id) REFERENCES homecollection.visits (tenant_id, id),
  CONSTRAINT collections__specimen__fk FOREIGN KEY (tenant_id, specimen_id) REFERENCES lab.specimens (tenant_id, id),
  CONSTRAINT collections__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT collections__mutation__fk FOREIGN KEY (tenant_id, mutation_id) REFERENCES homecollection.mutations (tenant_id, id),
  CONSTRAINT collections__member__fk FOREIGN KEY (tenant_id, collected_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT collections__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT collections__scan__ck CHECK (scan_method IN ('camera','hid','manual')),
  CONSTRAINT collections__status__ck CHECK (status IN ('applied','held','discarded')),
  CONSTRAINT collections__held__ck CHECK (status <> 'held' OR (hold_code IS NOT NULL AND review_decision IS NULL)),
  CONSTRAINT collections__discarded__ck CHECK (status <> 'discarded' OR review_decision = 'discard'),
  CONSTRAINT collections__applied__ck CHECK (status <> 'applied' OR hold_code IS NULL OR review_decision = 'apply'),
  CONSTRAINT collections__review__ck CHECK ((review_decision IS NULL) = (reviewed_at IS NULL)
             AND (review_decision IS NULL OR review_decision IN ('apply','discard'))
             AND (review_reason_text IS NULL OR char_length(review_reason_text) <= 500)),
  CONSTRAINT collections__verified__ck CHECK (NOT barcode_verified OR scan_method IN ('camera','hid'))
);
CREATE UNIQUE INDEX collections__tenant_id_specimen__p_uq ON homecollection.collections (tenant_id, specimen_id) WHERE status = 'applied';
CREATE INDEX collections__tenant_id_visit__idx ON homecollection.collections (tenant_id, visit_id);
CREATE INDEX collections__tenant_id_held__p_idx ON homecollection.collections (tenant_id, centre_id, created_at) WHERE status = 'held';
CREATE INDEX collections__tenant_id_applied_member__p_idx ON homecollection.collections (tenant_id, collected_by_membership_id, collected_at)
  WHERE status = 'applied';                                                                                    -- overdue handover sweep
CREATE TRIGGER collections__mutable_columns BEFORE UPDATE ON homecollection.collections
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
    'status','review_decision','review_reason_code','review_reason_text','reviewed_by','reviewed_at','applied_event_id',
    'updated_at','updated_by','version');
-- C0 transition trigger: only held → applied | held → discarded.

-- ===================== handovers (C) =====================
CREATE TABLE homecollection.handovers (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, to_centre_id uuid NOT NULL,
  from_membership_id uuid NOT NULL, mutation_id uuid NOT NULL,
  handed_over_at timestamptz NOT NULL, handed_over_at_device timestamptz NOT NULL,
  status text NOT NULL, received_by_membership_id uuid, received_at timestamptz, note text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT handovers__pk PRIMARY KEY (id),
  CONSTRAINT handovers__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT handovers__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT handovers__to_centre__fk FOREIGN KEY (tenant_id, to_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT handovers__from__fk FOREIGN KEY (tenant_id, from_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT handovers__receiver__fk FOREIGN KEY (tenant_id, received_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT handovers__mutation__fk FOREIGN KEY (tenant_id, mutation_id) REFERENCES homecollection.mutations (tenant_id, id),
  CONSTRAINT handovers__status__ck CHECK (status IN ('pending','confirmed','discrepancy')),
  CONSTRAINT handovers__received__ck CHECK (status = 'pending' OR received_at IS NOT NULL),
  CONSTRAINT handovers__note__ck CHECK (note IS NULL OR char_length(note) <= 500)
);
CREATE INDEX handovers__tenant_id_to_centre_status__idx ON homecollection.handovers (tenant_id, to_centre_id, status, handed_over_at);
CREATE TRIGGER handovers__mutable_columns BEFORE UPDATE ON homecollection.handovers
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
    'status','received_by_membership_id','received_at','note','updated_at','updated_by','version');

CREATE TABLE homecollection.handover_items (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, to_centre_id uuid NOT NULL,
  handover_id uuid NOT NULL, collection_id uuid NOT NULL, specimen_id uuid NOT NULL, visit_id uuid NOT NULL,
  barcode text NOT NULL, specimen_type_code text NOT NULL,                          -- 08 A19 D-125 (copied at handover.recorded)
  outcome text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT handover_items__pk PRIMARY KEY (id),
  CONSTRAINT handover_items__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT handover_items__tenant_collection__uq UNIQUE (tenant_id, collection_id),
  CONSTRAINT handover_items__handover__fk FOREIGN KEY (tenant_id, handover_id) REFERENCES homecollection.handovers (tenant_id, id),
  CONSTRAINT handover_items__collection__fk FOREIGN KEY (tenant_id, collection_id) REFERENCES homecollection.collections (tenant_id, id),
  CONSTRAINT handover_items__visit__fk FOREIGN KEY (tenant_id, visit_id) REFERENCES homecollection.visits (tenant_id, id),
  CONSTRAINT handover_items__specimen__fk FOREIGN KEY (tenant_id, specimen_id) REFERENCES lab.specimens (tenant_id, id),           -- review m#33
  CONSTRAINT handover_items__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),      -- review m#33
  CONSTRAINT handover_items__to_centre__fk FOREIGN KEY (tenant_id, to_centre_id) REFERENCES core.collection_centres (tenant_id, id), -- review m#33
  CONSTRAINT handover_items__barcode__ck CHECK (barcode ~ '^[A-Z0-9]{1,20}$'),
  CONSTRAINT handover_items__specimen_type__ck CHECK (char_length(specimen_type_code) BETWEEN 1 AND 64),
  CONSTRAINT handover_items__outcome__ck CHECK (outcome IS NULL OR outcome IN ('received','missing'))
);
CREATE INDEX handover_items__tenant_id_handover__idx ON homecollection.handover_items (tenant_id, handover_id);
CREATE TRIGGER handover_items__mutable_columns BEFORE UPDATE ON homecollection.handover_items
  FOR EACH ROW
  WHEN (NOT (current_user = 'lims_owner'
             AND current_setting('app.maintenance', true) = 'homecollection_anonymise_retired_visits'))
  EXECUTE FUNCTION app.enforce_mutable_columns('outcome','updated_at','updated_by','version');
-- The WHEN clause lets only the retention DEFINER (§4.2, runs as lims_owner with app.maintenance set inside its body)
-- overwrite `barcode`; a lims_app session that sets the GUC is still checked (current_user <> lims_owner).

-- ===================== visit_flags (C) =====================
CREATE TABLE homecollection.visit_flags (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, visit_id uuid NOT NULL,
  kind text NOT NULL, status text NOT NULL DEFAULT 'open', related_id uuid, detail_code text,
  resolution_code text, resolution_note text, resolved_by uuid, resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT visit_flags__pk PRIMARY KEY (id),
  CONSTRAINT visit_flags__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT visit_flags__visit__fk FOREIGN KEY (tenant_id, visit_id) REFERENCES homecollection.visits (tenant_id, id),
  CONSTRAINT visit_flags__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT visit_flags__kind__ck CHECK (kind IN ('address_missing','collected_after_cancel','held_collection',
             'cancel_requested_after_start','order_cancel_required','missed','recollection_required','handover_overdue',
             'handover_discrepancy','identity_mismatch','specimen_not_collected','payment_rejected')),
  CONSTRAINT visit_flags__status__ck CHECK (status IN ('open','resolved')),
  CONSTRAINT visit_flags__resolved__ck CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CONSTRAINT visit_flags__note__ck CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500)
);
CREATE UNIQUE INDEX visit_flags__tenant_id_open__p_uq ON homecollection.visit_flags
  (tenant_id, visit_id, kind, coalesce(related_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'open';
CREATE INDEX visit_flags__tenant_id_centre_open__p_idx ON homecollection.visit_flags (tenant_id, centre_id, created_at) WHERE status = 'open';
CREATE INDEX visit_flags__tenant_id_visit__idx ON homecollection.visit_flags (tenant_id, visit_id, created_at);   -- H2 lists all flags (review m#33)
CREATE TRIGGER visit_flags__mutable_columns BEFORE UPDATE ON homecollection.visit_flags
  FOR EACH ROW EXECUTE FUNCTION app.enforce_mutable_columns(
    'status','resolution_code','resolution_note','resolved_by','resolved_at','updated_at','updated_by','version');

-- ===================== visit_locations (E) =====================
CREATE TABLE homecollection.visit_locations (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, visit_id uuid NOT NULL, mutation_id uuid NOT NULL,
  kind text NOT NULL, latitude numeric(9,6) NOT NULL, longitude numeric(9,6) NOT NULL, accuracy_m integer,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL, expires_at timestamptz NOT NULL,
  CONSTRAINT visit_locations__pk PRIMARY KEY (id),
  CONSTRAINT visit_locations__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT visit_locations__visit__fk FOREIGN KEY (tenant_id, visit_id) REFERENCES homecollection.visits (tenant_id, id),
  CONSTRAINT visit_locations__mutation__fk FOREIGN KEY (tenant_id, mutation_id) REFERENCES homecollection.mutations (tenant_id, id),
  CONSTRAINT visit_locations__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),   -- review m#33
  CONSTRAINT visit_locations__expiry__ck CHECK (expires_at > captured_at),
  CONSTRAINT visit_locations__kind__ck CHECK (kind IN ('arrived','collected','failed')),
  CONSTRAINT visit_locations__coords__ck CHECK (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180),
  CONSTRAINT visit_locations__accuracy__ck CHECK (accuracy_m IS NULL OR accuracy_m BETWEEN 0 AND 10000)
);
CREATE INDEX visit_locations__tenant_id_expires__idx ON homecollection.visit_locations (tenant_id, expires_at);
CREATE INDEX visit_locations__tenant_id_visit__idx ON homecollection.visit_locations (tenant_id, visit_id);

-- ===================== event_inbox =====================
-- homecollection.event_inbox is generated by C0 (C0 05-SCHEMA §3.9, db/tools/gen-inbox.ts: tenant FK, BRIN index,
-- policies). C17 does not specify its DDL (review m#24).

-- ===================================================== C0 transcription (C0 05-SCHEMA §9 rule 1): tenant FK where §4 omits it; deferred visit FK
ALTER TABLE homecollection.visit_transitions ADD CONSTRAINT visit_transitions__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE homecollection.visit_assignments ADD CONSTRAINT visit_assignments__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE homecollection.visit_specimens ADD CONSTRAINT visit_specimens__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE homecollection.sync_batches ADD CONSTRAINT sync_batches__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE homecollection.mutations ADD CONSTRAINT mutations__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE homecollection.collections ADD CONSTRAINT collections__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE homecollection.handovers ADD CONSTRAINT handovers__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE homecollection.handover_items ADD CONSTRAINT handover_items__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE homecollection.visit_flags ADD CONSTRAINT visit_flags__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE homecollection.visit_locations ADD CONSTRAINT visit_locations__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id);
ALTER TABLE homecollection.booking_refs ADD CONSTRAINT booking_refs__visit__fk
  FOREIGN KEY (tenant_id, visit_id) REFERENCES homecollection.visits (tenant_id, id);

-- ===================================================== C0 transition guards (§4 notes; 03-APP-FLOW §1.1 V5..V11). SECURITY INVOKER, search_path ''.
-- visits: order_id set once; status only along V5..V11 (same-status updates allowed while open); nothing out of completed /
-- failed / cancelled; address / window / note columns only while OLD.status IN ('unassigned','assigned'). The one exception is
-- the retention anonymisation (§4.2): current_user = 'lims_owner' AND app.maintenance = 'homecollection_anonymise_retired_visits'
-- may set exactly address_text, landmark, latitude, longitude, note_for_phlebotomist, status_reason_text to NULL (plus
-- updated_at / updated_by / version) on a closed visit. A lims_app session with the same GUC still fails (current_user).
-- Raised as P0001 'immutable_row' (02-CV §5.7) -> 409 homecollection.visit_closed (mapped in the module).
CREATE FUNCTION homecollection.visits__transition_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  anon_cols text[] := ARRAY['address_text','landmark','latitude','longitude','note_for_phlebotomist','status_reason_text',
                            'updated_at','updated_by','version'];
BEGIN
  IF OLD.status IN ('completed','failed','cancelled') THEN
    IF current_user = 'lims_owner'
       AND current_setting('app.maintenance', true) = 'homecollection_anonymise_retired_visits'
       AND NEW.address_text IS NULL AND NEW.landmark IS NULL AND NEW.latitude IS NULL AND NEW.longitude IS NULL
       AND NEW.note_for_phlebotomist IS NULL AND NEW.status_reason_text IS NULL
       AND (to_jsonb(NEW) - anon_cols) = (to_jsonb(OLD) - anon_cols) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'homecollection.visits: visit closed';
  END IF;
  IF OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'homecollection.visits.order_id is set once';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'unassigned'  AND NEW.status IN ('assigned','cancelled'))                 -- V5, V11
    OR (OLD.status = 'assigned'    AND NEW.status IN ('unassigned','in_progress','failed','cancelled'))   -- V7, V8, V10, V11
    OR (OLD.status = 'in_progress' AND NEW.status IN ('completed','failed'))) THEN             -- V9, V10
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row',
      DETAIL = 'homecollection.visits: transition ' || OLD.status || ' -> ' || NEW.status || ' not allowed';
  END IF;
  IF OLD.status NOT IN ('unassigned','assigned') AND (
       NEW.address_text IS DISTINCT FROM OLD.address_text OR NEW.landmark IS DISTINCT FROM OLD.landmark
    OR NEW.latitude IS DISTINCT FROM OLD.latitude OR NEW.longitude IS DISTINCT FROM OLD.longitude
    OR NEW.note_for_phlebotomist IS DISTINCT FROM OLD.note_for_phlebotomist
    OR NEW.window_start IS DISTINCT FROM OLD.window_start OR NEW.window_end IS DISTINCT FROM OLD.window_end) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'homecollection.visits: address / window / note frozen after start';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER visits__transition_guard BEFORE UPDATE ON homecollection.visits
  FOR EACH ROW EXECUTE FUNCTION homecollection.visits__transition_guard();

-- collections: status changes only held -> applied | held -> discarded (§4 "C0 transition trigger").
CREATE FUNCTION homecollection.collections__transition_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'held' AND NEW.status IN ('applied','discarded')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row',
      DETAIL = 'homecollection.collections: transition ' || OLD.status || ' -> ' || NEW.status || ' not allowed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER collections__transition_guard BEFORE UPDATE ON homecollection.collections
  FOR EACH ROW EXECUTE FUNCTION homecollection.collections__transition_guard();

-- ===================================================== §4.2 retention anonymisation DEFINER (verbatim) + owner / EXECUTE
CREATE FUNCTION app.homecollection_anonymise_retired_visits(p_before timestamptz)
RETURNS TABLE (visits_anonymised integer, handover_items_anonymised integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_actor  uuid := app.current_actor_id();
  v_visits integer;
  v_items  integer;
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL OR app.current_actor_type() IS DISTINCT FROM 'system'
     OR p_before IS NULL OR p_before > now() THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'homecollection_anonymise_invalid_input';
  END IF;
  PERFORM set_config('app.maintenance', 'homecollection_anonymise_retired_visits', true);
  UPDATE homecollection.visits v
     SET address_text = NULL, landmark = NULL, latitude = NULL, longitude = NULL,
         note_for_phlebotomist = NULL, status_reason_text = NULL,
         updated_at = now(), updated_by = v_actor, version = v.version + 1
   WHERE v.tenant_id = v_tenant
     AND v.status IN ('completed','failed','cancelled')
     AND coalesce(v.completed_at, v.failed_at, v.cancelled_at, v.updated_at) < p_before
     AND (v.address_text IS NOT NULL OR v.landmark IS NOT NULL OR v.latitude IS NOT NULL
          OR v.note_for_phlebotomist IS NOT NULL OR v.status_reason_text IS NOT NULL);
  GET DIAGNOSTICS v_visits = ROW_COUNT;
  UPDATE homecollection.handover_items hi
     SET barcode = 'ANONYMISED', updated_at = now(), updated_by = v_actor, version = hi.version + 1
   WHERE hi.tenant_id = v_tenant
     AND hi.barcode <> 'ANONYMISED'
     AND EXISTS (SELECT 1 FROM homecollection.visits v
                  WHERE v.tenant_id = hi.tenant_id AND v.id = hi.visit_id
                    AND v.status IN ('completed','failed','cancelled')
                    AND coalesce(v.completed_at, v.failed_at, v.cancelled_at, v.updated_at) < p_before);
  GET DIAGNOSTICS v_items = ROW_COUNT;
  PERFORM set_config('app.maintenance', '', true);
  RETURN QUERY SELECT v_visits, v_items;
END $$;
ALTER FUNCTION app.homecollection_anonymise_retired_visits(timestamptz) OWNER TO lims_owner;
REVOKE ALL ON FUNCTION app.homecollection_anonymise_retired_visits(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.homecollection_anonymise_retired_visits(timestamptz) TO lims_worker;

-- ===================================================== §4.1 RLS: ENABLE + FORCE on the 15 tenant tables; g_cs_reasons is RLS-exempt (db/tests/rls_exempt.txt)
ALTER TABLE homecollection.visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.visits FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.routes FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.visit_specimens ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.visit_specimens FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.collections FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.visit_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.visit_flags FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.visit_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.visit_transitions FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.visit_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.visit_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.mutations FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.visit_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.visit_locations FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.settings FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.booking_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.booking_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.devices FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.sync_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.sync_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.handovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.handovers FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.handover_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE homecollection.handover_items FORCE ROW LEVEL SECURITY;

-- ===================================================== §4.1 (1) DO-block policies expanded (pred_c / pred_t verbatim), (2) handovers / handover_items, (3) visit_locations DELETE; §4.2 owner policies
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

-- ===================================================== §4.1 grants (lims_app only)
GRANT SELECT, INSERT, UPDATE ON homecollection.visits TO lims_app;
GRANT SELECT, INSERT, UPDATE ON homecollection.routes TO lims_app;
GRANT SELECT, INSERT, UPDATE ON homecollection.visit_specimens TO lims_app;
GRANT SELECT, INSERT, UPDATE ON homecollection.collections TO lims_app;
GRANT SELECT, INSERT, UPDATE ON homecollection.visit_flags TO lims_app;
GRANT SELECT, INSERT ON homecollection.visit_transitions TO lims_app;
GRANT SELECT, INSERT ON homecollection.visit_assignments TO lims_app;
GRANT SELECT, INSERT ON homecollection.mutations TO lims_app;
GRANT SELECT, INSERT ON homecollection.visit_locations TO lims_app;
GRANT SELECT, INSERT, UPDATE ON homecollection.settings TO lims_app;
GRANT SELECT, INSERT, UPDATE ON homecollection.booking_refs TO lims_app;
GRANT SELECT, INSERT, UPDATE ON homecollection.devices TO lims_app;
GRANT SELECT, INSERT ON homecollection.sync_batches TO lims_app;
GRANT SELECT, INSERT, UPDATE ON homecollection.handovers, homecollection.handover_items TO lims_app;
GRANT DELETE ON homecollection.visit_locations TO lims_app;      -- the only DELETE grant in this schema (E table)
GRANT SELECT ON homecollection.g_cs_reasons TO lims_app;
-- CI: has_table_privilege('lims_app', t, 'DELETE') = false for every homecollection table except visit_locations.

-- ===================================================== row audit (C0 app.tg_row_audit; class M and C tables)
CREATE TRIGGER settings__audit AFTER INSERT OR UPDATE OR DELETE ON homecollection.settings FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER booking_refs__audit AFTER INSERT OR UPDATE OR DELETE ON homecollection.booking_refs FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER routes__audit AFTER INSERT OR UPDATE OR DELETE ON homecollection.routes FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER visits__audit AFTER INSERT OR UPDATE OR DELETE ON homecollection.visits FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER visit_specimens__audit AFTER INSERT OR UPDATE OR DELETE ON homecollection.visit_specimens FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER devices__audit AFTER INSERT OR UPDATE OR DELETE ON homecollection.devices FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER collections__audit AFTER INSERT OR UPDATE OR DELETE ON homecollection.collections FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER handovers__audit AFTER INSERT OR UPDATE OR DELETE ON homecollection.handovers FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER handover_items__audit AFTER INSERT OR UPDATE OR DELETE ON homecollection.handover_items FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER visit_flags__audit AFTER INSERT OR UPDATE OR DELETE ON homecollection.visit_flags FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- ===================================================== §2 coded-set seed (global, D-130). display: spec text where given, else the code in words [CONV]
INSERT INTO homecollection.g_cs_reasons (id, set_code, code, display, requires_text, sort_order) VALUES
  ('019a0000-c017-7000-8001-000000000001', 'visit_cancel_reasons', 'patient_request', 'Patient asked to cancel', false, 10),
  ('019a0000-c017-7000-8001-000000000002', 'visit_cancel_reasons', 'duplicate', 'Duplicate visit', false, 20),
  ('019a0000-c017-7000-8001-000000000003', 'visit_cancel_reasons', 'lab_unavailable', 'Lab can''t serve', false, 30),
  ('019a0000-c017-7000-8001-000000000004', 'visit_cancel_reasons', 'address_unreachable', 'Address can''t be reached', false, 40),
  ('019a0000-c017-7000-8001-000000000005', 'visit_cancel_reasons', 'booking_cancelled', 'Booking cancelled — system', false, 50),
  ('019a0000-c017-7000-8001-000000000006', 'visit_cancel_reasons', 'other', 'Other', true, 60),
  ('019a0000-c017-7000-8002-000000000001', 'unassign_reasons', 'phlebotomist_unavailable', 'Phlebotomist unavailable', false, 10),
  ('019a0000-c017-7000-8002-000000000002', 'unassign_reasons', 'rebalance_routes', 'Rebalance routes', false, 20),
  ('019a0000-c017-7000-8002-000000000003', 'unassign_reasons', 'reschedule', 'Reschedule', false, 30),
  ('019a0000-c017-7000-8002-000000000004', 'unassign_reasons', 'missed', 'Missed', false, 40),
  ('019a0000-c017-7000-8002-000000000005', 'unassign_reasons', 'other', 'Other', true, 50),
  ('019a0000-c017-7000-8003-000000000001', 'visit_fail_reasons', 'patient_not_home', 'Patient not at home', false, 10),
  ('019a0000-c017-7000-8003-000000000002', 'visit_fail_reasons', 'address_not_found', 'Address not found', false, 20),
  ('019a0000-c017-7000-8003-000000000003', 'visit_fail_reasons', 'patient_refused', 'Patient refused', false, 30),
  ('019a0000-c017-7000-8003-000000000004', 'visit_fail_reasons', 'identity_mismatch', 'Identity doesn''t match', false, 40),
  ('019a0000-c017-7000-8003-000000000005', 'visit_fail_reasons', 'unable_to_draw', 'Unable to draw blood', false, 50),
  ('019a0000-c017-7000-8003-000000000006', 'visit_fail_reasons', 'other', 'Other', true, 60),
  ('019a0000-c017-7000-8004-000000000001', 'specimen_not_collected_reasons', 'unable_to_draw', 'Unable to draw', false, 10),
  ('019a0000-c017-7000-8004-000000000002', 'specimen_not_collected_reasons', 'patient_declined_tube', 'Patient declined this tube', false, 20),
  ('019a0000-c017-7000-8004-000000000003', 'specimen_not_collected_reasons', 'tube_missing', 'Tube or label missing', false, 30),
  ('019a0000-c017-7000-8004-000000000004', 'specimen_not_collected_reasons', 'other', 'Other', true, 40),
  ('019a0000-c017-7000-8005-000000000001', 'revisit_reasons', 'failed_visit', 'Failed visit', false, 10),
  ('019a0000-c017-7000-8005-000000000002', 'revisit_reasons', 'partial_collection', 'Partial collection', false, 20),
  ('019a0000-c017-7000-8005-000000000003', 'revisit_reasons', 'patient_request', 'Patient request', false, 30),
  ('019a0000-c017-7000-8005-000000000004', 'revisit_reasons', 'other', 'Other', true, 40),
  ('019a0000-c017-7000-8006-000000000001', 'review_reasons', 'confirmed_with_phlebotomist', 'Confirmed with phlebotomist', false, 10),
  ('019a0000-c017-7000-8006-000000000002', 'review_reasons', 'order_still_valid', 'Order still valid', false, 20),
  ('019a0000-c017-7000-8006-000000000003', 'review_reasons', 'specimen_destroyed', 'Tube destroyed', false, 30),
  ('019a0000-c017-7000-8006-000000000004', 'review_reasons', 'duplicate_draw', 'Duplicate draw', false, 40),
  ('019a0000-c017-7000-8006-000000000005', 'review_reasons', 'wrong_patient', 'Wrong patient', false, 50),
  ('019a0000-c017-7000-8006-000000000006', 'review_reasons', 'other', 'Other', true, 60),
  ('019a0000-c017-7000-8007-000000000001', 'flag_resolutions', 'handled', 'Handled', false, 10),
  ('019a0000-c017-7000-8007-000000000002', 'flag_resolutions', 'not_needed', 'Not needed', false, 20),
  ('019a0000-c017-7000-8007-000000000003', 'flag_resolutions', 'escalated', 'Escalated', false, 30),
  ('019a0000-c017-7000-8007-000000000004', 'flag_resolutions', 'other', 'Other', true, 40),
  ('019a0000-c017-7000-8008-000000000001', 'wipe_reasons', 'lost', 'Lost', false, 10),
  ('019a0000-c017-7000-8008-000000000002', 'wipe_reasons', 'stolen', 'Stolen', false, 20),
  ('019a0000-c017-7000-8008-000000000003', 'wipe_reasons', 'retired', 'Retired', false, 30),
  ('019a0000-c017-7000-8008-000000000004', 'wipe_reasons', 'reassigned', 'Reassigned', false, 40),
  ('019a0000-c017-7000-8008-000000000005', 'wipe_reasons', 'other', 'Other', true, 50)
ON CONFLICT (set_code, code) DO NOTHING;
