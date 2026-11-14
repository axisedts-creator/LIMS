# T0A-10 debug (debugger)
- Log tail = `packages/shared-ts` tests (`ERR_MODULE_NOT_FOUND: @lims/contracts`), not T0A-10 files. No `packages/contracts` exists, `@lims/contracts` not in shared-ts deps: other task's gap.
- Official verify (`node --test tools/lint/tests/ci-workflows.test.mjs`) re-run now: 80 pass / 0 fail / 1 skip (devstack compose + UPSTREAM.lock not landed).
- No code change: T0A-10 impl has no defect. Fix for shared-ts belongs to owner of shared-ts/contracts (needs CR if package missing).

## round 2
- Same log tail: shared-ts tests import `@lims/contracts/ports/common` (src/errors); no `ports/` in `contracts/`, pkg not in workspace (`pnpm-workspace.yaml` = packages/* only), not in shared-ts deps. Already tracked by `.orchestra/cr/T0A-08.md` (tsconfig comment); owned by T0A-08/T0C-02/05, not T0A-10.
- Root `verify` script chains shared-ts tests, so their failure masks T0A-10. Official T0A-10 test re-run: 81 tests, 80 pass / 0 fail / 1 skip.
- No code change: no T0A-10 defect; editing shared-ts/root package.json is outside T0A-10 ownership.

## round 3
- Same log: shared-ts tests fail `ERR_MODULE_NOT_FOUND @lims/contracts` (no packages/contracts yet; tracked in `.orchestra/cr/T0A-08.md`). Not T0A-10 code.
- Official verify `node --test tools/lint/tests/ci-workflows.test.mjs` re-run: 81 tests, 80 pass / 0 fail / 1 skip.
- No code change; shared-ts/root `verify` script outside T0A-10 ownership. Needs orchestrator: scope verify to the T0A-10 test or land contracts pkg first.
