T0D-FIX-8 impl (writer).
- Changed: services/api/src/modules/analytics/handlers/getMisReportPage.ts only (+3/-1).
- Fix: min_repeat_count is read only when the report definition's params list it (repeated_patient, repeated_test); other codes drop it, any value, before checkInt/checkMisFilters. [CONV] LD-455 cited in code comment; contract untouched.
- repeated_* keep the existing checkInt(2..1000) -> 400 common.validation_failed path unchanged.
- Checks: vitest src/modules/analytics -> 2835 pass, 1 fail (pre-existing ci/no-commission.test.ts flags apps/web/src/features/analytics/report-codes.ts, not this task); 4 *.live.test.ts files need LIMS_TEST_APP_URL (DB not booted). tsc --noEmit clean.
- Open: no-commission web hit belongs to the web owner; no -left.md needed (audit: limit default accepted everywhere).
