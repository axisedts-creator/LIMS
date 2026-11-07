TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
1. The spec requires all of AC-05.1 to happen "in one transaction" (spec/chunks/C5-lab-workflow/01-PRD.md:132). So the intent of the test — events roll back with the caller's transaction — is right.
2. But the test as built does not check that. `sequence(s)` already wraps its work in `s.run` = `db.transaction` (publish.test.ts:58, :262). Test :285 then wraps it again in `s.db.transaction(..., {rollback:true})`, which makes a NESTED transaction.
3. The C0 fake does not support nesting (core/events/__tests__/helpers.ts:72-83). The inner call sets `committed = work`. The outer rollback then restores `work = committed`, which already holds the 4 events. So the failure (4 stored) comes from the fake, not from publish.ts. The spec says nothing about nested transactions, so the test asserts behaviour the spec does not require.
4. Fix in the test only: make `sequence` return the body, not the run, e.g. `const body = (s) => async () => { ...4 publishes... }`. Test :268 then calls `await s.run(body(s))`, and test :285 calls `await rejection(s.db.transaction(body(s), { rollback: true }))`. Keep `expect(s.db.events).toHaveLength(0)` as it is.
5. No change to services/api/src/modules/lab/events/publish.ts.
