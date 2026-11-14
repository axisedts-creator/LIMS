# getein_metis golden cases

All cases are **synthetic**: hand-built from the layouts in `spec/chunks/C7-instrument-integration/09-ADDENDUM-GETEIN-METIS.md` §3–§4 (field positions only; no text was copied from the manual).
No real capture, no patient data: the PID name field is left empty, barcodes are `MT26000000nn`, values are invented.

| Case | Covers |
|---|---|
| oru-patient | M1: OBR-2 barcode, OBX-3 item id, OBX-5/6, OBX-8 flags (`H~A` = two flags), OBX-14 time, OBR-7 fallback, OBX-17 retest |
| oru-patient-qualitative | M1: `ST` rows with empty OBX-5, value taken from OBX-9 (`+`, `-`) |
| oru-patient-empty-obx-time | M1: empty OBX-14 falls back to OBR-7 |
| oru-qc | M3: MSH-16 = 2, one record per control entry, lot and expiry told apart by content, level L/H mapped to low/high |
| oru-qc-lists-differ | M3: OBR-20 shorter than the other lists -> `instruments.message_malformed` |
| oru-calibration | M4: MSH-16 = 1 -> messageKind `other`, no records (D-MET-2) |
| malformed-no-msh | no MSH segment -> `instruments.message_malformed` |

Host query cases (`qry-*`) belong to MET-T03.
