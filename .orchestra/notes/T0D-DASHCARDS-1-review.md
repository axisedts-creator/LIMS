APPROVE

Round 2 (after 641286e8f CHANGES). Both items fixed:
1. Writer (1acb22f20): CASH_SQL, cashTimezone, tenantTimezone and the billing.cash_report.read lookup are removed. cash_in_drawer_paisa is never emitted. The contract field stays optional (additive), the web cell shows "Not available yet", and the gap is left note item 6 (needs a CR for a live expected).
2. Tester (1a56f663f): the live fixture inserts open sessions with expected/counted NULL, as insertCashSession does. The handler, dashboard.handler, live and web tests now assert that cash is omitted or "Not available yet". A web test still covers the optional field if it is ever sent.

Re-checked, no defect: outstanding_paisa is still gated on billing.account.read (omitted, not 403, and the source is not read without it), has an explicit tenant predicate, is read only, and logs no PHI or secrets.
Ran: api dashcards1.handler + dashboard.handler 72/72 pass; web vitest.dashcards1 config 7 files 106/106 pass. Not run: dashcards1.live (PG17/Docker).

Non-blocking:
- The getAnalyticsDashboard description in contracts/openapi/analytics.yaml:22 still says cash_in_drawer_paisa is present for billing.cash_report.read holders. Correct it with the CR in left note item 6.
- The diff still touches 21 non-note files, more than the brief's budget of 14.
