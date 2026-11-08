# BL-T22 dispute (debugger)
Probe `billing:recordPayment` (crossTenant.handlers.test.ts:48) wants `404 common.not_found` for another tenant's order id.
Spec 03-APP-FLOW.md:125 + 02-TRD.md:265 (B8): cash order without invoice => `409 billing.order_not_invoiced`.
Both cannot hold in C4 billing: `readOrderTotals` (balances.repo.ts:41-44) returns undefined for both "own order, no invoice yet" and "unknown/other-tenant order"; C4 billing must not read frontdesk tables (balances.repo.ts:25), so it cannot tell them apart. Making it 404 breaks spec'd tests ledger.payment.test.ts:120 and BillingCommandPort.contract.test.ts:120.
Needs a lead decision: (a) probe accepts `billing.order_not_invoiced` for recordPayment (existence not leaked beyond tenant: same code for unknown id), or (b) frontdesk passes order-exists via the port. Not a debugger-sized fix.
The other 46 failures are frontdesk/billing handler stubs (FD-T05..T15, BL-T13..T19, `common.service_unavailable`), not defects in BL-T22 code.
