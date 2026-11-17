TESTS_WRONG — test 2 ("later card 1,250.00 ...", ledger.payment.test.ts:44-53) expects RC-083/84-000001 for the second payment although its first payment also requests a receipt.

Change (tester): in ledger.payment.test.ts:46 make the first payment `pay(w, svc, ctx, { amount: npr(100000), issueReceiptNo: false })` (the registration-desk payment, where the invoice is the receipt). Keep lines 48 and 52 (`RC-083/84-000001`, `receipt_seq: 1`). Also acceptable: keep line 46 and expect `RC-083/84-000002` / `receipt_seq: 2`. The first option matches the PRD story better.

Reasons:
- The service decides whether to allocate from `issueReceiptNo` and `receipt_no_enabled` only: spec/chunks/C4-frontdesk-billing/02-TRD.md:455 (= spec/program/03-INTERFACE-CATALOG.md:2019); 03-APP-FLOW.md:128; 02-TRD.md:586.
- No spec rule skips a receipt for the first payment of an order when `issueReceiptNo: true`. In D-RECEIPT (01-PRD.md:124), only the registration-time payment has no RC, and the caller signals that with `issueReceiptNo: false` (02-TRD.md:455).
- US-FD-08.2 (01-PRD.md:185) says a later payment prints an `RC-…` receipt; it gives no sequence value. The `000001` in the test only holds if the earlier payment allocated nothing.
- RC numbers are sequential with no gaps (same test file :153-157, :199-206), so 000001 cannot be skipped. The implementation, which gives 000002, is correct for the test as written.
