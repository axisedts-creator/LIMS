CHANGES
LEAD NOTE (LD-259, first lead reset). The task did not fail on behaviour. The page, the nav entry, the route row and the settings tests are in place; the dispute about user.type is ruled (setText uses paste) and adminpage-fd-1 passes 45/45, nav-complete 17/17, rs-c4.static 10/10.
Only cause of the blocked verify: apps/web/src/features/frontdesk/__tests__/rs-c4.baseline.json is a tester-owned test-support file. The writer and the debugger both regenerated it three times and the lane reverted it every time ("may not touch"), so the committed baseline never carried the new nav entry, permission, route and fields.
What the lead did: ran `node rs-c4.signature.ts --write` in this worktree. The diff is exactly the new frontdesk.settings.manage permission, the /v1/frontdesk/settings route, the nine F24 field names, updateFrontdeskSettings and the new nav.manifest.ts hash (plus the registration permission list line that moved).
Work left:
1. Tester: check that diff is the expected one (re-run the command, it must give no further change), commit rs-c4.baseline.json, run the three verify commands. Do not edit any assertion or value.
2. Writer: no change expected. Do not touch rs-c4.baseline.json.
3. Reviewer: review the page as specified in the task (F24 fields, validation, 409, permission gating, nav entry).
