-- H80-T05 / CR-C7-019 (approved by lead, LD-139 2026-11-13): instruments.g_drivers row for the Truth H80E analyser.
-- C7 08-ADDENDUM-TRUTH-H80E §8. Forward-only; status stays 'generic' so host query is inert (§6.6 step 2).
-- Promotion to 'verified' is a later reviewed migration after the commissioning checklist (addendum §9 item 9). No UPDATE here.
-- LD-161: repo convention, single role switch like every other migration (permission denied for schema instruments otherwise).
SET LOCAL ROLE lims_owner;
INSERT INTO instruments.g_drivers (code, display_name, protocol, vendor, status, driver_version, cap_host_query, cap_worklist_download, cap_qc, cap_attachments, cap_calibration, manual_title, manual_document_id, manual_revision) VALUES
 ('truth_h80e','Truth H80E HbA1c (HL7 v2.3)','hl7v2','Truth','generic','0.1.0',true,false,true,true,false,
  'HL7 Interface User Manual — Fully Automated Glycated Hemoglobin Analyzer','truth-h80e-hl7-interface-user-manual','1.5');
