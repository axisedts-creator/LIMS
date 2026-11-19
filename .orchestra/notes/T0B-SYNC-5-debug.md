# T0B-SYNC-5 debug (2026-11-19 01:25)
- Cause: verify log = 13 retention.live.test.ts failures (`permission denied for table sync_conflict`: lims_worker has no DELETE grant/RLS policy; migration deliberately withheld, CR-C0-T0B-SYNC-5-001) + 2 static pins (registry.static.test.ts:72, sync2.registry.static.test.ts:96 "no DELETE FROM" hit retention.ts; confirmed by rerun). No new defect; hardening/static.test.ts passes.
- Fix: none. Per LD-397 item 2 the DELETE grant/policy/pin supersession is founder reserved (180 days + data deletion); no impl change can pass these without it. Task stays BLOCKED on the founder answer; tests, migration, grants untouched.

# round 2 (2026-11-19 01:30)
- Cause: verify log (01:25 run) = 14 failed / 72, 4 of 6 files green. 10 visible are retention.live.test.ts `permission denied for table sync_conflict` (no DELETE grant/policy; CR-C0-T0B-SYNC-5-001); the other 4 are cut off by the log tail, same two static pins as round 1 (no-DELETE-FROM, no DELETE policy). Same cause, no new defect.
- Fix: none. LD-397 item 2: founder-reserved, do not touch tests/migration/grants. Task stays BLOCKED on the founder answer.

# round 3 (2026-11-19 01:40)
- Cause: verify log (01:31 run) = 14 failed / 72, 58 pass; 10 FAIL lines are retention.live.test.ts `permission denied for table sync_conflict` (no lims_worker DELETE grant/policy, CR-C0-T0B-SYNC-5-001); remaining 4 = same static pins as rounds 1-2. No new defect.
- Fix: none. LD-397 item 2: founder-reserved; tests, migration, grants untouched. Task stays BLOCKED on the founder answer.

# round 4 (2026-11-19 08:45) — load.live.test.ts:40, 16x common.dependency_unavailable
- Cause: lock-order inversion inside the TEST-ONLY synthetic adapters (hardening/kit.ts:80-93): batch A inserts patient/order/state keys (uncommitted unique-index locks) then takes the gap-free counter (doubles.ts nextNo); batch B holds the counter (to end of tx), then inserts a key A holds -> 40P01. Engine rethrow (engine.ts:233) and core retry (tx.ts:150, 3x, 10-50 ms jitter) behave per 02-TRD §6.4; no production adapter or engine code is involved.
- Fix: none possible in implementation code (a tenant-wide batch lock would change production behaviour, done_when 6). Fix belongs in kit.ts (counter first / sorted keys) = test code, forbidden to me; ruling item 5 also bars the writer. Wrote dispute-202611190850.md; stopped.

# round 5 (2026-11-19 08:50) — verify log 08:48: only load.live.test.ts:40 fails (13x 40P01 -> common.dependency_unavailable); 53/54 pass, retention gone (LD-407)
- Cause: same as round 4, lock-order inversion in test-only synthetic adapters (hardening/kit.ts:80-93 vs doubles.ts nextNo). No code changed since round 4; dispute-202611190850.md still unanswered.
- Fix: none. Fix is in kit.ts (test code, forbidden to me); implementation fix would need a tenant-wide batch lock (violates done_when 6). Waiting for arbiter TESTS_WRONG ruling.
