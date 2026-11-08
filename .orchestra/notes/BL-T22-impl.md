BL-T22 impl (writer). Owned paths only.
Files: worker billing/alerts/integrity.rules.yaml (new, 5 rules), worker frontdesk/alerts/frontdesk.rules.yaml (new, 2 rules), .orchestra/cr/BL-T22.md (the one CR to C1, 9 alerts). cbms.rules.yaml unchanged.
[CONV] DB rules (exports, patient-search, refunds) use placeholder `db_rule_*` exprs + `annotations.query` SQL description; C1 SQL-alert runner evaluates them. Routes: on-call, security, finance + security, on-call + tenant-admin.
Tests: alerts.rules.test.ts 14/14 pass. Other probe files NOT green (56 fail): frontdesk handlers are stubs (service_unavailable, FD-T05..T15 not built) and billing B-ops credit notes/registers/payment intents/exports/audit trail (BL-T13..T19) are stubs. None in my owned paths; they pass only when those tasks land.
Open: recordPayment probe returns order_not_invoiced where spec says 404 — BL-T08 service bug, not a test dispute. No dispute filed.
