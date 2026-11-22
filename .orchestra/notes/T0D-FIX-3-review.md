APPROVE

Reviewed `git diff 5292ed4b5..HEAD` (729d519b7 impl, a921c9d5e tests) against the T0D-FIX-3 brief, LD-446 and CR DEPLOY-AXIS-012.

Done-when check:
1. 6a: queue.server.ts listCounters sends only centre_id (contract engagement.yaml listCounters); active-only filtered in BFF (`is_active !== false`). OK.
2. 6b: all six /v1/identity/centres call sites drop `limit` (accounts, discounts, micro, content.server, content-actions, tat). micro keeps `is_active=true`, which identity.yaml listCentres declares. 6c: listCodedSet and listReasons send no limit; reason_group kept. OK.
3. fix3.contract-query.test.ts validates the query against contracts/openapi for these call sites, plus a static guard over every web source. It does not cover other web reads; that is the optional "if time allows" part and the impl/tests notes record it. Accepted.
4. 7a: Dues page passes centres (centre_id ?? id) to the existing DuesList `centres` prop. 7b: reporting listCentres maps centre_id (contract key); ReportsWorklist shows the name, then the code, then a dash. Tested with populated fixtures. OK.
5. Chart: kit.css `.lims-series-0` = `--lims-accent`, marked [CONV] (no chart palette token exists). packages/ui kit.css was last edited by C0 tasks (UIKIT-2, UIDASH-2), so it is in C0's paths. OK.
6. SalesTable/Broadcasts: undefined rows/templates/history rows/audience_filter render the empty state; tested with undefined props. OK.
7. No route, permission or contract change. No PHI and no secrets. Names come from the contracts. Only owned paths touched (17 source/test files, within the 18-file cap).

Checks run (reviewer):
- fix3 config: 21/21 pass.
- msgdesk1 134/134, sales1 102/102, t-q4 82/82, rs-c6 60/60, finctrl1 392/392: all pass.
- inventory t20: 171/172. The failure is "API 500 -> page throws to error.tsx" in t20.alerts. FIX-3 did not change the alerts page, listAlerts or that test (their last commits are UILIST-3 and VERIFY-GREEN-7), so this failure was already there before FIX-3. It needs its own follow-up and does not block this task.
- Not run: the other per-feature configs (acct1/2, content1, t-b6, uiguard1-*, micro t19-26, quality, inventory t21-25, partners t16/partyset1), tsc, lint.
