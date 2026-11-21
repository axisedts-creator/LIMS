TESTS_WRONG — review item 2 (DashboardView.tsx:182, chart "Billed per day" plots net_sales_paisa) cannot be fixed without breaking the test pins.
Pins: uidash2.today.test.tsx:223-245 require the frame titled "Billed per day" WITH one .lims-chart-bar per day and a data-current bar; uidash1.dashboard.test.tsx:104-143 and rs-c8.dashboard.test.tsx:198 pin the same title (an-t18 per tester note).
Why wrong: the only per-day money in the contract is series.days[].net_sales_paisa (dashboard.server.ts:14); there is no invoiced per day. The "Billed" Money cell is invoiced_paisa (DashboardView.tsx:103). So the pins force net sales (net of credit notes) to be shown under the name "Billed" on the same screen as a different Billed figure — a money mislabel (reviewer item 2). Display only: the contract may not be changed to add invoiced per day (LD-438 (d)).
Proposed change (tester): retitle to "Net sales per day" in those pins, keep bars, caption, data-current accent and empty "No data yet" as is. Matches the series label already drawn ("Net sales") and the existing report title "Net sales per day" (report-views.ts:107). Deviation from the mock title recorded in impl notes as a data gap.
Alternative if the mock title must stay: "Billed per day" draws NotAvailable (like "Tests by department"); then the bar/current-day pins at :223-245 must drop. Writer recommends the retitle.
Writer will change only DashboardView.tsx title string once the pins are revised. Stopped.

---
TESTS_WRONG (debugger, verify step rs-c8) — 5 snapshot mismatches in apps/web/src/features/analytics/__tests__/rs-c8.screens.test.tsx (snap file rs-c8.screens.test.tsx.snap), cannot be fixed in implementation.
1. Card title wrapper: packages/ui/src/components/Card/Card.tsx:16 renders `<div class="lims-card-head">` around the title (T0D-UIKIT-2, committed f8ed99b52, pinned by uikit2.kit.test.tsx). Snapshot has 0 `lims-card-head`; undoing it would break the kit test and LD-436 card spec.
2. React useId ids (`_r_80_` -> `_r_8g_` etc.) are not normalised: `norm()` at rs-c8.screens.test.tsx:17-22 only handles `react-aria…` and `:rN:`, not React 19 `_r_xx_`. Ids shift whenever earlier tests in the file render more useId parts (kit PeriodPicker/ChartCard now on Today). Stable only by luck.
Proposed (tester): add `.replace(/_r_[0-9a-z]+_/g, ':rN:')` to norm() and re-pin the 5 snapshots with `vitest -u` (lims-card-head diff only). No implementation change.
Note: git shows the .snap as "M" but diff is line-ending only.
