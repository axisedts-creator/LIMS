# H80-T03 tests (tester)
- Test: `services/api/src/modules/instruments/__tests__/hostQuery.truth_h80e.test.ts`; goldens: `__tests__/fixtures/truth_h80e/*.hl7` (qry-found(.qck/.dsr), qry-not-found(.qck), qry-no-hba1c-order(.qck), ack-q03-mismatched-id).
- Run: `.orchestra\notes\H80-T03-verify.cmd` (= `pnpm --dir services/api exec vitest run src/modules/instruments/__tests__/hostQuery.truth_h80e.test.ts`).
- Covers: extract QRD-8.1 (empty/>40 => message_malformed), QCK/DSR build, OK/NF, byte-exact goldens, MSH-7 = ctx.receivedAt in instrument tz, escaping/injection, replay, inert while generic (service gate), end-to-end with driver forced `verified` in test only.
- SEAM 1: parse(QRY) must return ok host_query with ONE record {recordClass:'host_query', sampleBarcode}; extract maps records (as hostQuery.helpers fake driver). Bad barcode may fail in parse or extract.
- SEAM 2: HostQueryAnswer has only sex/ageDays, so DSP-1..4, 6, 13 are empty in goldens (addendum example fills them: needs a CR extending HostQueryAnswer; DSP-4 never from ageDays).
- SEAM 3: QCK/DSR MSH-3/4 = Truth/Truth-H80E (§5 example); CR-ended segments incl. final CR, no MLLP bytes; ids `<MSH-10>01/02`; control ids/MSA-2 HL7-escaped; found + tests[] => NF.
- Test-only edits; no implementation written. Expected now: fails (extractHostQueryBarcodes/buildHostQueryReply undefined).
