# astm_generic_e1394 golden cases

All cases are **synthetic generic** (02-TRD §15.2): hand-built against the 02-TRD §6.2 default field table, which is UNVERIFIED
(no CLSI LIS2-A2 text opened). No manual, no real instrument capture, no patient data. Barcodes `E26000000nn`, QC ids `QC-…`, values invented.

| Case | Covers |
|---|---|
| patient-two-results | H/P/O/R/L, O.3 sample id, R.3 comp 4 code, repeat-split flags, R.13 time, H.14 message time |
| qc-sample-pattern | QC via `qcSampleIdPatterns` `^QC-`; control id = matched sample id |
| malformed-no-header | no H record -> `instruments.message_malformed` |
