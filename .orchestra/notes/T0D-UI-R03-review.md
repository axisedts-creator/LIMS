TESTER: the snapshot file packages/ui/src/components/__tests__/__snapshots__/ui-r03-kit-pass.test.tsx.snap was recorded by the debugger three times and reverted by the harness each time (REVERT lines in the C0 log at 14:32, 14:42, 14:50, 14:58: only test files written by the tester survive). You are the only role that may add it.
1. From packages/ui run the same test file with the update flag, once, without CI=true: pnpm exec vitest run -u src/components/__tests__/ui-r03-kit-pass.test.tsx  (10 snapshots expected).
2. Re-run the command in T0D-UI-R03-verify.cmd (CI=true) and confirm it passes (the debugger saw 370/370).
3. Do not change any assertion and do not touch component code; the .snap must stay in your commit.
WRITER: no change.
