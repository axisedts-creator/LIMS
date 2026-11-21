# T0D-OFFLINE-3 tester, LD-409
Re-recorded ONLY snapshot "Daily cash (open shift) 1" in rs-c4.screens.test.tsx.snap via runner:
pnpm --dir apps/web exec vitest run --config src/features/frontdesk/__tests__/vitest.rs-c4.config.ts -u -t "Daily cash \(open shift\)" src/features/frontdesk/__tests__/rs-c4.screens.test.tsx
Result: Snapshots 1 updated; Test Files 1 passed; Tests 1 passed | 4 skipped. Diff +69/-5, all hunks inside the Daily cash block (Register x3, Credit party untouched).
Flag (LD-409): new markup drops Business date aria-describedby + hint; Daily cash owner to restore.
