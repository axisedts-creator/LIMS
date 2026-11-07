TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
- Disputed: `services/api/src/core/db/__tests__/retry.test.ts:150` wraps a request that injects no failure in `rejection(...)`. That handler only calls `ctl.noRetry()` and commits, so it must resolve.
- Spec: noRetry only changes what happens when the tx fails with `40001`/`40P01` (spec/chunks/C0-foundation-contracts/02-TRD.md:603; 01-PRD.md:200 AC-0D-2.7; 02-TRD.md:520). No spec line says a noRetry request with no failure must reject. The test file's own line 157 ("noRetry on a request that succeeds changes nothing") also expects it to resolve.
- Fix line 150 so the first request really fails while noRetry is set. Lines 151–154 stay as they are:
  `fake.inject(/UPDATE gw/, () => pgError('40001'), 1);`
  `await rejection(db.requestTx(txInput(), async (tx: any, ctl: any) => { ctl.noRetry(); await tx.query('UPDATE gw SET x = 1'); }));`
- The regex must be `/UPDATE gw/` and not `/UPDATE hot/`, so this inject cannot use up the one on line 151.
- The test still checks the point of AC-0D-2.7 (02-TRD.md:520 "for this request"): the noRetry flag does not carry over to the next request.
