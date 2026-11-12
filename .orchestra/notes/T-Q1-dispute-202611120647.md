# T-Q1 dispute — 1 test cannot pass

Test: `queue.handlers.test.ts` > "unexpected database failures never leak (fail closed)" > "an unknown pg error on INSERT surfaces as a non-validation error without SQL text" (line 406).

Why wrong: the test replaces `db.tx.query` with a wrapper that THROWS on any INSERT *before* delegating to the original `q`. `db.calls` is pushed only inside `q`, so the INSERT is never recorded.
`expect(db.calls.some((c) => verb(c) === 'insert')).toBe(true)` is therefore false for ANY handler, however correct. Handler does reach the INSERT (centre existence SELECT is recorded, then the wrapper throws).

Suggested fix (tester): record the call in the wrapper (`db.calls.push({ text, values: values ?? [] })` before throwing), or assert on a local flag set inside the wrapper.
The other 104 tests pass; the remaining assertions of this test (error defined, not validation/service_unavailable, no `secret_table`) hold: handler maps unknown pg codes to `common.internal`.
