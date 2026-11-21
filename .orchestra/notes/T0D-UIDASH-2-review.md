APPROVE

Scope: git diff 8d417d452..HEAD = rs-c8.screens.test.tsx.snap (writer re-record per LD-440 item 3) + T0D-UIDASH-2-impl.md note line.
- Snapshot diff limited to lims-card-head, normalised ids, and the Today rebuild approved by LD-436/LD-437 (PageHeader caption, PeriodPicker, StatusStepper, ActionList "Needs you", Money card, Billed per day + Tests by department as NotAvailable).
- Amounts: only fixture values (Rs. 2,30,000.00 invoiced, Rs. 1,90,000.00 collected, 83% bar). Contract fields unchanged. "Role without money tiles" snapshot shows no money, so the permission gate still holds.
- Routes: /frontdesk/registrations/new (already in core/nav/generated.ts) and /analytics/reports/pending-tests (already there before). No new route, permission, operation or API.
- Non-dashboard snapshots (Income, Pending tests, Report hub) change only by card-head/ids.
- No PHI, no secrets, edits only on writer-owned paths per LD-440. Dropped behaviours are listed in the notes as LD-437 intentional differences.
- Ran: vitest -c vitest.rs-c8.config.ts rs-c8.screens.test.tsx = 5/5 passed.
