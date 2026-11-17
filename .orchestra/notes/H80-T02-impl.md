# H80-T02 impl (truth_h80e server driver, LD-139)
- Files: `drivers/truth_h80e/index.ts` (driver 0.1.0, hl7v2, status generic), `drivers/registry.ts` (+truth_h80e), `drivers/truth_h80e/testdata/` (oru-patient, oru-qc, oru-chromatogram, malformed-no-msh + SOURCE.md; PID-5 empty, synthetic barcodes).
- [CONV] Reuses `HL7` helpers from hl7v2_generic_oru and `malformed`/`MAX`/`localTime` from delimited.ts; reasons are constant strings (no PHI), PID never read.
- [CONV] U positions tolerant: result time = first 14-digit stamp in OBX-12..14 (QC falls back to OBR-7); detection_mode_field / type_flag_field / qc_level_map are options; patient vs QC decided by PID presence, not MSH-16.
- Tests: drivers-truth-h80e + drivers-registry + drivers-golden = 3 files, 120 passed (after tester applied ruling, AJV_OPTIONS in harness). No impl change needed post-ruling.
- Open: host query QRY/QCK/DSR = H80-T03; inline chromatogram payload = H80-T04; `ci-scripts` REAL-repo driver/migration check stays red until H80-T05 g_drivers migration lands.
