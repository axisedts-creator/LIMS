APPROVE

Round 2: reviewed `git diff 9bd270f6..HEAD` (writer fix commit 18d46092). Verify re-run: api link.redeem 45/45, worker backfill_link 22/22. pgTAP file not run (needs live DB).

- #1 (per-patient count under PAT_ACC RLS) and #2 (US-EN-03.4 re-redeem 422 vs 200): filed in `.orchestra/cr/T-L2.md` with exact options A/B and (a)/(b); `// CR-pending` comment at link.service.ts:190. Code correctly left unchanged pending ruling.
- #3 fixed: `linkfail:` `expires_at` now +24h (link.service.ts:181), per 05-SCHEMA §7.
- No new defects in the fix commit. Remaining risk: US-EN-03.8 (per-patient half) and US-EN-03.4 are not done until the arbiter rules on CR T-L2; the follow-up must add the pinning tests named in the CR.
