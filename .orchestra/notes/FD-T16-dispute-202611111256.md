# FD-T16 dispute (round 3) — 223/225 pass; 2 remaining = probe-harness fixture gap
Run: tests/frontdesk/FD-T16.pg.sh (2026-11-11). Failing: crossCentre.live.test.ts:51 "F10 listOrders" and crossTenant.live.test.ts:62 "F10 listOrders (window = ...)". Both: `common.not_found` from LabPort fake.
Cause: F10 derives status per registered/in_progress row via LabPort.getOrderItemProcessingState (order.service.ts:53-60, 172-173; 03-APP-FLOW derived status, already accepted in FD-T10 read.test/derived.test).
The window in both tests also contains orders seeded by kit.ts `objs()` (kit.ts:148,151: status registered, registered_at on the same day — A1/A2 at DAY in crossCentre, `A` at A.at in crossTenant), but the `lab` passed to fire() only holds the scenario orders (`mergeInto(shared, s1/s2)` / `s.lab`). The fake then throws not_found for the objs() order (packages/fakes/src/LabPort.fake.ts:196 `order(ctx, input.orderId)`).
A real LabPort knows every registered order, so this is a fixture gap, same class as ruling (2) (cancelOrder control: seed A1's order into the lab fake).
Not a spec requirement the handler misses: swallowing a lab not_found in F10 would hide real cross-module inconsistency and is not specified.
Fix (tests): seed every registered objs() order in the window into the lab fake passed to F10 (e.g. objs() registers its order in a shared lab / mergeInto), or give the scenario orders a window no objs() order shares (as orders/read.test.ts:8 does with its own year).
No impl change made this round. LD-70: pending.json not involved.
