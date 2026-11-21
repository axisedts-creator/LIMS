-- MET-T04 (C7 09-ADDENDUM-GETEIN-METIS §8, §10 CR-C7-020, LD-163): instruments.g_drivers row for getein_metis. Tester-written; fails until the reviewed migration (via CR to C0) lands.
-- Run from the repo root: pg_prove -d <db> db/tests/instruments/MET-T04.getein_metis_driver.test.sql   (pgTAP in schema `extensions`; ALL migrations loaded through db/tests/run-suites.sh = the full bootstrap on a fresh database; superuser). Read-only, rolled back.
-- If the migration lacked `SET LOCAL ROLE lims_owner;` (LD-161) the bootstrap itself fails with "permission denied for schema instruments" before this file runs.
BEGIN;
SET search_path = extensions, public, pg_catalog;
SELECT plan(13);

SELECT is((SELECT count(*)::int FROM instruments.g_drivers WHERE code = 'getein_metis'), 1, 'MET-T04: exactly one getein_metis row');
SELECT is((SELECT protocol FROM instruments.g_drivers WHERE code = 'getein_metis'), 'hl7v2', 'MET-T04: protocol hl7v2');
SELECT is((SELECT status FROM instruments.g_drivers WHERE code = 'getein_metis'), 'generic', 'MET-T04: status generic, never verified before the commissioning checklist (LD-163, §0)');
SELECT is((SELECT driver_version FROM instruments.g_drivers WHERE code = 'getein_metis'), '0.1.0', 'MET-T04: driver_version 0.1.0');
SELECT is((SELECT ARRAY[cap_host_query, cap_worklist_download, cap_qc, cap_attachments, cap_calibration] FROM instruments.g_drivers WHERE code = 'getein_metis'),
  ARRAY[true, false, true, false, false], 'MET-T04: capabilities hostQuery/qc on; worklistDownload/attachments/calibration off (§8)');
SELECT is((SELECT manual_title FROM instruments.g_drivers WHERE code = 'getein_metis'), 'HL7 Communication Protocol (Applicable to Metis Series Analyzers)', 'MET-T04: manual title');
SELECT is((SELECT manual_document_id FROM instruments.g_drivers WHERE code = 'getein_metis'), 'getein-metis-hl7-communication-protocol', 'MET-T04: manual document id');
SELECT is((SELECT manual_revision FROM instruments.g_drivers WHERE code = 'getein_metis'), 'unversioned', 'MET-T04: manual revision');
SELECT is((SELECT is_active FROM instruments.g_drivers WHERE code = 'getein_metis'), true, 'MET-T04: active');
SELECT ok((SELECT char_length(display_name) BETWEEN 1 AND 80 FROM instruments.g_drivers WHERE code = 'getein_metis'), 'MET-T04: display_name present and within the CHECK');
SELECT ok((SELECT vendor ~ 'Getein' FROM instruments.g_drivers WHERE code = 'getein_metis'), 'MET-T04: vendor names Getein');
-- the row is added, not substituted: the six existing drivers keep their rows
SELECT is((SELECT count(*)::int FROM instruments.g_drivers WHERE code <> 'getein_metis'), 6, 'MET-T04: the six earlier drivers are untouched');
SELECT is((SELECT count(*)::int FROM instruments.g_drivers WHERE status = 'verified' OR cap_calibration OR cap_worklist_download), 0, 'MET-T04: still no verified driver / calibration / worklist capability (B2)');

SELECT * FROM finish();
ROLLBACK;
