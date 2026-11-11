# PG-T08 dispute (writer) — 9 tests in `integration/intent.service.test.ts` cannot pass as written; impl is not bent to fit

## A. Tenant mismatch in the DB accessors (8 tests) — test-helper bug
`helpers/merchantDb.ts` defaults `transitions()/gatewayCalls()/intents()/accounts()` to `TENANT_A = 01930000-…-0a`, but the port harness/ctx tenant is `TENANTS.A = 01900000-…-0a` (packages/fakes/src/base.ts). Tests call `h.db.transitions()` / `h.db.gatewayCalls()` with no argument, so they always read an empty list.
Proof: a throwaway test (deleted) reading `h.db.transitions(TENANTS.A)` / `gatewayCalls(TENANTS.A)` after create(khalti) + verify(Completed) got transitions `null>created:create:system | created>initiated:create:system | initiated>settled:verify_call:system` and calls `khalti_initiate:answer | khalti_lookup:answer` (`intent_id` = the intent).
Affected: AC-PG-01.1 transition rows; AC-PG-01.2 replay; AC-PG-05.2; verify "settles on COMPLETE"; "PENDING moves initiated -> pending"; ST-06; "every gateway answer is logged"; AC-PG-13.1 cancel.
Fix (tester): make `makePortHarness` build the db with default tenant `TENANTS.A` (e.g. wrap `transitions/gatewayCalls/intents/accounts` with `(t = TENANTS.A)`), or pass TENANTS.A in the tests.
(`rows()`/`row()` in the test already pass `A` explicitly, which is why intents work.)

## B. Contradictory assertion (1 test)
"calls within VERIFY_MIN_INTERVAL …" (line ~442): `create()` (eSewa, gateway status `PENDING`) then `verify(at(60))` is asserted `'initiated'`. The next test ("PENDING moves initiated -> pending", line ~459) runs the identical setup and asserts `'pending'`. TRD §4.1 I3 / §7.2.4 (eSewa `PENDING` on `initiated` = `to_pending`) and contract case (5) agree with `'pending'`. Impl returns `'pending'`.
Fix (tester): change the first assertion to `'pending'` (the rest of that test, 1 check at +60 / none within the interval / 2nd check after, passes either way).

Re-run after the fix: `.orchestra/notes/PG-T08-verify.cmd` — expected all green (contract 1–18 minus refund cases 8/9/18 = PG-T14).
