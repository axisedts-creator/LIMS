# T0C-MISREPORTS-1 dispute (writer, 2026-11-17)
- db/tests/analytics/T0C-MISREPORTS-1_report_codes.test.sql:42 expects analytics.g_cs_report_codes to have 8 columns; it has 9 since its creation.
- Evidence: db/migrations/20261105002100_analytics__create_analytics_schema.sql:17-20 defines code, display, system, system_version, sort_order, is_active, is_exportable, is_schedulable, created_at (9).
- 20261117230000_analytics__add_mis_report_support.sql adds no column (only DROP CONSTRAINT no_c_word and INSERT rows); pgTAP reports have 9 / want 8.
- Fix (tester): pin 9 (or compare to the pre-migration count). Intent of the case ("no supporting column was needed") still holds.
- Everything else green: vitest misreports1-openapi + c8-openapi 293/293; pgTAP 22/23 in the report_codes suite, C8 behaviour and schema suites clean.

## Dispute (debugger, 2026-11-17 22:2x): pgTAP test 17 miscounts columns
Test: db/tests/analytics/T0C-MISREPORTS-1_report_codes.test.sql:42 expects `g_cs_report_codes` to have 8 columns; verify log: `not ok 17 ... have: 9 want: 8`.
Spec/base: db/migrations/20261105002100_analytics__create_analytics_schema.sql:16-25 defines 9 columns (code, display, system, system_version, sort_order, is_active, is_exportable, is_schedulable, created_at). Our migration 20261117230000 adds none (DROP CONSTRAINT + INSERT only), so 9 is the correct unchanged count.
Implementation is right; the test's expected value must be 9 (tester change). Not editing the test.
