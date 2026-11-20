# T0D-OFFLINE-3 tester, LD-428
Re-recorded only "Daily cash (open shift) 1" in rs-c4.screens.test.tsx.snap (git diff: that one snapshot only).
Run on the WHOLE file with -u, not with -t: React useId values (_r_4_ vs _r_sb_) depend on which tests ran first, so a -t run records ids that fail the full run.
Command: pnpm --dir apps/web exec vitest run --config src/features/frontdesk/__tests__/vitest.rs-c4.config.ts -u src/features/frontdesk/__tests__/rs-c4.screens.test.tsx
Result: vitest.rs-c4.config.ts full run = 4 files, 37/37 passed. Committed the .snap itself.
