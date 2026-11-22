# T0D-FIX-1 dispute 2 (writer) — tests contradict each other
After the ruling fix (e41ed0d85): 3851 pass, 3 fail, all the same assertion "searchOrderables statement count <= 4":
- catalog/__tests__/integration/orderables.search.test.ts:214
- catalog/__tests__/perf/orderables.search.perf.test.ts:51 (1x and 10x)
Conflict: catalog/__tests__/integration/tests.defaultprice.test.ts:50 ("searchOrderables carries it too") requires default_price_paisa on search,
and contracts/openapi/catalog.yaml:10485-10489 puts it on OrderableSummary. That needs a read of the price tables = 1 more statement (5).
It cannot fold into an existing statement: catalogDb.ts / testsDb.ts fakes are one table per statement, no joins (testsDb.ts:27), and price lives in 3 other tables.
Checked: removing the price from search makes the 3 pass but fails tests.defaultprice.test.ts:50, so no implementation satisfies both.
Proposal (tester, arbiter ok needed): raise the budget to 5 in both files. Still constant per page (one tenant-scoped price statement, no per-row lookup), which is what the budget guards.
Implementation unchanged; tsc clean.
