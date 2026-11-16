# ADMINPACK-4 impl (writer)
- Files: `identity/service/role-pack.service.ts` (closed `reason` + `role_code` on the refusal, LD-265), `identity/cli/apply-role-pack.ts` (`refused:` line, plain-apply code lists, `--list`, `describePackRoles`, `captureDbErrors`, `db:` line), `.orchestra/notes/ADMINPACK-4-runbook.md` (new).
- [CONV] `captureDbErrors` wrapper = `Object.create(tx, { query })` not a Proxy: core tx is `Object.freeze`d, a Proxy get-trap would break the invariant. core/ untouched.
- [CONV] `--list` reuses `repo.listRoles` (one SELECT), no audit call; unknown pack gives reason `args` (exit 2).
- Tests: 4 verify suites 197/197 pass; all of role-packs/ 624/625 (only `route-guard.test.ts` AppShell nav fails, pre-existing per tester, unrelated). tsc clean for the touched files.
- Open: not run against a real DB or Supabase; the runbook assumes the CA file is saved as `C:\LIMS-cloud-secrets\supabase-ca.crt`; push-cloud.ps1 was not found in this worktree, so the env-file parsing is my own.
