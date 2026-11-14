-- H80-T05 (C7 08-ADDENDUM-TRUTH-H80E §8, LD-139): instruments.g_drivers row for truth_h80e. Tester-written; fails until the reviewed migration (via CR to C0) lands.
-- Run from the repo root: pg_prove -d <db> db/tests/instruments/H80-T05.truth_h80e_driver.test.sql   (pgTAP in schema `extensions`; migrations loaded; superuser). Read-only, rolled back.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT plan(12);

SELECT is((SELECT count(*)::int FROM instruments.g_drivers WHERE code = 'truth_h80e'), 1, 'H80-T05: exactly one truth_h80e row');
SELECT is((SELECT protocol FROM instruments.g_drivers WHERE code = 'truth_h80e'), 'hl7v2', 'H80-T05: protocol hl7v2');
SELECT is((SELECT status FROM instruments.g_drivers WHERE code = 'truth_h80e'), 'generic', 'H80-T05: status generic, never verified before the commissioning checklist (LD-139, §0)');
SELECT is((SELECT driver_version FROM instruments.g_drivers WHERE code = 'truth_h80e'), '0.1.0', 'H80-T05: driver_version 0.1.0');
SELECT is((SELECT ARRAY[cap_host_query, cap_worklist_download, cap_qc, cap_attachments, cap_calibration] FROM instruments.g_drivers WHERE code = 'truth_h80e'),
  ARRAY[true, false, true, true, false], 'H80-T05: capabilities hostQuery/qc/attachments on; worklistDownload/calibration off (§8)');
SELECT is((SELECT manual_title FROM instruments.g_drivers WHERE code = 'truth_h80e'), 'HL7 Interface User Manual — Fully Automated Glycated Hemoglobin Analyzer', 'H80-T05: manual title');
SELECT is((SELECT manual_document_id FROM instruments.g_drivers WHERE code = 'truth_h80e'), 'truth-h80e-hl7-interface-user-manual', 'H80-T05: manual document id');
SELECT is((SELECT manual_revision FROM instruments.g_drivers WHERE code = 'truth_h80e'), '1.5', 'H80-T05: manual revision');
SELECT is((SELECT is_active FROM instruments.g_drivers WHERE code = 'truth_h80e'), true, 'H80-T05: active');
SELECT ok((SELECT char_length(display_name) BETWEEN 1 AND 80 FROM instruments.g_drivers WHERE code = 'truth_h80e'), 'H80-T05: display_name present and within the CHECK');
-- the row is added, not substituted: the five existing drivers keep their rows and status
SELECT is((SELECT count(*)::int FROM instruments.g_drivers WHERE code NOT IN ('truth_h80e', 'getein_metis')), 5, 'H80-T05: the five earlier drivers are untouched (getein_metis arrives later, MET-T04)');
SELECT is((SELECT count(*)::int FROM instruments.g_drivers WHERE status = 'verified' OR cap_calibration OR cap_worklist_download), 0, 'H80-T05: still no verified driver / calibration / worklist capability (B2)');

SELECT * FROM finish();
ROLLBACK;
