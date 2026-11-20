# T0D-UIREPORT-2 impl (writer)
Files: analytics/components/{ReportView.tsx, MisReportView.tsx, report-types.ts}, analytics/server/{report-views.ts, report-page.tsx}, rs-c8.screens snapshot (re-recorded, LD-362: tiles, chart cards, useId shifts only), notes {screens, dispute, impl}.
- Template 5 = new Section `report` (tiles + hero + side ChartVM) built per report from existing op fields only; ReportView draws StatTileRow + two ChartCards in `.lims-dash-charts` (existing 2:1 row, no new CSS) [CONV]. Run cards (ReportSections) skip it.
- report/collections/referral pages wrap in core/shell loadOr: 501 = NotAvailable, 5xx = ErrorState with the title; 403/404 still throw; referral 403 gate states unchanged.
- Income <-> department income: one second read of the other op after the main read (group_by dropped), failure = empty chart [CONV].
- Bill of the Day: one `.lims-period`, one FilterBar (wrapper is `lims-period-custom`), tiles "—", two empty chart cards (no read op, CR open).
- Kept: income ">31 groups" note (now on the hero card), interfaces "Agents by state" card (an-t19 pins it).
Open: dispute (collections day line fixture; rs-c8.baseline re-pin by tester). CRs: TAT by department, interfaces per day, MIS read. Pending tests and quality untouched.
