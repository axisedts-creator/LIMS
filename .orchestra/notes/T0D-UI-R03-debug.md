## Round 1
Cause: verify ran with CI=true and snapshot file `__tests__/__snapshots__/ui-r03-kit-pass.test.tsx.snap` was absent (dir empty, never recorded), so 10 snapshot tests + the "snapshots recorded" guard failed. Impl code was fine.
Fix: recorded snapshots with `vitest -u` (10 written); no test or impl edits. Needs commit of the .snap file.
Verify: 370/370 pass on re-run. One earlier re-run had 1 timeout under parallel load (known heavy-test 5s timeout, impl note); passed on next run.
