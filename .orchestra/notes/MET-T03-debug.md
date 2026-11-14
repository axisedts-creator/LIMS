# MET-T03 debugger
- Cause: 38 of 54 tests fail with ENOENT. `drivers/getein_metis/testdata/qry-*.hl7` and `ack-q03-mismatched-id.hl7` were never committed (tester commit 30e56eb2 has only the test file + notes). Not an implementation defect; the writer's note says all 54 pass with temporary goldens built from addendum s5.
- Fix: none in implementation code. Goldens are test fixtures; I may not author them. See MET-T03-dispute.md. Tester must commit the 9 golden files listed in MET-T03-tests.md.
## round 2 (11:28 verify)
- Cause unchanged: 38/54 ENOENT, `getein_metis/testdata/qry-*.hl7`, `*.qck.hl7`, `qry-found.dsr.hl7`, `ack-q03-mismatched-id.hl7` still absent from the tree and from git history. Not an implementation defect.
- Fix: none in implementation code; goldens are test fixtures I may not author. Tester side must commit them (see MET-T03-ruling.md, MET-T03-dispute-202611141123.md).
## round 3 (11:30 verify)
- Cause unchanged: 38/54 ENOENT, `getein_metis/testdata/qry-*.hl7`, `*.qck.hl7`, `qry-found.dsr.hl7`, `ack-q03-mismatched-id.hl7` absent from tree (git status clean). Not an implementation defect.
- Fix: none in implementation code; goldens are test fixtures I may not author. Tester must commit them; dispute already filed in MET-T03-dispute-202611141123.md. Stopping.
## round 4 (11:31 verify)
- Cause unchanged: 38/54 ENOENT, getein_metis/testdata/qry-*.hl7, *.qck.hl7, qry-found.dsr.hl7, ack-q03-mismatched-id.hl7 absent from tree (git clean). Not an implementation defect.
- Fix: none in implementation code; goldens are test fixtures I may not author. Dispute stands (MET-T03-dispute-202611141123.md). Stopping.
