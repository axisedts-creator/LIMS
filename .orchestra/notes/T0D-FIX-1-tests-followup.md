Ruling applied: catalogDb.ts answers SELECT on catalog.price_list_items with no rows (asserts tenant id bound); testsDb.ts delegates to it (comment only). 30 catalog failures gone.
3 left, NOT touched (assertion change is outside the ruling): the statement budget "at most 4" now sees 5 because defaultPrices adds one statement per page:
- catalog/__tests__/integration/orderables.search.test.ts:214 (<= 4)
- catalog/__tests__/perf/orderables.search.perf.test.ts:51 (both 1x and 10x; counts 5,4)
Needs arbiter: raise the budget to 5 (price lookup = one tenant-scoped statement per page, constant, no per-row lookups), or have writer fold the price into an existing statement.
Other 26 failing files = LIMS_TEST_APP_URL / auth env, unrelated.
