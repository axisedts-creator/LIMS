BL-T22 debug: 47 fails = 46 handler stubs of unbuilt tasks (FD-T05..T15, BL-T13..T19 -> common.service_unavailable) + 1 recordPayment probe (404 vs spec 409 order_not_invoiced).
Cause of the 1: C4 cannot tell an uninvoiced own order from an unknown/other-tenant one (no frontdesk table reads); spec conflict, see BL-T22-dispute.md.
Fix: none in impl; tried 404 for null totals, broke ledger.payment.test.ts:120 + BillingCommandPort.contract.test.ts:120, reverted (ledger.service.ts unchanged).

Round 2 (after ruling): recordPayment fix already in HEAD (bc4c8ba3); crossTenant recordPayment probe passes. No impl change needed.
Remaining 46 fails = 45 handler stubs of unbuilt tasks (FD-T05..T15, BL-T13..T19 -> common.service_unavailable; probes pass once those land) + 1 alerts.rules test needing `.orchestra/cr/BL-T22.md`.
CR exists as `.orchestra/cr/BL-T22.nonblocking.md` (orchestra rename 8d2437c0). Not impl code and outside debugger-writable paths; orchestra must restore the name or accept the test as pending. Not recreated.
Round 3: re-checked verify log. Same 46 fails, no impl cause. 45 = handlers for unbuilt tasks (FD-T05..T15, BL-T13..T19) still stubbed with common.service_unavailable; faking them would be inventing behaviour. 1 = alerts.rules wants `.orchestra/cr/BL-T22.md`, only `BL-T22.nonblocking.md` exists. No code change. Orchestra: restore the CR name, or rerun probes after those tasks land.
Open: ruling's assertRole(centreId) not in service (t08 ctx lacks IdentityPort.assertRole); core pipeline gates permission.
Round 4: re-checked. Still 46 fails, no impl cause. handlers/index.ts still stubs unbuilt-task ops (service_unavailable); only .orchestra/cr/BL-T22.nonblocking.md exists (test wants BL-T22.md). No code change; orchestra: restore CR name or rerun probes after FD-T05..T15 / BL-T13..T19 land.
