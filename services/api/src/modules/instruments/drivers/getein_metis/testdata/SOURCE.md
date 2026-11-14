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

| qry-found | §5 mode (a): QRD-8 = MT2600000042, id 61. Expected `qry-found.qck` (QAK OK) and `qry-found.dsr` (QRD/QRF echoed, DSP-5 F, DSP-21 barcode, DSP-24 N, DSP-26 others, DSP-29/30 = `100^^^`/`101^^^` id_only, DSC empty) for a female routine answer with two mapped tests |
| qry-not-found | §5 mode (a), unknown barcode MT2600000099, id 63 -> `qry-not-found.qck` (QAK NF), no DSR |
| qry-no-mapped-test | §5 mode (a), MT2600000043 with no pending test mapped to this instrument, id 64 -> `qry-no-mapped-test.qck` (QAK NF), no DSR |
| qry-sample-range | §5 mode (b): QRD-8 empty, QRF-4/5 = 1/5, id 65 -> no barcode, `qry-sample-range.qck` (QAK NF, unsupported_query_mode, D-MET-1) |
| qry-time-range | §5 mode (c): QRD-8 empty, QRF-2/3 = time range, id 66 -> no barcode, `qry-time-range.qck` (QAK NF, unsupported_query_mode, D-MET-1) |
| ack-q03-mismatched-id | §6: ACK^Q03 from the analyser, MSH-10 62, MSA-2 99 (not the DSR id) -> accepted, messageKind `other`, no records |

All reply bytes (`*.qck.hl7`, `*.dsr.hl7`) were written by hand from the §5 layout (MSH-7 = receivedAt 05:02:01Z in Asia/Kathmandu = 20261114104701; MSH-10 = MSA-2 = query MSH-10; trailing pipe on every segment), not captured from the implementation (LD-169). LF in the files; the test converts to CR.
