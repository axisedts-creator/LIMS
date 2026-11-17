TESTS_WRONG — db/tests/analytics/T0C-MISREPORTS-1_report_codes.test.sql:42 pins 8 columns; the table has always had 9. Change the expected value 8 to 9 and the description/comment (line 41-42) to "keeps its 9 columns"; keep the case.
Reasons:
- db/migrations/20261105002100_analytics__create_analytics_schema.sql:16-20 creates analytics.g_cs_report_codes with 9 columns: code, display, system, system_version, sort_order, is_active, is_exportable, is_schedulable, created_at.
- No migration alters its columns: the only ALTER TABLE on it is db/migrations/20261117230000_analytics__add_mis_report_support.sql:15 (DROP CONSTRAINT IF EXISTS g_cs_report_codes__no_c_word__ck), which LD-342 explicitly allows ("the migration drops only the check g_cs_report_codes__no_c_word__ck").
- Task brief done_when (2)/(6) and LD-321 MIGRATIONS: 230000 adds a column/index only if needed; none was added, so the case's intent ("no supporting column was needed") is unchanged count = 9.
- No spec line requires 8 columns; the 8 is a tester miscount, not a requirement.
