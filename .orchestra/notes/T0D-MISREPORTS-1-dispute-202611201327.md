# T0D-MISREPORTS-1 dispute (debugger, 2026-11-20)
Verify log: 2 failed / 34 passed in the rs-c8 run. Failing: rs-c8.screens.test.tsx "Report hub (tabs)" and rs-c8.screens.admin.test.tsx "New schedule form". Both are `toMatchSnapshot` mismatches.
Cause: the two .snap files under apps/web/src/features/analytics/__tests__/__snapshots__/ were last committed in 6c1b8b4c1 (T0D-UIDASH-1) and were never re-recorded. The diff is only the new catalogue rows (Sales representative, Consultant, Repeated patient, Repeated test, ...).
Spec: the brief (inbox line 20, items 2-3) and spec/program/08-CR-REGISTER.md:3151 (A39-7) require those catalogue entries. The implementation is correct; the snapshots are stale.
Fix needs: tester runs both screens tests with `-u` from this tree and commits the two .snap files. The debugger may not edit tests; no implementation change.
Same finding as round-2 ruling point 1 and the round-3 writer dispute.
