TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
- Spec spec/chunks/C4-frontdesk-billing/01-PRD.md:256 (US-BL-05.1): "no invoice column except `credited_total_paisa`/`version`/`updated_*` changes". That is an upper bound (allow-list). It does not require `updated_by` to change.
- `issue()` already writes `updated_by: actorId` (services/api/src/modules/billing/service/invoice.service.ts:216). The test runs credit() as the same `USER` (default `w.ctx()`), so the value cannot differ. The `changed` diff can never contain `updated_by`. No compliant implementation can pass.
- The invariant the spec does require is already checked at line 64 (`INVOICE_MUTABLE.has(k)` for every changed column) and at line 61 (`updated_by: USER`, version +1, credited_total_paisa 50000).
Change in services/api/src/modules/billing/service/__tests__/invoice.credit.test.ts:63:
  `expect(changed.sort()).toEqual(['credited_total_paisa', 'updated_by', 'version'].sort());`
  becomes `expect(changed.sort()).toEqual(['credited_total_paisa', 'version'].sort());`
  If updated_at is ever made to change under the fake clock, the allow-list loop at line 64 still covers it. Leave lines 61 and 64 as they are.
  Optional: to prove updated_by is written, run the credit with a different actor ctx and assert `updated_by` = that actor.
