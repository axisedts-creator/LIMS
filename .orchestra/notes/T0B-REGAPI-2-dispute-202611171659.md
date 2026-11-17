# T0B-REGAPI-2 dispute (writer pass 3, 2026-11-17) — TEST FIXTURE DEFECT, 1 test

registration.test.ts:258-271 "CONCURRENCY: usage_limit 2, six simultaneous saves".
- Fixture: `mkCoupon({ usage_limit: 2 })` defaults to `percent: 10` (line 30) and `prepare({ d: { coupon_code: c } })` defaults to `payments: [pay(NET)]` (registration/helpers.ts:122).
- Since LD-327 (a) the coupon is a pre tax bill discount, so the invoice is NET minus the coupon; a payment of NET is above the amount due and billing correctly refuses all 6 saves with `billing.payment_exceeds_due` (observed: 6 x billing.payment_exceeds_due, 0 x 201). The test was written for the pre LD-327 interim (totals unchanged).
- Product behaviour is right: overpayment must never be accepted (the same tests at lines 216-232 pin the reduced invoice).
- Fix (tester): pass a payment that fits the reduced bill, e.g. `prepare({ d: { coupon_code: c }, payments: [pay(1000)] })` (or `payments: []`). No assertion changes needed; the usage-limit race assertions stay as written.

# billing/__tests__/preview/previewInvoiceNo.test.ts — 6 of 9 fail on two TEST defects (product matches the spec)
1. PATTERN = '{fy}-{seq:6}' but the test expects the LONG year (FY = fiscalYearOf(..).long, SHAPE /^\d{4}\//). 03-IC §9.3 line 2884: `{fy}` = B.S. fiscal year SHORT form `082/83`, `{fyl}` = long `2082/83`; the invoice_no example (line 2891) is `082/83-000123`. The real previewInvoiceNo renders exactly like issue() (invoice.service.ts:231 vs :573), so it returns `083/84-000001`, which IS the number issue() assigns. Fix: PATTERN = '{fyl}-{seq:6}' (then real == `${FY}-…` and == the fake, which renders the long code) — affects tests at lines 38, 59, 82, 109, 118.
2. Line 101-106: `preview(TENANT_A, NOW, undefined)` — `undefined` triggers the default parameter `pattern = PATTERN` (line 21), so the "missing pattern" case is never missing and gets a valid number. Fix: pass `null` for the missing case or make the helper distinguish (e.g. `arguments.length` / an options object). The two malformed patterns are already refused.
- Writer fixed (not tests): the real port and the fake now accept a ctx whose now() returns a Date (the test's ctx and the frontdesk app ctx do); before, both threw (`instant must be ISO-8601 UTC` / `billing.fiscal_year_closed`).
- Also: unit/boot.test.ts "every frontdesk operation is mounted" timed out at 60 s in run 3 (host load; it passed in run 2 of this pass, LD-328 (5): run alone, never raise the timeout).
