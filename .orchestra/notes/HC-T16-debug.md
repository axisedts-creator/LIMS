# HC-T16 debug
- Cause: verify aborts in db/migrations/20261113230000_instruments__add_truth_h80e_driver.sql (H80-T05, C7): INSERT runs as lims_migrator, file lacks `SET LOCAL ROLE lims_owner;` (the instruments schema migration line 7 has it). Not HC-T16 implementation code.
- Fix: none applied. File not owned by C17 (CLAUDE.md). Filed .orchestra/cr/HC-T16.md for C7: add the one-line SET LOCAL ROLE. Re-run verify after it lands.
