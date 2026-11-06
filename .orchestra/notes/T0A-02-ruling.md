TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
Reasons:
- The test `fail closed: missing args, missing files/body input, unknown flags` (tests/lint/check-paths.test.mjs:145-153) never runs the CLI. The `run()` helper at tests/lint/check-paths.test.mjs:30,34 calls `files.join('\n')` with no check, and `run({ raw: ... })` passes no `files`, so the helper throws a TypeError before `spawnSync`. The failure comes from the test itself, not from the code under test.
- Spec basis: the gate must reject foreign paths and contract changes without `Refs: CR-` (spec/chunks/C0-foundation-contracts/06-IMPLEMENTATION-PLAN.md:46; 01-PRD.md:91-93). Failing closed on bad input is a reasonable test-side requirement (test header line 11). The spec does not require the helper to crash, and nothing in the spec is contradictory, so no CR is needed.
Change to make (tester):
1. In `run`, change the signature to `function run({ branch, files = [], body = '', raw })`. Or, when `raw` is set, skip writing the temp files.
2. Keep every assertion at lines 146-152 as it is (each one checks exit code != 0). Do not weaken them.
3. The test header (line 13) also says "unknown flags", but no assertion covers that. Add `assert.notEqual(run({ raw: ['--branch','c05/x','--bogus'] }).code, 0);`.
The implementation needs no change for this test. The writer's claim that it exits 2 for each case is not yet proven; re-run the suite after the test fix to confirm.
