# hl7v2_generic_oru golden cases

All cases are **synthetic generic** (02-TRD §15.2): hand-built ORU^R01 messages against the 02-TRD §6.2 defaults, which are
UNVERIFIED per vendor. No manual, no real capture, no patient data (PID carries an id only). Barcodes `E26000000nn`, values invented.

| Case | Covers |
|---|---|
| oru-patient | MSH-10 / MSH-7, OBR.3 sample id, OBX.3/5/6/8/14, OBX.14 empty -> OBR.7, text value |
| qc-sample-pattern | QC via `qcSampleIdPatterns` `^QC-`; control id = sample id |
| malformed-no-msh | no MSH segment -> `instruments.message_malformed` |
