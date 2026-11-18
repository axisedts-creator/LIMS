# T0B-SYNC-3 dispute (writer) — 2 tests, one cause in the double
Tests: lab.live.test.ts "two devices collect the same specimen…" (line 72) and "two devices receive the same specimen…" (line 141). Both fail: first op `rejected` (common.internal), expected `accepted`.
Cause: doubles.ts:101-102 `specimenMock` forwards `a[1]` as the params argument. The pinned service signature (doubles.ts:10, specimen.service.ts:273-274) is `collectSpecimen(ctx, params, headers, body)`, so `a` = [params, headers, body] and `a[1]` is the HEADERS (`{ 'if-match': '"2"' }`).
The default behaviours never read the second argument in a way that matters, but `moves()` (lab.live.test.ts:25) does `specimens.get(params.specimen_id)!` -> undefined -> TypeError -> the engine answers common.internal.
The adapter passes `{ specimen_id }` as params (asserted green by the test at line 38: `args[0]` toMatchObject `{ specimen_id: id }`).
Fix asked (test side only, nothing loosened): doubles.ts lines 101-102 `behave.collect(ctx, a[0])` / `behave.receive(ctx, a[0])`.
Run: tests/core/T0B-SYNC-3.pg.sh -> 95 pass, 2 fail (these two).
