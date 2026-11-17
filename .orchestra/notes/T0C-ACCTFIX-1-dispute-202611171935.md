# T0C-ACCTFIX-1 dispute (debugger)
Failing: acct1-openapi.test.ts:534 "only the portal content migration may follow" (expected 20261117130000_engagement__add_portal_content.sql, got 20261117140000_frontdesk__narrow_parity_table_grants.sql).
Cause: stale pin, not this task. Test title itself says "newest migration unless a later wave-2 file exists". Migrations 20261117140000_frontdesk__narrow_parity_table_grants.sql and 20261117170000_catalog__test_management_parity.sql came from main (merges of lane C0-0B / T0C-TESTMGMT-1, commit 2be9cb619, 9a08dfde9). The test hard-codes one allowed later file.
Why no impl fix: only fix is deleting or renaming other tasks' migrations. Brief forbids any migration change (billing.yaml bounds/examples only); this task touches no migration.
Brief: "If an existing contract test pins ... that pin is stale ... the tester updates it" (done_when, last line, said of minimum 0; same stale-pin logic applies).
Request: lead rules; tester widens line 534 to allow the later wave-2 files (or drop the "only" clause). I did not edit the test.
