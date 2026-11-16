APPROVE

Reviewer notes (ADMINPACK-4, diff 477065dae..HEAD):
- Scope: the code and test files are cli/apply-role-pack.ts, service/role-pack.service.ts, 3 role-packs test files, and the runbook (6 files). The rest are writer/tester notes. Nothing under core/, no SQL, policy, migration, registry, role-pack data or HTTP change. No new package script or dependency.
- (1) The refusal reason set matches the brief verbatim (args, role_not_in_pack, role_missing_in_lab, role_is_system_default, unassignable_code, privileged_without_mfa). The CLI prints only a reason from the closed set plus a role code that passes the PACK regex: one line, no stack. The unassignable permission code is not echoed.
- (2) The plain apply keeps its counts line and adds created/updated/unchanged code lists.
- (3) `--list` is refused with --yes or --add-missing. It reads through repo.listRoles (a SELECT only) and makes no audit.access call and no service apply. Row fields are sanitised.
- (5) I checked that captureDbErrors wraps the tx that core/db/tx.ts hands out. That tx's query returns raw client errors, and mapDbError runs later in the outer catch, so the original SQLSTATE reaches the wrapper. Only identifier-shaped code/schema/table/constraint are kept, never message, detail or params. The first failure wins.
- Exit codes are kept: plain apply refusal 1, --add-missing refusal 2, failure 1. --list refusal is 2.
- Runbook: placeholder-free block, Read-Host -AsSecureString, PGUSER lims_api.$ref, PGSSLMODE require + NODE_EXTRA_CA_CERTS, close-window warning. No secret values.
- Tests run by reviewer: the 4 suites in ADMINPACK-4-verify.cmd pass, 197/197. They cover every reason code, --list output, refusals and no-write/no-audit, the plain-apply listing, and a fake pg error whose detail holds a row value that is not printed.
- Not verified: against a real DB/Supabase. Whether the env-file parsing matches push-cloud.ps1 (the writer could not find that file in the worktree, and the reviewer had no read access to C:\LIMS). The founder's first run will show it. Not a code defect.
