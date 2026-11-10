# AN-T18 impl
- Files: app/(staff)/analytics/{page,loading,error}.tsx; features/analytics/components/{DashboardView,DashboardActions}.tsx; features/analytics/server/dashboard.server.ts (new); server/actions.ts (+refreshAction).
- [CONV] page = async server component, whitelist-only searchParams → API; API 4xx/5xx → error.tsx (digest only). Refresh via server action; 429 = "Refresh available at {time}".
- Review fixes: #1 per-tile FreshnessBadge keyed by tile family (orders/income/results/collections; snapshot tiles → `report_backlog` [CONV], header badge kept); #2 AutoRefresh child: router.refresh() every 5 min only when visible; #3 Alt+R registered on `staff.analytics.dashboard`, shares the button's in-flight/cooldown guard.
- Dropped `iconStart="refresh"` (not in kit icon set; tsc error).
- Tests: AN-T18-verify → 3 files, 54/54 pass. tsc: no errors in analytics impl files; tester files an-t17/an-t18 have TS2353 on `onUnhandledRequest` (test-owned).
- Open: no full-suite/lint run; `report_backlog` family name for snapshot tiles unconfirmed in spec.
