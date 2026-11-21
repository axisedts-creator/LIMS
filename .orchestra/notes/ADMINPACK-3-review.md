APPROVE

Scope: `git diff 0ed863fa6..HEAD`, 8 files (4 source/test under services/api identity, 4 notes). Within the 7-file cap for owned code paths; notes are role files.

Checked:
- Service `applyRolePack(ctx, input, addMissing?)`: 3rd arg absent = old path byte-for-byte (lines 86-95 unchanged). Plan-all-then-write; refusals (not in pack, lab lacks role, default role, unassignable code, privileged gap on non-MFA role, empty/duplicate/non-array roles, non-boolean yes) all `common.validation_failed` before any write. Writes only via `repo.addPermissions` (INSERT ... ON CONFLICT DO NOTHING); no UPDATE/DELETE; mfa_required/display_name never touched. One `role.change` access event per changed role, none on dry run or no-op. Idempotent.
- Tenant isolation: tenant from ctx only; every SQL names tenant_id; no SQL/policy/migration change, so RLS unchanged.
- CLI: `--add-missing` repeatable with PACK regex, `--yes` valueless and requires a role; one tx per run (rollback on refusal); refusal exit 2, failure exit 1, one bounded stderr line, no stack/PHI/secret.
- Names verbatim: `role.change`, `common.validation_failed`, `auth.unauthenticated`, `common.internal`, pack codes `elabcorp_default`/`elabassist_standard`, roles `corp_admin`/`std_admin`. LD-262 cited in both files.
- Runbook: dry run then `--yes` for both roles, explains output, sign in again, PG* names only, no secrets.
- Tests cover every done_when item (dry run no write, exact missing set, extras kept, second run no-op, refusals, audit once/none, privileged-to-non-MFA refused, default unchanged).

Ran: `pnpm --dir services/api exec vitest run src/modules/identity/__tests__/role-packs/` = 551 passed, 1 failed. The failure is `route-guard.test.ts` (RM-T03 AppShell nav regex): file not touched by this diff, already failing on HEAD per tester note; out of scope.
