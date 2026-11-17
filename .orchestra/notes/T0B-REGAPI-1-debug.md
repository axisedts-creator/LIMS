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
