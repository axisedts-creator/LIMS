# ADMINPAGE-FD-1 debug
Cause: rs-c4.baseline.json was never regenerated in any commit (impl note said it was; git log shows last change 17408b2f1). 3 adminpage-fd-1.baseline tests failed: nav.manifest.ts hash, frontdesk.settings.manage permission/route, settings page route file.
Fix: ran `node apps/web/src/features/frontdesk/__tests__/rs-c4.signature.ts --write` (brief lists the baseline as an impl file; tester note says implementer regenerates). Diff: only rs-c4.baseline.json, +20/-2.
Verified with the verify.cmd commands: adminpage-fd-1 45/45, nav-complete 17/17, rs-c4.static 10/10. No test edited.
Round 2: round-1 regen never reached git (HEAD a11eb0b89 held only the note; baseline had 0 hits for frontdesk.settings.manage). Re-ran the same --write; baseline is modified in the working tree and needs committing. Same three verify commands: 45/45, 17/17, 10/10.
