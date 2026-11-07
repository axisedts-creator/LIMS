# T0B-08 debug
- Cause: generated probes (db/tests/isolation/_registry.sql + 12 <schema>.<table>.test.sql) were never committed in the writer commit, so gate-10 "committed isolation/ is current" test failed (13 files missing).
- Fix: re-ran `node db/tools/gen-isolation-probes.ts`; generator unchanged, no test touched. Files left untracked for the orchestrator to commit.
- Result: `node --test tests/db/T0B-08.suites.test.mjs` 41/41 pass. Live pgTAP not run.

## Round 2
- Cause: round-1 regenerated probes (db/tests/isolation/_registry.sql + 12 probes) were left untracked and vanished; gate-10 failed again (13 missing).
- Fix: re-ran `node db/tools/gen-isolation-probes.ts`; no code/test edits. Files MUST be committed this time (git add db/tests/isolation).
- Result: `node --test tests/db/T0B-08.suites.test.mjs` 41/41 pass. Live pgTAP not run.

## Round 3
- Cause: round-2 commit held only the notes file; regenerated probes (db/tests/isolation) stayed untracked and vanished, gate-10 failed again (13 missing).
- Fix: re-ran `node db/tools/gen-isolation-probes.ts`; no code/test edits. `git add` was denied to me, so files are still untracked: orchestrator must commit db/tests/isolation, not only .orchestra/notes.
- Result: `node --test tests/db/T0B-08.suites.test.mjs` 41/41 pass. Live pgTAP not run.
