APPROVE
Range 6d34264f0..HEAD: tester helper fix (uilist2.helpers.tsx bodyRows excludes the colSpan / .lims-state empty-state row) exactly as the 10:39 ruling orders; sticky assertion at helpers:63 untouched and still exercised by the one-row entries test. Notes updated; dispute file renamed.
`.lims-state` is used only by the kit EmptyState/NotAvailable/ErrorState roots (packages/ui), so no data row is wrongly dropped. No assertion loosened beyond the ruling.
No source, route, permission, contract, error-code, RLS, log or secret change in range; no edits under spec/, packages/ui, features/admin, features/platform, app/(auth), app/(platform).
Reviewer ran: build:nav, vitest uilist2 63/63, web-style-3 101/101; HEAD..main = 0 (main merged).
Pre-existing reds left per LD-362 (r04.source, m2.source motion; untouched shell/kit). Open follow-up: T0B-ACCTLIST-1 handler (summary stays NotAvailable).
