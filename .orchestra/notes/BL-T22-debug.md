BL-T22 debug: 47 fails = 46 handler stubs of unbuilt tasks (FD-T05..T15, BL-T13..T19 -> common.service_unavailable) + 1 recordPayment probe (404 vs spec 409 order_not_invoiced).
Cause of the 1: C4 cannot tell an uninvoiced own order from an unknown/other-tenant one (no frontdesk table reads); spec conflict, see BL-T22-dispute.md.
Fix: none in impl; tried 404 for null totals, broke ledger.payment.test.ts:120 + BillingCommandPort.contract.test.ts:120, reverted (ledger.service.ts unchanged).
