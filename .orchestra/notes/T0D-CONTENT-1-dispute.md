# T0D-CONTENT-1 dispute (debugger, round 2)
Failing verify test: engagement/__tests__/adminpage-eng-1.static.test.ts:97 ("no new permission and no contract change") - engLines(perms) must equal engLines(base) for `code: engagement.*`.
Received extra lines: engagement.broadcast.read/manage/approve and engagement.content.read/manage in contracts/permissions.yaml. Added by T0C-CONTENT-1 (9a920abce) on main, not by T0D-CONTENT-1 (this task touches no contracts file).
Spec: LD-313(c) "NEW permission codes are allowed for these two modules" (portal content = engagement module; must be in permissions.yaml and corp_admin pack); LD-321 lists engagement.broadcast.read/manage/approve as new codes. Lead decisions outrank the chunk docs (CLAUDE.md precedence).
No impl change can satisfy it (would mean deleting contract permissions). Test fix, as done for billing.* in ruling T0D-ENGBOOK-1: at :99-100 allow `engagement.content.*` and `engagement.broadcast.*` new codes, and filter those from engLines at :96-97 (or compare only codes in the base set).
Debugger stops; tests untouched.
