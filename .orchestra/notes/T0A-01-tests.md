# T0A-01 tests
- File: tests/monorepo/skeleton.test.mjs (node:test, no deps)
- Run: `node --test tests/monorepo/skeleton.test.mjs`
- Covers: root configs exist (TRD §1.1), exact pinned pnpm/node + .nvmrc match, build/typecheck scripts, workspace + turbo + tsconfig, Dart workspace, packages/shared-ts + test-fixtures private/exact-deps/no lifecycle scripts, lockfile tracked (REQ-SEC-129).
- AC-0A-1.4 smoke: `pnpm install --frozen-lockfile && pnpm -w build`, then `git status` unchanged (needs pnpm on PATH + registry).
- Package names assumed: @lims/shared-ts, @lims/test-fixtures, lims_shared (Dart).
- Implementer must create pnpm-lock.yaml (via pnpm install) and commit it before the smoke test can pass.
