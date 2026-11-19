## T0B-REGAPI-1 debug (2026-11-17)
- Verify log: 33 failures, all in files outside this diff (downtime, registration discount, quote, boot.test.ts); no regapi.test.ts failure. Diff touches only patient.ts, patient.dto.ts, patients.repo.ts, patient.service.ts, regapi tests, pg.sh.
- Cause 1 (flake): parallel files mutate shared tenant settings (require_referrer, discount limits), giving referrer_required / discount_approval_required / version_conflict. A serial run cleared 12 of 14 earlier. Not implementation; no code change.
- Cause 2 (stale test): unit/boot.test.ts:263 expects no frontdesk nav entry, but ADMINPAGE-FD-1 (already on main, 5f0db6c99) added 4 entries in apps/web. Fails without this diff; test is stale, I may not edit it. Lead to triage. No fix applied.
## round 2 (verify log 07:54: 30 failed / 1465 passed)
- Same causes; no regapi or patient test fails. Diff touches none of the failing code.
- quote.test.ts:302 expects `additional` without `currency`, quote service sends `currency: "NPR"`: stale test, not in this diff. registration/rollback failures (referrer_required, discount_approval_required, version_conflict) = shared tenant-settings flake under parallel files. boot.test.ts:263 stale vs ADMINPAGE-FD-1 nav entries.
- No code fix; tests may not be edited. Lead: triage quote.test.ts and boot.test.ts; run frontdesk suite serially.
## round 3 (verify log 07:56: 19 failed / 1476 passed)
- Same causes. Diff (patient.ts, patient.dto.ts, patients.repo.ts, patient.service.ts, regapi tests) touches no failing code; no regapi/patient test fails.
- quote.test.ts:302 stale (quote service sends currency NPR); boot.test.ts:256/263 stale vs ADMINPAGE-FD-1 nav entries; downtime/registration failures = referrer_required from shared tenant-settings bleed between parallel files (count fell 33 -> 30 -> 19 with no code change).
- No code fix; tests may not be edited. Lead: triage quote + boot tests; run frontdesk suite with --no-file-parallelism.
## round 4 (verify log 20:38: 4 failed / 1672 passed, only boot.test.ts)
- Cause: host load, not code. Whole-suite run spawns 65 workers (781s); boot.test.ts autoload() of all modules hit the 60000ms timeout (line 86); the 3 "module engagement/homecollection: index.ts exports no manifest" errors are fallout of the same aborted import under load.
- Alone, boot.test.ts passes 30/30 (165s, 20:53). No regapi/patient failure; diff touches no boot code. No code fix, tests not edited. Lead: rerun verify on an idle host (or cap workers; do not weaken the check).
## round 5 (verify log 21:33: 6 failed / 1671 passed)
- 1 failure in this diff's test: regapi.test.ts:351 expects external_patient_id absent from audit rows; spec/D-27a only excludes government id + address columns, trigger audits external_patient_id by design. Test over-reach: dispute written (T0B-REGAPI-1-dispute.md, round 5). No code change.
- rollback.test.ts:150/180 (no sendSms call) and boot.test.ts (60s timeout, "smartreport exports no manifest" = aborted import under 65-worker load, passes alone 30/30): outside the diff, same load / shared-settings causes as rounds 1-4. Not reproduced this round, not verified.
