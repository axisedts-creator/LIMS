APPROVE
Re-review of `git diff e95d25a2..HEAD` (FD-T13) after fixes 828b14ca..3af0de7f. Ran FD-T13 suite: 3 files, 70/70 pass.
Prior items resolved:
1. DiscountDialog reason is now a kit `Select` over F25 `GET /v1/frontdesk/coded-sets/discount_reasons` (read.server.ts `listDiscountReasons`), sorted by `sort_order`, sends the chosen `code`. A new test covers the order and the submitted `reason_code`.
2. `requestLabelPrints` (C5 #14a, x-idempotency: none) sends no `Idempotency-Key`. The test asserts no key on every poll.
3. `.orchestra/cr/FD-T13-routes.md` and `.orchestra/cr/FD-T13-combobox-first-option.md` are filed per the 04-CHANGE-REQUESTS template.
Note (not FD-T13): `tsc` reports TS2353 `onUnhandledRequest` in fd-t13.harness.tsx:133. The same error appears in many other feature test files (analytics etc.), so it is a repo-wide MSW typing issue that needs its own fix.
