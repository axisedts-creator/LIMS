# T0D-FIX-1 tests (tester)
Run: `.orchestra\notes\T0D-FIX-1-verify.cmd` (pnpm --dir services/api exec vitest run <8 files + core openapi.test.ts>). No DB needed.
Item 1: core/__tests__/query-csv.test.ts + fixtures/csvq/** (comma/repeated/single, per-element enum/maxLength/maxItems/int, empty element 400, explode-true untouched).
Item 2: inventory/__tests__/unit/alerts-status.test.ts (parseAlertList + handler, service mocked).
Item 3: micro/handlers/__tests__/culture.clock.test.ts. Item 4: smartreport/handlers/__tests__/summaries.limit.test.ts.
Item 5: lab/handlers/__tests__/worklist.clock.test.ts, reporting/__tests__/critical-alerts.limit.test.ts, catalog/__tests__/integration/tests.defaultprice.test.ts (scripted tx, tolerant of the SQL shape; asserts tenant predicate, <=3 price statements, default list + published).
Item 6: core/__tests__/ctx-clock-limit.static.test.ts (+ fixtures/ctx-clock-baseline.json). Strict for this task's files; RATCHET elsewhere (see T0D-FIX-1-left.md).
Fail now for the right reason: 5 query-csv, 5 inventory, 4 micro, 3 smartreport, 5 lab, 3 reporting, 6 catalog, 2 static (33 of 84; core openapi.test.ts passes). Rest are regression guards (pass now).
