# FD-T11 dispute (writer): 2 test defects, impl left as is
Run: `tests/frontdesk/FD-T11.pg.sh` = 46/50; booking file alone 26/26; contract file alone 17/20.

1. **User-actor getOrderSummary on a registered order (3 tests fail: contract.test.ts "(2)", "returns the OrderSummary of 03-IC §4.3", "(19)").**
   `run` (contract/helpers.ts) passes the scenario's real `LabPort` fake, whose `getOrderItemProcessingState` authorises a user only via `fixtures.grants[ctx.actor.id]`
   (packages/fakes/src/LabPort.fake.ts:63,195). `scenario()` (orders/helpers.ts) seeds no grants, so any `actor: 'user'` call that needs the derived status gets `auth.forbidden` from the FAKE.
   The impl correctly forwards the caller's own ctx to LabPort (TRD §6.1: "C4 is a listed caller holding `frontdesk.order.read`, or system"); it must not swap in a system actor.
   Fix in tests: in `run`, when `actor === 'user'`, `lab.__seed({ grants: { [actorId]: ['frontdesk.order.read'] } })` (or build the lab with those grants in `scenario`).
2. **Tenant-wide row counts race between the two files ("(9)" and "(10)" in booking.contract.test.ts, flaky).**
   `writes(TENANT_A)` counts every tenant-A patient/consent row; `FrontdeskPort.contract.test.ts` seeds patients (`fullPatient`) concurrently (vitest runs files in parallel, same DB), so `before` != `after`
   with +1 patients/+1 consents (exactly one `fullPatient`). Same class as FD-T04-ruling. Both pass when the file runs alone. Fix: scope the "nothing written" counts to the test's own rows
   (orders/items/links/flags for `pt.id`, patient by the test's phone) or run the contract dir with `fileParallelism: false`.
