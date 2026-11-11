-- Hand-written seed (LD-59, 2026-11-07: CR-C6-024 ruled, corrects LD-57; sole db/ exception for C6-T19). Class-G range 001-004, in the production subset. Rows verbatim from CR-C6-022 (08 A13 D-34).
-- Class G global template registry (02-TRD §7.2, 04-UI-UX §7); no PHI. params = the only allowed keys (REQ-SEC-070).
-- Idempotent: re-running inserts nothing new.
SET LOCAL ROLE lims_owner;

INSERT INTO reporting.g_message_templates (code, purpose, channels, params, default_texts) VALUES
  ('frontdesk.registration_confirmation', 'registration_confirmation', ARRAY['sms','whatsapp'], '[{"name":"lab_name","kind":"short_text"},{"name":"registered_time_hhmm","kind":"time_hhmm"},{"name":"ref","kind":"short_text"}]', '{}'),
  ('frontdesk.recollection_request', 'recollection_request', ARRAY['sms','whatsapp'], '[{"name":"lab_name","kind":"short_text"},{"name":"centre_phone","kind":"phone"}]', '{}'),
  ('reporting.report_ready', 'report_ready', ARRAY['whatsapp','sms','email'], '[{"name":"lab_name","kind":"short_text"},{"name":"url","kind":"url"}]', '{}'),
  ('reporting.critical_value_alert', 'critical_value_alert', ARRAY['sms','whatsapp'], '[{"name":"lab_name","kind":"short_text"},{"name":"lab_phone","kind":"phone"},{"name":"ref","kind":"short_text"}]', '{}'),
  ('engagement.login_otp', 'otp', ARRAY['sms'], '[{"name":"otp_code","kind":"otp_code"},{"name":"lab_name","kind":"short_text"},{"name":"minutes","kind":"minutes"}]', '{}'),
  ('analytics.report_ready', 'scheduled_report_ready', ARRAY['email'], '[{"name":"lab_name","kind":"short_text"},{"name":"schedule_name","kind":"label_text"},{"name":"url","kind":"staff_url"}]', '{}'),
  ('reporting.dues_due', 'dues_reminder', ARRAY['sms','whatsapp'], '[{"name":"lab_name","kind":"short_text"},{"name":"amount_text","kind":"short_text"},{"name":"url","kind":"url"}]', '{}'),
  ('homecollection.visit_assigned', 'visit_assignment', ARRAY['sms'], '[{"name":"route_date","kind":"short_text"},{"name":"visit_count","kind":"short_text"}]', '{}'),
  ('homecollection.visit_scheduled', 'booking_confirmation', ARRAY['sms'], '[{"name":"window_start_local","kind":"short_text"},{"name":"window_end_local","kind":"short_text"}]', '{}'),
  ('engagement.booking_cancelled', 'booking_cancelled', ARRAY['sms'], '[{"name":"lab_name","kind":"short_text"},{"name":"datetime","kind":"datetime"},{"name":"booking_no","kind":"short_text"}]', '{}'),
  ('engagement.booking_reminder', 'booking_reminder', ARRAY['sms'], '[{"name":"lab_name","kind":"short_text"},{"name":"datetime","kind":"datetime"},{"name":"booking_no","kind":"short_text"}]', '{}')
  ON CONFLICT (code) DO NOTHING;
