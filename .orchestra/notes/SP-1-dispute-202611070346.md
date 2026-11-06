# SP-1 dispute (writer)
- Review item 1 asks the writer to `git mv tests/spikes/SP-1.decision.test.mjs db/tests/spikes/` and edit lines 1 and 7. The writer role forbids editing test files (`**/*.test.*`, `tests/**`, `db/tests/**` per roles/tester.md). This must be done by the TESTER.
- The test file location is wrong: it sits at root `tests/` (unowned per 01-CHUNK-MAP §3), while SP-1-tests.md names `db/tests/spikes/SP-1.decision.test.mjs`. Tester fix: do the move, set the run cmd on line 1 to `node --test db/tests/spikes/SP-1.decision.test.mjs`, and set the path on line 7 to `'../../meta/decisions/SP-1.md'`.
- Ownership note: 01-CHUNK-MAP §3 marks `db/` as C0-0B ONLY. This lane is C0-0A, and both the move target and `db/meta/decisions/SP-1.md` sit under `db/`. Planner should confirm the lane assignment.
- Implementation is unchanged. At HEAD, `node --test tests/spikes/SP-1.decision.test.mjs` gives pass 8, fail 0.
