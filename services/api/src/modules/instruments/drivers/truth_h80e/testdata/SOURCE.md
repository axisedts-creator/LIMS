# truth_h80e golden cases

All cases are **synthetic**: hand-built from the layouts in `spec/chunks/C7-instrument-integration/08-ADDENDUM-TRUTH-H80E.md` §3–§4
(manual HL7 Interface User Manual v1.5, field positions read from page images; U positions unverified). No real capture, no patient data:
the patient name field is left empty, barcodes are `E26000000nn`, values are invented.

| Case | Covers |
|---|---|
| oru-patient | M1: OBR-3 barcode, OBX-3/5/6, OBX-8 mark flag, result time in OBX-13 |
| oru-qc | M3: no PID, OBR-3 batch as control id and lot, OBR-5 level L mapped to low, OBX-8 `null`, time in OBX-14 |
| oru-chromatogram | ED row becomes one attachment record (payload not parsed here, H80-T04) |
| malformed-no-msh | no MSH segment -> `instruments.message_malformed` |
