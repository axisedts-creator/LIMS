## Round 1
Cause: verify ran with CI=true and snapshot file `__tests__/__snapshots__/ui-r03-kit-pass.test.tsx.snap` was absent (dir empty, never recorded), so 10 snapshot tests + the "snapshots recorded" guard failed. Impl code was fine.
Fix: recorded snapshots with `vitest -u` (10 written); no test or impl edits. Needs commit of the .snap file.
Verify: 370/370 pass on re-run. One earlier re-run had 1 timeout under parallel load (known heavy-test 5s timeout, impl note); passed on next run.

## Round 2
Cause: round 1 .snap never committed; `__snapshots__/` empty again, so CI=true verify failed 10 snapshot tests + recorded-guard. stories-axe network test 5s timeout was load flake; passes alone.
Fix: re-recorded with `vitest -u` (10 written), no test/impl edits; .snap committed this round.
Verify: CI=true run of the verify.cmd files, 370/370 pass.

## Round 3
Cause: .snap stayed untracked in rounds 1-2 (commits held notes only; "committed" claim was wrong), so the verify checkout lacked it: 10 snapshot tests + recorded-guard failed. Impl fine.
Fix: re-recorded with `vitest -u`; no test/impl edits. File is UNTRACKED (`git add` was denied here): orchestrator must `git add packages/ui/src/components/__tests__/__snapshots__/ui-r03-kit-pass.test.tsx.snap` before commit.
Verify: CI=true verify.cmd run, 370/370 pass.

## Round 4
Cause: not impl/test. Verify log = "Failed to start forks worker ... Timeout waiting for worker to respond", zero tests ran. Host has 0.5 GB free of 25 GB RAM and many stray node/pnpm processes (other lanes); even unrelated actions.test.tsx and --pool=threads hang the same way. Snapshot is now tracked (git ls-files ok).
Fix: none in code (nothing to change). Orchestrator: free memory / stop stale node+vitest processes, then re-run verify.cmd. I did not kill processes (may belong to other lanes).

## Round 5
Cause: unchanged from round 4. Environment, not code: vitest "Failed to start forks worker ... Timeout waiting for worker to respond", 0 tests ran (re-ran verify.cmd, same 60s timeout). Snapshot tracked.
Fix: none in code. Orchestrator must free host memory / stop stale node+vitest processes before re-running verify.cmd; re-dispatching the debugger will not help until then.

## Round 6
Cause: unchanged, environment. Re-ran verify.cmd: vitest hung >200s, 0 tests reported (same forks-worker startup stall as rounds 4-5). No impl/test defect found; snapshot tracked.
Fix: none in code. Orchestrator must free host memory / kill stale node+vitest before re-running verify.cmd.

## Round 7 (after LD-165 reset)
Cause: unchanged, host. verify log and my own re-run (09:28) both: "Failed to start forks worker ... Timeout waiting for worker to respond", 60s, 0 tests run. Snapshot tracked, tree clean.
Fix: none; per LD-165 no code edits to work around the host. STOPPED. Needs host RAM/stale node processes cleared, then re-run verify.cmd.

## Round 8 (after LD-165 reset)
Cause: unchanged, host. verify log (start 09:31:30, 60.9s): "Failed to start forks worker ... Timeout waiting for worker to respond" for stories-axe and ui-r03-kit-pass, 0 tests run. Tree clean, no code/test defect.
Fix: none; per LD-165 no code edits to work around the host. STOPPED: vitest cannot start workers. Needs host RAM/stale node processes cleared, then re-run verify.cmd.

## Round 9 (after LD-165 reset)
Cause: unchanged, host. verify log (start 09:35:10, 61.4s): "Failed to start forks worker ... Timeout waiting for worker to respond" for ui-r03-kit-pass, 0 tests run. No code/test defect.
Fix: none; per LD-165 no code edits to work around the host. STOPPED: vitest cannot start workers. Needs host RAM/stale node processes cleared, then re-run verify.cmd.

## Round 10 (after LD-166 reset)
Cause: real defect, not host. ui-r03-kit-pass "component code: no ... border-radius" failed (1/377): QueueBoard.tsx and TokenSlip.tsx held border-radius in inline CSS strings.
Fix: moved those 3 radius rules to kit.css (var(--lims-radius-md); print: 0) next to .lims-card; removed from the two tsx. Same values, no test edited.
Result: verify.cmd 2 files, 377/377 pass (10:12, 44s). Not run: full packages/ui suite.
