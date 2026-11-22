# T0D-FIX-1 dispute (writer)
Item 5c (default_price_paisa on listTests / searchOrderables) passes its new test (tests.defaultprice.test.ts) but breaks existing catalog suites, because their
in-memory fakes do not model the price tables and throw on ANY price statement ("fake: unsupported SQL: SELECT DISTINCT ON (i.orderable_id) ... price_list_items"):
- catalog/__tests__/integration/orderables.search.test.ts (14), tests.service.test.ts (11), tests.handlers.test.ts (3), perf/orderables.search.perf.test.ts (2)
  fakes: catalog/__tests__/helpers/catalogDb.ts:140 and helpers/testsDb.ts:479 (header: "one table per statement, no joins/subqueries").
Writer cannot edit test helpers. Splitting into 3 single-table statements does not help: price_lists / price_list_versions / price_list_items are not in these fakes at all.
Ask (tester): teach catalogDb.ts + testsDb.ts to answer the price statement (recognise /price_list_items/ and return no rows, or model the 3 tables), then the
existing suites stay green with "no default price -> field absent". SQL: catalog/repo/tests.repo.ts defaultPrices (one statement, tenant_id = $1 on all 3 tables, binds $1..$3).
Not caused by T0D-FIX-1 (seen in the same run, code not touched by this task): reporting release/templates/messaging-admin/verify.revoke/delivery (auth.unauthenticated),
inventory boot stub codes, lab critical/verify/resultEntry, micro web probes, smartreport phase1stub, all *.live tests + catalog import (need LIMS_TEST_APP_URL). Baseline run not done (git stash/patch needed approval).
