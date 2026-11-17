# T0C-LINTFIX-1 dispute (debugger)
Verify red: 9/9 in services/api/src/modules/identity/__tests__/role-packs/apply-role-pack.script.test.ts (ADMINPACK-2), not in LINTFIX-1 scope. lint-openapi 156/156, lintfix1 12/12 green.
1. Line 33 + 136 pin package.json scripts to 5 names; `sweep` was added by T0B-SWEEP-1 (commit 6971b0b8b). Test is stale vs main.
2. Lines 16-17 pick docs/runbooks/apply-role-pack.md as soon as docs/runbooks exists (environment.md, staging-worker.md now live there); that file was never written, runbook sits in .orchestra/notes/ADMINPACK-2-runbook.md. Test is stale vs main.
Fixing needs a package.json script removal (breaks T0B-SWEEP-1) or a docs/ file outside this task's 8-file/no-docs scope. Task brief forbids both; tests may not be edited.
Ask lead: drop role-packs/apply-role-pack.script.test.ts from the verify command (or assign a task to refresh it). Failure pre-exists on main, not caused by this change.
