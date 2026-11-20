APPROVE
Reviewed git diff 5ea92c3cd..HEAD (tester 109eafb7a, writer b62aee46f) against LD-385, the ruling and the brief.
- LD-385 is done: catalog.yaml has no commission property. Migration 20261117220000 has commission_bp only on partners.party_commercial_setting (:68, :88), with no doctors__commission_bp__ck. A repo grep (outside spec/.orchestra/tests) found no doctor rate reference; generated types are clean.
- Tests follow the ruling exactly: NEWF = speciality, hospital, national_id_number. New asserts show the Doctor schemas have no commission-like property, the closed schema refuses commission_bp, and pgTAP asserts catalog.doctors has no commission column or constraint, including after re-apply. Every other assertion is kept, and the party_commercial_setting commission_bp asserts stay.
- db/tests/fixtures/probe-rows/billing.sql: the tester added probe rows for the FINCTRL tables (discount_authority, discount_reason, party_discount_slab, user_discount_limit) that came from main. The columns and CHECK ranges match migration 20261117190000. Data is synthetic, the change is additive and only touches test fixtures. Not a defect.
- No change to RLS, permissions, logs or secrets in this diff. Only owned paths are touched.
- Ran: npx vitest run tools/codegen/__tests__/partyset1-openapi.test.ts: 146/146 passed. pgTAP was not re-run by the reviewer; the writer notes report 0 not ok.
- Still open (not blocking): ruling item 4, the C13/C3 schema count re-pins (tester work).
