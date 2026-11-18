Title: CR-C0-T0C-SYNC-2: IC §7 lacks 3 staff_web routes already in contracts/routes.yaml on main
From chunk: C0            To owner: C0-0C (spec owner: lead)
Type: bug
Blocking? yes: T0C-SYNC-2 verify step 2 (contracts registry-equality.test.ts "routes.yaml == IC §7") fails; same failure exists on main.
Problem: T0D-ACCT-2 (commit 7a4a9d02f, LD-313) added staff.billing.expenses, staff.billing.expense_types, staff.billing.cash_transfers to contracts/routes.yaml (also on main) but not to spec/program/03-INTERFACE-CATALOG.md §7. Test reports "extra id=... (not in IC)". Not caused by SYNC-2; spec/ is read-only for this lane.
Proposed change (exact): add to IC §7 routes, same as routes.yaml:
  - { id: staff.billing.expenses, origin: staff_web, path: /billing/expenses, owner: C4, permission: billing.account.read }
  - { id: staff.billing.expense_types, origin: staff_web, path: /billing/expenses/types, owner: C4, permission: billing.account.read }
  - { id: staff.billing.cash_transfers, origin: staff_web, path: /billing/cash-transfers, owner: C4, permission: billing.account.read }
  (order must match routes.yaml; test compares order.)
Backward compatible? yes.
Tenant/security impact: none (permission already exists).
Alternatives considered: remove routes from routes.yaml (breaks T0D-ACCT-2 web nav).
Tests that will prove it: contracts registry-equality.test.ts.
