# T0B-SWEEP-1 debug
Cause: db/tests/run-suites.sh never got the LIMS_PG_PREPARE_ONLY branch the impl note claims (missing from commit 6971b0b8b), so `sweep` ran every pgTAP suite; an unrelated failure (quality.v_pub_qc_summary, T0B-08_views) made prepare exit 1 after 441s.
Fix: added the branch after the storage stub: drops the EXIT trap (run.ts removes the container), prints `LIMS_PG_READY <name> <port> <superPw> <apiPw>`, exit 0. No test edited.
Verified: `pnpm --filter @lims/api sweep` -> 1018 ops, 36 defects, gate ok; vitest test-sweep/__tests__ run.
## debugger round 2 (verify log: run-suites.sh prepare failed)
- Cause: db/tests/run-suites.sh in the tree had no LIMS_PG_PREPARE_ONLY mode (edit was missing), so the sweep ran the full pgTAP suites; unrelated T0B-08 view failures (quality.v_pub_qc_summary) failed the prepare.
- Fix: run-suites.sh stops after bootstrap/migrations/seeds/storage stub when LIMS_PG_PREPARE_ONLY=1, keeps the container, prints LIMS_PG_READY. Tests untouched.
- Verified: pnpm --filter @lims/api sweep -> 1018 ops, 36 defects, gate ok.
- Not fixed (out of scope): quality.v_pub_qc_summary failure in T0B-08_views suite.
