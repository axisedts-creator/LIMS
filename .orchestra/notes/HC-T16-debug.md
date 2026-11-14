# HC-T16 debug
- Cause: verify aborts in db/migrations/20261113230000_instruments__add_truth_h80e_driver.sql (H80-T05, C7): INSERT runs as lims_migrator, file lacks `SET LOCAL ROLE lims_owner;` (the instruments schema migration line 7 has it). Not HC-T16 implementation code.
- Fix: none applied. File not owned by C17 (CLAUDE.md). Filed .orchestra/cr/HC-T16.md for C7: add the one-line SET LOCAL ROLE. Re-run verify after it lands.
- Round 2: re-checked. Migration 20261113230000 (C7, commit 80055cec) still lacks SET LOCAL ROLE lims_owner; verify log still dies there at line 12. CR .orchestra/cr/HC-T16.md still open. No C17 code change possible. Blocked on C7.
- Round 3 (LD-167 base, C7 fix present): real failures now. Cause: sweep_missed_visits inserted the `missed` visit_assignments row with membership_id set; 05-SCHEMA `visit_assignments__shape__ck` requires NULL for missed. Fix: membership_id: null (tasks/sweep_missed_visits.ts:25). Verify 20 -> 8 failures.
- Remaining 8 are test/fixture defects (see HC-T16-dispute.md); no further implementation change made.
