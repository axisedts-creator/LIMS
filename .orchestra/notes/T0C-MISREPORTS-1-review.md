APPROVE
Scope: diff 06307a80..HEAD (03e14605b) = tester revision per ruling only: notes rename/ruling + db/tests/analytics/T0C-MISREPORTS-1_report_codes.test.sql:41-42.
- Change 8 -> 9 columns verified: db/migrations/20261105002100_analytics__create_analytics_schema.sql:16-20 defines 9 columns (code, display, system, system_version, sort_order, is_active, is_exportable, is_schedulable, created_at); 20261117230000 only drops g_cs_report_codes__no_c_word__ck (LD-342), adds no column. Case kept, not weakened, matches ruling exactly.
- No names invented, no PHI, no secrets, no RLS/permission/route surface touched, only owned test/notes paths.
- Not re-run here: pgTAP suite (reviewer read-only). Uncommitted probe-row fixture edits (engagement.sql, partners.sql) are outside this diff and not reviewed.
