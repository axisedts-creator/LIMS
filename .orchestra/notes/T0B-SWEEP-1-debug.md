# T0B-SWEEP-1 debug
Cause: db/tests/run-suites.sh never got the LIMS_PG_PREPARE_ONLY branch the impl note claims (missing from commit 6971b0b8b), so `sweep` ran every pgTAP suite; an unrelated failure (quality.v_pub_qc_summary, T0B-08_views) made prepare exit 1 after 441s.
Fix: added the branch after the storage stub: drops the EXIT trap (run.ts removes the container), prints `LIMS_PG_READY <name> <port> <superPw> <apiPw>`, exit 0. No test edited.
Verified: `pnpm --filter @lims/api sweep` -> 1018 ops, 36 defects, gate ok; vitest test-sweep/__tests__ run.
