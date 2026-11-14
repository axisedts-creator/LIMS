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
| qry-found | H80-T03 host query QRY^Q02, barcode `E2600000042` (QRD-8); replies `qry-found.qck.hl7` (QCK OK) and `qry-found.dsr.hl7` (DSR, demographics and detection mode only, no test list) |
| qry-not-found | QRY^Q02, barcode `E2600000099`, no order; reply `qry-not-found.qck.hl7` (QCK NF, no DSR) |
| qry-no-hba1c-order | QRY^Q02, barcode `E2600000043`, order exists but not HbA1c; reply `qry-no-hba1c-order.qck.hl7` (QCK NF, no DSR) |
| ack-q03-mismatched-id | ACK^Q03 whose MSA-2 (`126`) does not match the sent control id (LD-139 ReplyAckMatchControlId) |

Query cases (LD-148): restored byte for byte from `git show cd49d38e~1:services/api/src/modules/instruments/__tests__/fixtures/truth_h80e/<name>`; same synthetic provenance as above, no patient data.
