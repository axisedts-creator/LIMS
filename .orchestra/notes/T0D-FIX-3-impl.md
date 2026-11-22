# T0D-FIX-3 impl (writer)
Files: engagement/server/{queue.server,content.server,content-actions}.ts, billing/server/{accounts,discounts}.server.ts, micro/server/listCentres.server.ts, quality/tat/tat.server.ts, inventory/server/read.server.ts (6a/6b/6c: no limit / is_active; counters filtered active in BFF).
7a: app/(staff)/billing/dues/page.tsx fetches billing listCentres (centre_id ?? id) and passes to DuesList. 7b: reporting/server/read.server.ts maps centre_id (contract) ?? id; ReportsWorklist Centre cell = name, fallback code, else dash.
Chart: packages/ui/src/components/kit.css `.lims-chart-svg .lims-series-0, .lims-chart-legend .lims-series-0 { color: var(--lims-accent) }` [CONV] no chart palette token exists; accent = first colour. Comment placed after the rule (the test's CSS parse reads the text before `{` as selector).
Crash: SalesTable rows undefined -> []; Broadcasts rows/templates undefined -> [], audience_filter?.party_kinds ?? [].
Tests: fix3 21/21 pass. tsc: no errors in touched files (pre-existing errors in brand.ts and msw test typings).
Open: contract-vs-web query check covers only listCentres/listCounters/listInventoryCodedSet (tester gap); catalog departments `limit=200` in tat.server untouched (not in scope, unchecked).
