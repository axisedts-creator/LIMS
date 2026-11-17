Cause: pgTAP test 17 (T0C-MISREPORTS-1_report_codes.test.sql:42) wants 8 columns in analytics.g_cs_report_codes; base migration 20261105002100 has always had 9, our migration adds none. Test miscount, not implementation bug.
Fix: none in code (tests off limits); dispute written to T0C-MISREPORTS-1-dispute.md: expected value must be 9. All vitest (293) green; only this case red.
