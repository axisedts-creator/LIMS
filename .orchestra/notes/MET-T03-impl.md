# MET-T03 impl (writer, round 2 after LD-169)
- Files: `drivers/getein_metis/hostQuery.ts`, `index.ts` (unchanged this round); NEW 12 goldens in `drivers/getein_metis/testdata/` (6 inputs qry-found/not-found/no-mapped-test/sample-range/time-range, ack-q03-mismatched-id; 6 replies *.qck, qry-found.dsr) + rows in `testdata/SOURCE.md`. No test, spec or H80E file touched.
- [CONV] Goldens hand-built from 09-ADDENDUM §5/§6 layout (LD-169), not captured: MSH-10 = MSA-2 = query id (61, 63-66), MSH-7 20261114104701, trailing pipe, QRD/QRF echoed (query's own, so DSR QRD-8 carries the barcode; §5 example's empty QRD-8 is U14), DSP-29/30 `100^^^`/`101^^^`, `DSC||`. Synthetic MT26000000nn, no PID.
- [CONV] parse(QRY^Q02) keeps raw QRD/QRF + mode in a WeakMap keyed by ParseOk; mode (b)/(c) = QRD-8 empty and QRF-2..5 filled -> extract [], reply NF.
- Verify (`MET-T03-verify.cmd` command): 54 passed, 4 todo, 0 failed.
- Instruments folder run: 5 failed, none in getein_metis host query: g_drivers row for getein_metis missing (CR-C7-020, 2 tests), synthetic-scan flags `apps/bridge-agent/testdata/sessions/metis-*.session.json` PID.5 (not C7b-T03 files), signing Go copy, boot test timeout.
- Open: name_script/specimen_type_map/dsr_item_details=full have no effect until CR-C7-018; service rejects empty barcode list (modes b/c end-to-end) needs a CR.
