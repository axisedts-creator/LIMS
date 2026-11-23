-- Synthetic test fixture for Milestone T13: My Health Now live E2E integration
-- Tenant A: Synthetic Lab Alpha (01a1a98a-ac40-7000-8000-00000000a001)

SELECT set_config('request.jwt.claims', '{"tenant_id":"01a1a98a-ac40-7000-8000-00000000a001","sub":"01a1b34e-1000-7eee-9d29-d7ca59a102b5","actor_type":"system"}', true);
SET LOCAL ROLE lims_app;

INSERT INTO frontdesk.patients (
  id, tenant_id, patient_code, full_name, name_search, sex, birth_on, phone_e164, registered_centre_id, source, created_by, updated_by
) VALUES (
  '01a1a98a-ac40-7000-8000-00000000a801',
  '01a1a98a-ac40-7000-8000-00000000a001',
  'P-MHN-001',
  'Asha Sharma',
  'asha sharma',
  'female',
  '1992-05-15',
  '+9779800000001',
  '01a1a98a-ac40-7000-8000-00000000a201',
  'front_desk',
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5',
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5'
) ON CONFLICT (tenant_id, id) DO NOTHING;

INSERT INTO engagement.settings (
  id, tenant_id, app_enabled, bookings_enabled, home_collection_enabled, home_collection_centre_id, allowed_phone_prefixes, otp_daily_cap,
  min_app_version_android, min_app_version_ios, max_profiles_per_account, max_accounts_per_patient,
  booking_horizon_days, booking_min_lead_minutes, booking_cancel_cutoff_minutes, no_show_grace_minutes,
  max_active_bookings_per_profile, max_bookings_created_per_account_day, max_orderables_per_booking,
  app_consent_text, app_consent_text_version, minor_age_years,
  created_by, updated_by
) VALUES (
  '01a1a98a-ac40-7000-8000-00000000a901',
  '01a1a98a-ac40-7000-8000-00000000a001',
  true, true, true, '01a1a98a-ac40-7000-8000-00000000a203', ARRAY['+977']::text[], 2000,
  '0.0.0', '0.0.0', 8, 3,
  14, 0, 0, 120,
  5, 10, 20,
  'By continuing, you agree to digital laboratory records and processing under Nepal Data Protection provisions.', '2026-01', 18,
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5',
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5'
) ON CONFLICT (tenant_id, id) DO UPDATE SET
  booking_min_lead_minutes = 0,
  booking_cancel_cutoff_minutes = 0,
  app_consent_text = EXCLUDED.app_consent_text,
  app_consent_text_version = EXCLUDED.app_consent_text_version,
  minor_age_years = EXCLUDED.minor_age_years;

INSERT INTO engagement.booking_centres (
  id, tenant_id, centre_id, branch_id, display_name, address_text, is_active, synced_at, created_by, updated_by
) VALUES (
  '01a1a98a-ac40-7000-8000-00000000a911',
  '01a1a98a-ac40-7000-8000-00000000a001',
  '01a1a98a-ac40-7000-8000-00000000a201',
  '01a1a98a-ac40-7000-8000-00000000a101',
  'Alpha Main Diagnostic Centre',
  'Kathmandu Central, Bagmati, Nepal',
  true,
  now(),
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5',
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5'
) ON CONFLICT (tenant_id, id) DO NOTHING;

