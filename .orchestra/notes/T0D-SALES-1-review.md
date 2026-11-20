APPROVE

Re-review of `git diff 1aca1424f..HEAD` (HEAD 12cf6ac1a, the review fixes).
- Item 2 is fixed. `.orchestra/cr/T0D-SALES-1.md` now exists and follows the 04-CHANGE-REQUESTS template. It covers (a) the collector flags read, (b) `version` on RepresentativeClient, (c) a tenant-wide sales client list, and (d) activateServiceArea. The getSalesTree single page of 200 is noted as a web follow-up, because the contract already pages. The citation in salesActions.ts now resolves.
- Item 1 (DevicesView.tsx CollectorDialog: a flag saved as false cannot be turned back on) stays as a known limit. The contract has no read under homecollection.settings.manage. The tester-pinned behaviour in sales1.collector.test.tsx sends only the boxes that changed. CR (a) covers it and is marked as a real user-facing defect. It is non-blocking for this task.
- Re-ran: sales1 102/102, hc-t20 148/148, rs-c2 74/74, nav.manifest 7/7 (node --test). All green.
- Names, permissions, routes, If-Match and x-idempotency are unchanged since the last review and match partners.yaml, homecollection.yaml, routes.yaml and permissions.yaml. No PHI in logs, no secrets, owned paths only, web only (no RLS changes).
