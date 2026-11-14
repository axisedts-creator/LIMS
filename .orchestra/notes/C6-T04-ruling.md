TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
- spec/chunks/C6-reporting-delivery/02-TRD.md:788 — on `frontdesk.order.cancelled.v1`, unreleased versions -> `discarded` (reason `order_cancelled`); "released versions untouched". The consumer must not write the released row.
- Test intent (released row keeps status `released`, no discard reason) is correct; the defect is fixture-only. consumers.test.ts:316 assigns `db.store['reporting.report_versions']` directly, bypassing the DDL DEFAULTS applied in consumers.helpers.ts:162 (`discard_reason: null`, `discarded_at: null` at :52). So the untouched released row has `discard_reason === undefined`, and `toMatchObject({ discard_reason: null })` at :323 can only pass if the implementation writes a released version — which TRD:788 forbids.
- Fix (test side, choose one): in the `version()` helper (consumers.test.ts:311) add `discarded_at: null, discard_reason: null` before `...extra`; OR seed versions via `seededShell({ 'reporting.report_versions': [...] })` so DEFAULTS apply. Keep the assertion at :323 unchanged.
- Implementation stands as-is for this case (UPDATE restricted to unreleased statuses).
