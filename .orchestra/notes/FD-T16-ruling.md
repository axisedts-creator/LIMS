TESTS_WRONG — round 3: the 2 remaining F10 listOrders failures are a probe-fixture gap; the implementation follows the spec.
1. Spec requires F10 to derive status per stored `registered` order via LabPort.getOrderItemProcessingState: 02-TRD.md:251, 02-TRD.md:333, 03-APP-FLOW.md:13-14, 06-IMPLEMENTATION-PLAN.md:18 (FD-T08).
2. LabPort errors are `common.*` propagated, not swallowed (02-TRD.md:482; C5 02-TRD.md:352 lists `common.not_found` for an unknown order). So a lab fake that does not know a registered order in the window correctly fails F10.
3. Both windows also hold objs() orders (kit.ts:148,151; seeded `registered`) that the lab passed to fire() does not know: crossCentre.live.test.ts:18 (A1/A2 at DAY) vs :54-56/:61; crossTenant.live.test.ts:24 (A at A.at) vs :63-64. Same fixture class as ruling (2) of round 1.
Fix in the tests (either is acceptable):
 a. Seed every registered order in the window into the lab (and billing) fake handed to fire(): in crossCentre F10 seed A1.order and A2.order into `shared.lab`/`shared.billing` (as :32-33 do for A1); in crossTenant F10 seed A.order into `s.lab`/`s.billing`. Or have objs() register its order into a shared lab fake the kit uses by default.
 b. Or move the scenario orders to a day no objs() order uses (as orders/read.test.ts does with its own year), keeping the A2/B exclusion asserts meaningful (crossCentre :60 must then still check an A2 order inside that window, e.g. s2).
Do not change the handler. LD-70 noted: pending.json not involved.
