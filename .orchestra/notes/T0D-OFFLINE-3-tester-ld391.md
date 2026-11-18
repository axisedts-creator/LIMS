LD-391 tester item applied exactly as ruled (rs-c4.signature.ts, rs-c4.static.test.ts only; baseline json untouched):
- routes_added (8 paths) + 7 permission codes added to LD310_ALLOW; route tree assertion split into filtered-equals-baseline + no-removal; length-8 check added.
- Result: route tree test now PASSES. rs-c4.static.test.ts still 4 failed / 7 passed. The ruling under-counted the drift; the same accounting UI also adds, beyond the 7 codes:
  1. logic files not in baseline.logic: billing/server/accounts.actions.ts, accounts.server.ts, expenses.actions.ts, expenses.server.ts (logicFiles() key-set check).
  2. billing_feature: ~152 added permission codes (billing.account_entry.*, billing.accounts.col.*, ...).
  3. billing_app / billing_feature server_imports: @/features/billing/server/accounts.server, expenses.server.
  4. frontdesk_feature: added route literal /v1/catalog/tests (the "no route added" check).
- Ruling said "no others", so allow-list NOT widened. Needs a new lead ruling (or CR) that names these additions before the rs-c4 guard can go green.
