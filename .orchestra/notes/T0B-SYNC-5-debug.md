# T0B-SYNC-5 debug (2026-11-19 01:25)
- Cause: verify log = 13 retention.live.test.ts failures (`permission denied for table sync_conflict`: lims_worker has no DELETE grant/RLS policy; migration deliberately withheld, CR-C0-T0B-SYNC-5-001) + 2 static pins (registry.static.test.ts:72, sync2.registry.static.test.ts:96 "no DELETE FROM" hit retention.ts; confirmed by rerun). No new defect; hardening/static.test.ts passes.
- Fix: none. Per LD-397 item 2 the DELETE grant/policy/pin supersession is founder reserved (180 days + data deletion); no impl change can pass these without it. Task stays BLOCKED on the founder answer; tests, migration, grants untouched.

# round 2 (2026-11-19 01:30)
- Cause: verify log (01:25 run) = 14 failed / 72, 4 of 6 files green. 10 visible are retention.live.test.ts `permission denied for table sync_conflict` (no DELETE grant/policy; CR-C0-T0B-SYNC-5-001); the other 4 are cut off by the log tail, same two static pins as round 1 (no-DELETE-FROM, no DELETE policy). Same cause, no new defect.
- Fix: none. LD-397 item 2: founder-reserved, do not touch tests/migration/grants. Task stays BLOCKED on the founder answer.

# round 3 (2026-11-19 01:40)
- Cause: verify log (01:31 run) = 14 failed / 72, 58 pass; 10 FAIL lines are retention.live.test.ts `permission denied for table sync_conflict` (no lims_worker DELETE grant/policy, CR-C0-T0B-SYNC-5-001); remaining 4 = same static pins as rounds 1-2. No new defect.
- Fix: none. LD-397 item 2: founder-reserved; tests, migration, grants untouched. Task stays BLOCKED on the founder answer.
