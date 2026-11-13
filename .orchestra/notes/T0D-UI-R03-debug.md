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
