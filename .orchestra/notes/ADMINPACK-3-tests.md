# ADMINPACK-3 tests (tester)
- NEW `services/api/src/modules/identity/__tests__/role-packs/role-pack.add-missing.test.ts`: service seam `applyRolePack(ctx, {packCode}, {roles, yes})` (dry run, --yes exact set, idempotent, audit once per changed role, refusals, privileged/non-MFA, unknown code via loader mock, default unchanged) + static checks of `.orchestra/notes/ADMINPACK-3-runbook.md` (writer creates it).
- EXTENDED `.../role-packs/apply-role-pack.cli.test.ts`: new describe for `--add-missing` / `--yes` (optional `deps.addMissing`, exit 0/1/2, usage errors).
- ASSUMED API is in the header comments of both files (3rd arg shape, `add_missing` body, refusal = `common.validation_failed` -> CLI exit 2). Raise a dispute if the writer needs another shape.
- Run: `.orchestra\notes\ADMINPACK-3-verify.cmd` (4 files, through the package). Not the whole dir: `route-guard.test.ts` there fails on HEAD (AppShell regex), unrelated.
- Now: 27 add-missing + 8 cli tests fail (no flag, no 3rd arg, no runbook); the old tests in those files and the service/script suites pass.
