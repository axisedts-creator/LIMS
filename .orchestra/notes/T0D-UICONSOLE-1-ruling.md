TESTS_WRONG — uiconsole1.payments.test.tsx:103 asserts international grouping; the spec requires lakh grouping for displayed money.
Change in the test: line 103 `expect(text).toMatch(/123,456\.00/)` -> `expect(text).toMatch(/1,23,456\.00/)` (12345600 paisa in lakh grouping). Leave :177 `/2,250\.00/` as is (same in both groupings).
Reasons:
- spec/chunks/C0-foundation-contracts/02-TRD.md:162 — "Default display grouping `lakh` [CONV] ... e.g. `Rs. 12,34,567.89`; `international` available. Display only."
- spec/chunks/C0-foundation-contracts/04-UI-UX.md:205 — MoneyTextProps grouping 'lakh' | 'international' (lakh is the default per TRD:162).
- spec/chunks/C15-payment-gateways/04-UI-UX.md:21 — payments screens use lakh grouping.
- Brief: display only, "no new data"; switching this one screen to international would contradict the above and the pinned lakh tests (pg-t18.review, pg-t18.detail, pg-t19.refunds, rs-c15.behaviour).
Debugger item (56 old tests in inventory/t24.unresolved, payments/pg-t18.review, payments/pg-t19.refunds pinning role="grid" and old column order): also TESTS_WRONG.
- No spec line requires role="grid" for payment review, refunds or unresolved stock; the only `role="grid"` in spec/chunks is C5-lab-workflow/04-UI-UX.md:249 (lab result entry grid), not these screens.
- Brief done_when (template 2 CONSOLE, LD-353) mandates SplitConsole with priority/age first and says "update every test that pinned the old markup, never delete, skip or loosen an assertion". Tester updates those 3 files: locate rows by table/row/columnheader roles and the new header order; keep every assertion's intent.
