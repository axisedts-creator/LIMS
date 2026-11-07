# T-04 dispute (writer)
Test: `publish.test.ts:283` "AC-05.1 … rolls back with the caller transaction" — fails (4 stored, expected 0). 56/57 others pass.
Why the test is wrong: `sequence(s)` wraps its publishes in `s.run(...)` = `db.transaction(...)`. The test then calls
`s.db.transaction(() => sequence(s), { rollback: true })`, i.e. a NESTED transaction. The C0 fake (`core/events/__tests__/helpers.ts:72-80`)
has no nesting: the inner call commits (`committed = work`), then the outer rollback restores `work = committed` — already containing
the 4 events. The publisher code is not involved (it only calls `ctx.events.publish` on `ctx.tx`).
Fix (tester): in this test, call the 4 publishers directly inside the rollback transaction, e.g. make `sequence` take a runner:
`const body = (s) => async () => { …4 publishes… }` then `s.run(body(s))` in test 1 and `s.db.transaction(body(s), { rollback: true })` in test 2.
Writer impl `services/api/src/modules/lab/events/publish.ts` is in place; no change needed once the test is fixed.