INSERT INTO engagement.bookable_items (
  id, tenant_id, orderable_id, orderable_kind, code, display_name, indicative_price_paisa,
  booking_kinds, sort_order, is_active, created_by, updated_by
) VALUES (
  '01a1a98a-ac40-7000-8000-00000000a921',
  '01a1a98a-ac40-7000-8000-00000000a001',
  '01a1a98a-ac40-7000-8000-00000000a931',
  'test',
  'CBC',
  'Complete Blood Count (CBC)',
  50000,
  ARRAY['centre_visit','home_collection']::text[],
  10,
  true,
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5',
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5'
), (
  '01a1a98a-ac40-7000-8000-00000000a922',
  '01a1a98a-ac40-7000-8000-00000000a001',
  '01a1a98a-ac40-7000-8000-00000000a932',
  'panel',
  'LIPID',
  'Lipid Profile Comprehensive',
  120000,
  ARRAY['centre_visit','home_collection']::text[],
  20,
  true,
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5',
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5'
), (
  '01a1a98a-ac40-7000-8000-00000000a923',
  '01a1a98a-ac40-7000-8000-00000000a001',
  '01a1a98a-ac40-7000-8000-00000000a933',
  'test',
  'FBS',
  'Fasting Blood Sugar (Glucose)',
  20000,
  ARRAY['centre_visit','home_collection']::text[],
  30,
  true,
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5',
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5'
), (
  '01a1a98a-ac40-7000-8000-00000000a924',
  '01a1a98a-ac40-7000-8000-00000000a001',
  '01a1a98a-ac40-7000-8000-00000000a934',
  'panel',
  'LFT',
  'LFT Advanced',
  150000,
  ARRAY['centre_visit','home_collection']::text[],
  40,
  true,
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5',
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5'
) ON CONFLICT (tenant_id, id) DO NOTHING;

INSERT INTO engagement.slot_templates (
  id, tenant_id, centre_id, booking_kind, weekdays, start_local, end_local, slot_minutes,
  capacity, effective_from, is_active, created_by, updated_by
) VALUES (
  '01a1a98a-ac40-7000-8000-00000000a941',
  '01a1a98a-ac40-7000-8000-00000000a001',
  '01a1a98a-ac40-7000-8000-00000000a201',
  'centre_visit',
  ARRAY[1,2,3,4,5,6,7]::smallint[],
  '07:00:00'::time,
  '17:00:00'::time,
  15,
  5,
  '2026-01-01'::date,
  true,
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5',
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5'
) ON CONFLICT (tenant_id, id) DO NOTHING;

INSERT INTO engagement.slot_occupancy (
  id, tenant_id, centre_id, booking_kind, slot_start, slot_end, template_id, capacity, booked,
  is_active, created_by, updated_by
) VALUES (
  '01a1a98a-ac40-7000-8000-00000000a951',
  '01a1a98a-ac40-7000-8000-00000000a001',
  '01a1a98a-ac40-7000-8000-00000000a201',
  'centre_visit',
  '2026-11-23 08:00:00+00'::timestamptz,
  '2026-11-23 08:15:00+00'::timestamptz,
  '01a1a98a-ac40-7000-8000-00000000a941',
  5,
  0,
  true,
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5',
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5'
), (
  '01a1a98a-ac40-7000-8000-00000000a952',
  '01a1a98a-ac40-7000-8000-00000000a001',
  '01a1a98a-ac40-7000-8000-00000000a201',
  'centre_visit',
  '2026-11-23 08:15:00+00'::timestamptz,
  '2026-11-23 08:30:00+00'::timestamptz,
  '01a1a98a-ac40-7000-8000-00000000a941',
  5,
  0,
  true,
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5',
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5'
) ON CONFLICT (tenant_id, id) DO NOTHING;

INSERT INTO engagement.patient_reports (
  tenant_id, report_id, version_no, order_id, patient_id, report_kind, status, released_at,
  panel_names, smart_summary_available, created_by, updated_by
) VALUES (
  '01a1a98a-ac40-7000-8000-00000000a001',
  '01a1a98a-ac40-7000-8000-00000000a981',
  1,
  '01a1a98a-ac40-7000-8000-00000000a971',
  '01a1a98a-ac40-7000-8000-00000000a801',
  'final',
  'valid',
  '2026-11-20 10:00:00+00'::timestamptz,
  ARRAY['Complete Blood Count (CBC)']::text[],
  false,
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5',
  '01a1b34e-1000-7eee-9d29-d7ca59a102b5'
) ON CONFLICT (tenant_id, report_id, version_no) DO NOTHING;

RESET ROLE;
