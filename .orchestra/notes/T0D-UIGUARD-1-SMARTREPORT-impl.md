# T0D-UIGUARD-1-SMARTREPORT impl (writer)
- Files: smartreport/components WordingTerms, CheckTab, GroupsTab (rule 5: DataTable always drawn, empty text moved into its emptyState); SummaryReview (rule 6: each TimeSeriesChart in ChartCard; rule 7: sections -> Card title rows, ul -> DescriptionList/TextList); ReviewPanel, PreviewDialog, TextsTab (rule 7; Texts now one Card + DataTable per kind); common.tsx (+TextList helper); notes/T0D-UIGUARD-1-exceptions.md (10 SMARTREPORT lines deleted).
- [CONV] regions the tests name (Changes since active version, History, Results used) kept as section aria-label around the Card, since kit Card is not a region.
- [CONV] CheckTab: no table until checks run (no data yet); after a run the table stays with header, empty text "No issues found. You can submit this version for approval."
- No kit prop added; no registry, route, permission, API or token change. No rs-cN snapshot covers smartreport.
- Checks: verify.cmd (uiguard1) 36/36; sr-t19 66/66, sr-t20 102/102, sr-t21 97/97, sr-t23 28/28, sr-t29 16/16, uilist1.smartreport 7/7.
- OPEN: sr-t18.queue "Error: a failing API makes the page reject" fails (thrown undefined); SummaryQueue/summaries-page untouched by this task, so pre-existing (page now shows NotAvailable instead of throwing?) — for tester/debugger.
- tsc errors exist only outside smartreport (brand.ts png modules, msw test typings), pre-existing.
