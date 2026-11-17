# AN-T18 impl
- Files: app/(staff)/analytics/{page,loading,error}.tsx; features/analytics/components/{DashboardView,DashboardActions}.tsx; features/analytics/server/dashboard.server.ts (new); server/actions.ts (+refreshAction).
- [CONV] page = async server component, whitelist-only searchParams → API; API 4xx/5xx → error.tsx (digest only). Refresh via server action; 429 = "Refresh available at {time}".
- Review fixes: #1 per-tile FreshnessBadge keyed by tile family (orders/income/results/collections; snapshot tiles → `report_backlog` [CONV], header badge kept); #2 AutoRefresh child: router.refresh() every 5 min only when visible; #3 Alt+R registered on `staff.analytics.dashboard`, shares the button's in-flight/cooldown guard.
- Round 2 #1: cooldown ends — setTimeout to next_allowed_at (fallback now+5 min) clears guard + status text; held in ref, cleared on unmount/re-arm. Same end time drives "available at" text.
- Dropped `iconStart="refresh"` (not in kit icon set; tsc error).
- Tests: AN-T18-verify → 58 tests; page 45/45 pass; states 5/5 on rerun (error.tsx test cold-import timeout 15 s on first run, file untouched). tsc: no errors in analytics impl files; tester files an-t17/an-t18 have TS2353 on `onUnhandledRequest` (test-owned).
- Open: no full-suite/lint run; `report_backlog` family name for snapshot tiles unconfirmed in spec.
