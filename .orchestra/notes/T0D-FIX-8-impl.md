# T0D-FIX-8 impl (writer)
- Changed: services/api/src/modules/analytics/handlers/getMisReportPage.ts only (1 guard + LD-455 comment).
- [CONV] min_repeat_count is put into filters only when MIS_ALL_DEFS[code].params lists it; otherwise dropped before checkMisFilters, whatever its value (contract default 2 no longer 400s bill_of_the_day and the 8 other non-listing reports).
- repeated_patient / repeated_test unchanged: checkInt 2..1000 then checkMisFilters; 1, 1001, 'two' still 400 common.validation_failed.
- Audit (3): only other shared schema default is limit=50, accepted by all reports; nothing to fix. No contract, migration, permission or web change.
- Tests: misReportPage.repeatDefault + misReportPage.handler: 156/156 pass; tsc --noEmit clean.
- Full analytics api suite: 2232 pass; not from this change: 4 *.live tests need LIMS_TEST_APP_URL (no Docker), boot.test timed out under full-suite load (300s), ci/no-commission flags apps/web/src/features/analytics/report-codes.ts (pre-existing, web file untouched here). Web suite not affected (api-only change).

## main side
T0D-FIX-8 impl (writer).
- Changed: services/api/src/modules/analytics/handlers/getMisReportPage.ts only (+3/-1).
- Fix: min_repeat_count is read only when the report definition's params list it (repeated_patient, repeated_test); other codes drop it, any value, before checkInt/checkMisFilters. [CONV] LD-455 cited in code comment; contract untouched.
- repeated_* keep the existing checkInt(2..1000) -> 400 common.validation_failed path unchanged.
- Checks: vitest src/modules/analytics -> 2835 pass, 1 fail (pre-existing ci/no-commission.test.ts flags apps/web/src/features/analytics/report-codes.ts, not this task); 4 *.live.test.ts files need LIMS_TEST_APP_URL (DB not booted). tsc --noEmit clean.
- Open: no-commission web hit belongs to the web owner; no -left.md needed (audit: limit default accepted everywhere).
