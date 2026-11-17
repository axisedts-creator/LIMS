## T0B-REGAPI-1 debug (2026-11-17)
- Verify log: 33 failures, all in files outside this diff (downtime, registration discount, quote, boot.test.ts); no regapi.test.ts failure. Diff touches only patient.ts, patient.dto.ts, patients.repo.ts, patient.service.ts, regapi tests, pg.sh.
- Cause 1 (flake): parallel files mutate shared tenant settings (require_referrer, discount limits), giving referrer_required / discount_approval_required / version_conflict. A serial run cleared 12 of 14 earlier. Not implementation; no code change.
- Cause 2 (stale test): unit/boot.test.ts:263 expects no frontdesk nav entry, but ADMINPAGE-FD-1 (already on main, 5f0db6c99) added 4 entries in apps/web. Fails without this diff; test is stale, I may not edit it. Lead to triage. No fix applied.
