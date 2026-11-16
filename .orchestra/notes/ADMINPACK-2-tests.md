# ADMINPACK-2 tests (tester)
- New: services/api/src/modules/identity/__tests__/role-packs/apply-role-pack.script.test.ts (static; 6 package.json checks + 7 runbook checks).
- Existing, rerun unchanged: .../role-packs/apply-role-pack.cli.test.ts.
- Run: .orchestra/notes/ADMINPACK-2-verify.cmd (pnpm --dir services/api exec vitest run <the two files>).
- Runbook location: docs/runbooks/apply-role-pack.md if docs/runbooks exists (it does not today), else .orchestra/notes/ADMINPACK-2-runbook.md. Test picks whichever applies.
- Runbook test needs: both exact command lines, PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE named (no `NAME=value`, no host/IP/URL), created/updated/unchanged, tenant uuid lookup, administrator + sign in again.
- Expected now: package.json + runbook tests fail (script and runbook missing); CLI-unchanged and bootstrap tests pass.
