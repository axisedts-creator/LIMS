# T0B-CONTENT-1 debugger
- Cause: not an impl defect. The 9 content operations (setProfileImage, clearProfileImage, listMyPortalContent, ...) are absent from engagement.yaml on lane/C0-0G; T0C-CONTENT-1 lives on lane/C0-0C (git show lane/C0-0C:contracts/openapi/engagement.yaml has setProfileImage). 69 failures = 10 static "op in spec" + boot check + dependents.
- Fix: `git merge lane/C0-0C` (not on HEAD, merge-base check says notmerged), then delete the 9 content ids from `pendingOperations` in services/api/src/modules/engagement/index.ts (static.test requires them gone).
- BLOCKED: the merge command is denied (needs approval) in this session; nothing changed in code. Needs the lead/founder to run the merge, then re-run verify.
## round 2
- Same cause: lane/C0-0C (T0C-CONTENT-1 spec ops) not merged into lane/C0-0G; `git merge-base --is-ancestor lane/C0-0C HEAD` = notmerged. 5 distinct failures in verify.log, all spec-missing.
- Fix needed: `git merge lane/C0-0C`, then drop the 9 content ids from pendingOperations in services/api/src/modules/engagement/index.ts. Merge denied again (needs approval); no code changed. Lead must merge, re-run verify.
## round 3
- Same cause: lane/C0-0C (T0C-CONTENT-1 spec ops) not merged; engagement.yaml has 0 setProfileImage. No impl defect.
- Fix needed: `git merge lane/C0-0C`, then drop 9 content ids from pendingOperations in engagement/index.ts. Merge denied again (needs approval); no code changed. Lead must merge, re-run verify.
