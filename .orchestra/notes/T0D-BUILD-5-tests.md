# T0D-BUILD-5 tests (tester)
Files (apps/web/src/features/quality/__tests__/): t0dbuild5.badge.test.ts, t0dbuild5.nav.test.tsx, t0dbuild5.views.test.tsx, t0dbuild5.pages.test.tsx, vitest.t0dbuild5.config.ts. Also edited: app/(staff)/quality/autoverify/__tests__/av-t23.overview.test.tsx (old "5xx rejects to error.tsx" now "inline error with reference": contradicts LD-455 rule 3).
Run: .orchestra\notes\T0D-BUILD-5-verify.cmd (jsdom worker start is sometimes flaky on this box: rerun once).
Seams chosen (writer follow): badge on entry `quality.tat_alerts`; AppShell `counts` accepts string|number (blank string = none); staff layout calls getTatAlertBadge once, passes counts; failures logged via console.error/warn.
Totals: contract has no total/count (PageInfo = limit + next_cursor) -> 'at least N' on tiles + chart card text when `next`; writer writes notes/T0D-BUILD-5-left.md (tested: mentions listTatAlerts + total/count). Note also: contract says "404 when none yet" for getAutoverifyRuleSet.
Chart data (3 screens): kit DataTable INSIDE the ChartCard, aria-label = chart title, no raw <table> in the card (BarChart's hidden table must go: writer needs a local chart or table-only card), first header lims-align-start, number headers lims-align-end.
Autoverify: 404 -> kit EmptyState 'No auto-verification rules yet.'; other failures -> kit ErrorState (tone danger) with 'Reference: <problem.request_id>' in the page, h1 kept, no throw.
Existing t24/uidash1 tests unchanged; expect gridNamed(/runs/i)-style lookups to still hit the rows table first.
