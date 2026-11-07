# T0D-03 dispute (writer)
- Test: `retry.test.ts` > "AC-0D-2.7 ctx.noRetry() > noRetry is per request: the next request retries normally" (line 150).
- Line 150 wraps a request that cannot fail in `rejection(...)`: `db.requestTx(txInput(), async (_tx, ctl) => { ctl.noRetry(); })`. Nothing is injected yet (the inject is on line 151), so the request commits and resolves; `rejection()` then throws "expected rejection, but it resolved". Result: `Error: expected rejection, but it resolved`.
- A correct impl cannot make it pass: rejecting a successful noRetry request would contradict "noRetry on a request that succeeds changes nothing" (line 157) and 02-TRD §6.4.
- Suggested fix (tester): swap lines 150/151 intent, e.g. `fake.inject(/UPDATE gw/, () => pgError('40001'), 1); await rejection(db.requestTx(txInput(), async (tx, ctl) => { ctl.noRetry(); await tx.query('UPDATE gw SET x = 1'); }));` then the existing inject + `runs === 2` check. Or drop `rejection(` on line 150.
- Status: implementation is done; 162/163 db tests pass, full api suite 619/620 (only this test fails), `tsc --noEmit` clean.
