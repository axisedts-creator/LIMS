TESTS_WRONG — the assertions are correct, but the test file sits at a path no chunk owns (root `tests/`). The tester must move it.
- Assertions match the brief and spec: session_id+aal present or C2 T1 blocker, alg fixes LIMS_CORE_JWT_ALG, session_id stable across refresh (brief done_when; spec/chunks/C0-foundation-contracts/06-IMPLEMENTATION-PLAN.md:173 R-2). No change to the test body.
- Defect: `tests/spikes/SP-1.decision.test.mjs` is at root `tests/`, which is not in the ownership tree (spec/program/01-CHUNK-MAP.md:16: every path has one owning chunk; CI rejects unowned paths). The tester's own notes name `db/tests/spikes/` (.orchestra/notes/SP-1-tests.md:2-3), and `db/tests/` is a listed owned path (01-CHUNK-MAP.md:107).
- The writer is right that writers may not edit tests, so the TESTER does the fix:
  1. `git mv tests/spikes/SP-1.decision.test.mjs db/tests/spikes/SP-1.decision.test.mjs`
  2. Change the line 1 run command to `node --test db/tests/spikes/SP-1.decision.test.mjs`.
  3. Change line 7 to `new URL('../../meta/decisions/SP-1.md', import.meta.url)`.
  4. Re-run the test. Expect pass 8, fail 0.
- Implementation `db/meta/decisions/SP-1.md` needs no change.
- Planner note, not part of this ruling: `db/` is C0-0B ONLY (01-CHUNK-MAP.md:107), but this lane is C0-0A. The brief assigns `db/meta/decisions/SP-1.md` here, so the lane assignment must be confirmed. The same applies to tests SP-2/3/5/8 under root `tests/spikes/`.
