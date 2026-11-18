-- Hand-written seed (T0B-VERLEVEL-1 arbiter ruling 2026-11-18): C5 global coded sets, verbatim from spec/chunks/C5-lab-workflow/05-SCHEMA.md §2
-- ("Seed (global g_cs_*, system = 'lims', system_version = '1')"; §2 is listed under C0 db/seeds). Class G, all environments; no PHI.
-- Module-only amendment codes (module_phase_progression, module_preliminary_update, supplementary_report) are accepted only via
-- LabPort.submitModuleResult (08 R1 / D-61). Displays without a spec text use the code [CONV]. Fixed ids; idempotent (ON CONFLICT DO NOTHING).
SET LOCAL ROLE lims_owner;

INSERT INTO lab.g_cs_rejection_reasons (id, code, display, system, system_version, sort_order) VALUES
  ('01a1c5c5-0001-7000-8000-000000000001', 'haemolysed', 'Haemolysed', 'lims', '1', 10),
  ('01a1c5c5-0001-7000-8000-000000000002', 'clotted', 'Clotted', 'lims', '1', 20),
  ('01a1c5c5-0001-7000-8000-000000000003', 'qns', 'Quantity not sufficient', 'lims', '1', 30),
  ('01a1c5c5-0001-7000-8000-000000000004', 'mislabelled', 'Mislabelled', 'lims', '1', 40),
  ('01a1c5c5-0001-7000-8000-000000000005', 'unlabelled', 'Unlabelled', 'lims', '1', 50),
  ('01a1c5c5-0001-7000-8000-000000000006', 'wrong_container', 'Wrong container', 'lims', '1', 60),
  ('01a1c5c5-0001-7000-8000-000000000007', 'delayed_transport', 'Delayed transport', 'lims', '1', 70)
ON CONFLICT DO NOTHING;

INSERT INTO lab.g_cs_return_reasons (id, code, display, system, system_version, sort_order) VALUES
  ('01a1c5c5-0002-7000-8000-000000000001', 'transcription_error', 'transcription_error', 'lims', '1', 10),
  ('01a1c5c5-0002-7000-8000-000000000002', 'rerun_requested', 'rerun_requested', 'lims', '1', 20),
  ('01a1c5c5-0002-7000-8000-000000000003', 'sample_issue', 'sample_issue', 'lims', '1', 30),
  ('01a1c5c5-0002-7000-8000-000000000004', 'review_requested', 'review_requested', 'lims', '1', 40),
  ('01a1c5c5-0002-7000-8000-000000000005', 'input_changed', 'input_changed', 'lims', '1', 50),
  ('01a1c5c5-0002-7000-8000-000000000006', 'module_resubmitted', 'module_resubmitted', 'lims', '1', 60)
ON CONFLICT DO NOTHING;

INSERT INTO lab.g_cs_amendment_reasons (id, code, display, system, system_version, sort_order) VALUES
  ('01a1c5c5-0003-7000-8000-000000000001', 'transcription_error', 'transcription_error', 'lims', '1', 10),
  ('01a1c5c5-0003-7000-8000-000000000002', 'instrument_error', 'instrument_error', 'lims', '1', 20),
  ('01a1c5c5-0003-7000-8000-000000000003', 'wrong_patient_sample', 'wrong_patient_sample', 'lims', '1', 30),
  ('01a1c5c5-0003-7000-8000-000000000004', 'calculation_error', 'calculation_error', 'lims', '1', 40),
  ('01a1c5c5-0003-7000-8000-000000000005', 'clinical_review', 'clinical_review', 'lims', '1', 50),
  ('01a1c5c5-0003-7000-8000-000000000006', 'other', 'other', 'lims', '1', 60),
  ('01a1c5c5-0003-7000-8000-000000000007', 'module_phase_progression', 'Final after preliminary report', 'lims', '1', 70),
  ('01a1c5c5-0003-7000-8000-000000000008', 'module_preliminary_update', 'Updated preliminary report', 'lims', '1', 80),
  ('01a1c5c5-0003-7000-8000-000000000009', 'supplementary_report', 'Supplementary report (addendum)', 'lims', '1', 90)
ON CONFLICT DO NOTHING;

INSERT INTO lab.g_cs_exception_discard_reasons (id, code, display, system, system_version, sort_order) VALUES
  ('01a1c5c5-0004-7000-8000-000000000001', 'qc_or_calibrator_sample', 'qc_or_calibrator_sample', 'lims', '1', 10),
  ('01a1c5c5-0004-7000-8000-000000000002', 'test_sample', 'test_sample', 'lims', '1', 20),
  ('01a1c5c5-0004-7000-8000-000000000003', 'duplicate_run', 'duplicate_run', 'lims', '1', 30),
  ('01a1c5c5-0004-7000-8000-000000000004', 'wrong_instrument_setup', 'wrong_instrument_setup', 'lims', '1', 40),
  ('01a1c5c5-0004-7000-8000-000000000005', 'other', 'other', 'lims', '1', 50)
ON CONFLICT DO NOTHING;
