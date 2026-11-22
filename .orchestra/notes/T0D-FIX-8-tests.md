# T0D-FIX-8 tests (tester)
- New: services/api/src/modules/analytics/handlers/__tests__/misReportPage.repeatDefault.handler.test.ts (64 tests; data seam runMisReport mocked, real handler, synthetic).
- Covers: all 11 codes with dates + validator defaults (min_repeat_count=2, limit=50) -> 200; default never reaches filters of the 9 non-listing reports; bill_of_the_day as the web sends it; any value ignored for non-listing reports; repeated_patient/repeated_test 2,5,1000 ok, 1,1001,0,-1,1.5,'two',null -> 400; permission-first, date range, limit, tenant, money-code access log still hold.
- Audit (3): only other schema default in the shared list is limit=50, accepted by every report (test included, passes now). Nothing outside analytics found.
- Run: pnpm --dir services/api exec vitest run src/modules/analytics/handlers/__tests__/misReportPage.repeatDefault.handler.test.ts
- Now: 32 fail (the 9 non-listing reports x default/any value, "Invalid min_repeat_count" from handlers/getMisReportPage.ts:38-39), 32 pass (repeated_* validation and gate guards).
- Existing misReportPage.handler.test.ts is untouched; the writer should keep it green (its repeated_patient min_repeat_count 1 / 'two' cases still expect 400).
