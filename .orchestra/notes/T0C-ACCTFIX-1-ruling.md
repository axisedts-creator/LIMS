TESTS_WRONG — acct1-openapi.test.ts:534 pins "only 20261117130000_engagement__add_portal_content.sql may follow" the ACCT-1 migration; the spec requires no such ordering. Tester change: replace line 534 with a check that every migration after MIG has a timestamp greater than 20261117120000 (already implied by the sort), or simply drop the "only the portal content migration may follow" loop; keep lines 530-533 and 535 unchanged.
Reasons:
1. grep of spec/ for 20261117120000, 20261117130000, billing__add_lab_accounting, portal_content, "newest migration": no matches. The allow-list of one later file is a test-author pin, not a spec rule.
2. The test's own title (acct1-openapi.test.ts:529) says "newest migration unless a later wave-2 file exists"; line 534 contradicts that title by hard-coding one file.
3. Later files 20261117140000_frontdesk__narrow_parity_table_grants.sql and 20261117170000_catalog__test_management_parity.sql (plus 200000, 210000) arrived from main (commits 2be9cb619, 9a08dfde9, f3e43a9e1); this branch adds no migration.
4. Task brief (inbox T0C-ACCTFIX-1-arbiter.md:15-20) forbids any migration change, so no implementation fix exists; brief line 20 lets the tester update stale pins in existing contract tests.
5. Not a CR: spec is silent, not contradictory; LD-334/LD-335 do not touch migration ordering.
