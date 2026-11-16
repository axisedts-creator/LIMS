# ADMINPACK-3 impl (writer)
- `service/role-pack.service.ts`: `applyRolePack(ctx, input, addMissing?: {roles, yes})`; 3rd arg absent = old code path untouched. Plan-all-then-write (all-or-nothing), `repo.addPermissions` + one `role.change` audit per changed role.
- `cli/apply-role-pack.ts`: `--add-missing <role>` (repeatable, `=` form), `--yes` (no value, needs a role); optional `deps.addMissing`; refusal (`common.validation_failed`) = exit 2; entry point wires both into one request tx per run.
- `.orchestra/notes/ADMINPACK-3-runbook.md`: founder dry run then `--yes`, for corp_admin and std_admin.
- [CONV] refusals also apply to a dry run (privileged code to a non-MFA role, default role, unassignable pack code), so a dry run never promises what `--yes` would refuse.
- Ran the 4 suites: 124 passed; `tsc --noEmit` shows no errors in the touched files. Other tests (the 4 listed) only; full suite not run.
- Open: none. No dispute.
