CHANGES
# SEC-DEPS-1 review (reviewer), diff 65e337e9a..47932b1f6

1. `.github/workflows/pr.yml:388-392` (the new non-blocking step, `continue-on-error: true`) breaks the existing gate test `tools/lint/tests/ci-workflows.test.mjs:200-205` ("gates cannot be bypassed inside pr.yml (no continue-on-error / `|| true`)", asserts `doesNotMatch(/continue-on-error:\s*true/)` on the whole file). That test is in the `pnpm -s verify` node step, so this task makes verify red with a new failure (base pr.yml has 0 `continue-on-error`; verified by running `node --test "tools/lint/tests/*.test.mjs"`: this test fails at HEAD). done_when requires verify green. LD-239 mandates the continue-on-error step, so the code is right and the old test now contradicts a binding lead decision. Exact fix (tester, owner of that test): narrow ci-workflows.test.mjs:202 to allow `continue-on-error: true` only on the one step whose `run:` is exactly `pnpm audit --audit-level=high` (cite LD-239 in a comment), and keep the rule for every other step; keep the `|| true` and `|| exit 0` asserts unchanged. Do not rename or reword the step to dodge the regex. If the tester may not touch that file under this task, write `.orchestra/cr/SEC-DEPS-1.2.nonblocking.md` naming the conflict instead of leaving verify red silently.

Checked and fine:
- ajv 8.20.0 and yaml 2.9.1 in every importer; lock has no ajv < 8.18.0 or yaml 2.x < 2.8.3; vitest 3.x and tinypool 1.1.1 gone; lodash override kept with GHSA comment. `node --test tests/security/sec-deps1.test.mjs` 18/18 pass (run by me).
- pr.yml blocking `pnpm audit --prod --audit-level=high` after frozen install in the same job, no `|| true`; `pnpm audit fix` not used.
- prism-cli kept with CR SEC-DEPS-1.1 naming faker 5.5.3 (GHSA-qxc2-j82w-r537) and uuid 8.3.2, reason given (root mock:* scripts + c10..c17 tests) as LD-239 asks.
- vitest 3.2.6 -> 5.1.0 in contracts/fakes/codegen matches apps/web; `turbo run build typecheck --filter=!@lims/web` 13/13 green (run by me). `@lims/web#typecheck` red is pre-existing (SEC-HDR-1 review notes it before this task).
- Only owned paths; no secrets, no PHI, no spec/contracts/migration edits; nothing invented.
- Other 2 lint-test failures (supabase-pin, build smoke) are not touched by this diff (build smoke hits ERR_PNPM_IGNORED_BUILDS in this lane's local install); not counted.

Not verified: real `pnpm audit` result (network), real `pnpm install --frozen-lockfile` (local run stops at ERR_PNPM_IGNORED_BUILDS after "Lockfile passes supply-chain policies").
