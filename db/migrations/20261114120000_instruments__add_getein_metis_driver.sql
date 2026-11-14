-- MET-T04 / CR-C7-020 (approved with C7 09-ADDENDUM-GETEIN-METIS, LD-163 2026-11-14): instruments.g_drivers row for the Getein Metis analyser.
-- Addendum §8. Forward-only; status stays 'generic' so host query is inert until the commissioning checklist (§9) is signed.
-- Promotion to 'verified' is a later reviewed migration. No UPDATE here.
-- LD-161: repo convention, single role switch like every other migration (permission denied for schema instruments otherwise).
SET LOCAL ROLE lims_owner;
INSERT INTO instruments.g_drivers (code, display_name, protocol, vendor, status, driver_version, cap_host_query, cap_worklist_download, cap_qc, cap_attachments, cap_calibration, manual_title, manual_document_id, manual_revision) VALUES
 ('getein_metis','Getein Metis series analyser (HL7 v2)','hl7v2','Getein','generic','0.1.0',true,false,true,false,false,
  'HL7 Communication Protocol (Applicable to Metis Series Analyzers)','getein-metis-hl7-communication-protocol','unversioned');
