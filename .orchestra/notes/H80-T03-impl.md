# H80-T03 impl (writer)
- Implementation (extractHostQueryBarcodes, buildHostQueryReply, wiring in truth_h80e/index.ts) was already in the lane; no code edited this pass.
- LD-148: restored 8 goldens byte for byte from cd49d38e~1 into drivers/truth_h80e/testdata/: qry-found{,.qck,.dsr}.hl7, qry-not-found{,.qck}.hl7, qry-no-hba1c-order{,.qck}.hl7, ack-q03-mismatched-id.hl7.
- Added the 4 query cases to testdata/SOURCE.md.
- Run: vitest hostQuery.truth_h80e.test.ts -> 34/34 passed.
- Open: full C7 suite / lint / typecheck not run this pass; U positions still await a real capture (LD-139).
