# MET-T03 impl (writer)
- Files: new `drivers/getein_metis/hostQuery.ts` (parseQuery, extractHostQueryBarcodes, buildHostQueryReply); `getein_metis/index.ts` (QRY branch in parse, two functions on the driver). No test, spec or H80E file touched.
- [CONV] parse(QRY^Q02) stashes the raw QRD/QRF + mode in a WeakMap keyed by the returned ParseOk (ParseOk has no room); replay re-parses the stored bytes, so it is byte-identical. Mode (b)/(c) = QRD-8 empty and QRF-2..5 filled: records [], extract [], reply NF.
- [CONV] Standard delimiters only for QRY (else message_malformed); echoed QRD/QRF have control chars (0x0B/0x1C etc.) stripped so a query cannot smuggle MLLP framing into the reply.
- BLOCKER: the tester's commit has NO golden files (`testdata/qry-*.hl7`, `ack-q03-mismatched-id.hl7`): 38 of 54 tests fail with ENOENT as committed. With temporary goldens I built from addendum §5 (deleted again, not mine to author) all 54 pass, 4 todo. Tester must commit the goldens.
- `dsr_item_details=full` and name_script/specimen_type_map have no effect until CR-C7-018 (HostQueryAnswer lacks the fields); DSP-1,3,4,12,23 empty, DSP-26 `others`. Service rejects an empty barcode list (modes b/c not end-to-end): needs a CR, as the tester noted.
- Re-run 2026-11-14 11:27 after arbiter ruling TESTS_WRONG: still 38 failed / 16 passed / 4 todo, all 38 ENOENT on missing goldens; no implementation change made. Waiting on tester.
- Not run: full repo suite (background run was still going), lint. tsc: 0 errors in getein_metis (repo has unrelated tsc config errors).
