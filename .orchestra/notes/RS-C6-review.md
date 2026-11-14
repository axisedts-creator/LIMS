APPROVE
Re-review after the writer's fixes (a4bb4ef5) and the tester's test changes (36544641):
- Item 1 fixed: ReportDetailView.tsx:180-187 no longer has the `<object>`. The `.rpt-preview` region holds only the existing `pdfHref` link, and a comment cites LD-140. Page render adds no download call.
- Item 2 fixed: ReportDetailView.tsx:213-215 shows all six counts as Chips, zero included. A test now covers the all-zero case.
- Test change follows the ruling (RS-C6-ruling.md) and review item 1. No assertion was weakened beyond what those required.
- Unchanged and fine: portal.css and report-preview.css use tokens only. Only owned paths are touched. No server/api-client, route, permission, RLS or log changes. No PHI or secrets.
- RS-C6-verify.cmd (CI=true): 60/60 pass. In `tsc` from apps/web, the only errors are in apps/portal page.tsx (`@/features/portal/*` alias). Those files are not in this diff.
