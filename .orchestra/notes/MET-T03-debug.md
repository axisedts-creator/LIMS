# MET-T03 debugger
- Cause: 38 of 54 tests fail with ENOENT. `drivers/getein_metis/testdata/qry-*.hl7` and `ack-q03-mismatched-id.hl7` were never committed (tester commit 30e56eb2 has only the test file + notes). Not an implementation defect; the writer's note says all 54 pass with temporary goldens built from addendum s5.
- Fix: none in implementation code. Goldens are test fixtures; I may not author them. See MET-T03-dispute.md. Tester must commit the 9 golden files listed in MET-T03-tests.md.
