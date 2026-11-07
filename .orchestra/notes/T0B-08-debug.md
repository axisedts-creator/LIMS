# T0B-08 debug
- Cause: generated probes (db/tests/isolation/_registry.sql + 12 <schema>.<table>.test.sql) were never committed in the writer commit, so gate-10 "committed isolation/ is current" test failed (13 files missing).
- Fix: re-ran `node db/tools/gen-isolation-probes.ts`; generator unchanged, no test touched. Files left untracked for the orchestrator to commit.
- Result: `node --test tests/db/T0B-08.suites.test.mjs` 41/41 pass. Live pgTAP not run.
