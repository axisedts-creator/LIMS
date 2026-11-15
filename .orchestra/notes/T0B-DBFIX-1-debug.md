DEBUGGER, T0B-DBFIX-1, 2026-11-15
Cause: verify fails only because the LD-230 (1)-(6),(8),(9) repairs exist as .orchestra/notes/T0B-DBFIX-1-dbtests.patch but are not in the tracked db/tests/** files or run-suites.sh (storage stub). The writer role gate reverts them. Test tests/db/T0B-DBFIX-1.fixtures.test.mjs is right (ruling points 1-3); no spec contradiction, no dispute.
Fix: none possible in implementation code. db/tests/** and run-suites.sh are test files, which the debugger may not edit. Per LD-243 route (b) the tester must run `git apply .orchestra/notes/T0B-DBFIX-1-dbtests.patch` unchanged (--3way if context drifted) and commit it. Then run `node --test tests/db/T0B-DBFIX-1.fixtures.test.mjs` and `gen-isolation-probes --check`.
Not verified: the lane cannot run SQL (no Docker); founder reruns the suites in T0B-DBFIX-1-impl.md.

Round 2: verify log unchanged. Only 2 of 45 tests fail (roles 00_bootstrap_roles test 17; app T0B-02_helpers test 57), both because db/tests is unpatched. No implementation fix exists; no test edited. Tester must git apply the saved patch (LD-243 b). git apply --check was not run (not permitted here).
