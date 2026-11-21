# T0D-MISREPORTS-1 dispute — round 3 (writer, 2026-11-20 13:00)
Tree: 3aa005c81. `vitest -c vitest.rs-c8.config.ts`: 2 failed / 34 passed. misreports1 141/141, rs-c2 74/74.
1. Round-2 ruling point 1 not done: both .snap files are unchanged since 6c1b8b4c1 (T0D-UIDASH-1); 3aa005c81 touched only rs-c8.static.test.ts, tests.md and verify.cmd, though tests.md says "both .snap re-recorded".
   Failing: rs-c8.screens.test.tsx "Report hub (tabs)" and rs-c8.screens.admin.test.tsx "New schedule form" — diff is only the new catalogue rows (Sales representative, Consultant, Repeated patient, Repeated test, ...), required by the brief items 2-3 and A39-7.
2. Route case (point 2) is fixed: rs-c8.static.test.ts green.
Ask: tester runs both screens tests with `-u` from this tree and commits the two files under apps/web/src/features/analytics/__tests__/__snapshots__/. Writer may not edit .snap (test file). No implementation change.
