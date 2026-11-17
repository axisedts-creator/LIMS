# HC-T08 debug
- Cause: env, not code. verify.log only line: Docker daemon down (npipe dockerDesktopLinuxEngine missing); HC-T08.pg.sh cannot bootstrap PG17. `docker info` still shows no server.
- Fix: none in implementation. Start Docker Desktop, rerun .orchestra/notes/HC-T08-verify.cmd.
- Also (impl note OPEN): tester-owned boot.test.ts IMPLEMENTED list lacks the 5 HC-T08 handlers; boot specs also need LIMS_ENGAGEMENT_OTP_HMAC_KEY_FILE. Neither is impl code.

## Round 2 (docker up; verify rerun: 3 files fail, 2 pass, 18 tests pass / 51 skipped)
- Cause: test fixtures, not impl. All 3 DB files call seedWorld('a') (repository/__tests__/helpers.ts:64) in parallel workers on one DB; each inserts hc.route(s) with the same (tenant,centre,member,route_date) key but a new id. seed() uses ON CONFLICT DO NOTHING (frontdesk helpers.ts:67), so the loser's route is silently skipped and its visit_assignments insert (helpers.ts:78) fails FK visit_assignments__route__fk (05-SCHEMA.md:333).
- Fix: none in impl code (tests off-limits). Tester must give seedWorld a per-file route_date (or run visits files serially). See HC-T08-dispute.md.
