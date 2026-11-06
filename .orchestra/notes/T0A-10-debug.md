# T0A-10 debug (debugger)
- Log tail = `packages/shared-ts` tests (`ERR_MODULE_NOT_FOUND: @lims/contracts`), not T0A-10 files. No `packages/contracts` exists, `@lims/contracts` not in shared-ts deps: other task's gap.
- Official verify (`node --test tools/lint/tests/ci-workflows.test.mjs`) re-run now: 80 pass / 0 fail / 1 skip (devstack compose + UPSTREAM.lock not landed).
- No code change: T0A-10 impl has no defect. Fix for shared-ts belongs to owner of shared-ts/contracts (needs CR if package missing).
