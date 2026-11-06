CHANGES

Scope: `git diff a69b40b..HEAD` (root configs, packages/{shared-ts,test-fixtures,shared-dart}, lockfile, tests/monorepo/skeleton.test.mjs, notes).

1. tests/monorepo/skeleton.test.mjs:1 — file sits under root `tests/`, which no chunk owns (spec/program/01-CHUNK-MAP.md:16 every path has one owner; 02-TRD §1.1 0A list has no `tests/`; tools/lint/ownership.yaml has no `tests/**` rule). Same defect and ruling as SP-1 (.orchestra/notes/SP-1-ruling.md). TESTER fix:
   a. `git mv tests/monorepo/skeleton.test.mjs tools/lint/tests/monorepo-skeleton.test.mjs` (C0-0A owns `tools/lint/**`).
   b. Line 1 run command -> `node --test tools/lint/tests/monorepo-skeleton.test.mjs`.
   c. Line 9 -> `const root = fileURLToPath(new URL('../../../', import.meta.url));`
   d. Update `.orchestra/notes/T0A-01-tests.md` path + run line. Re-run; expect 11 pass, 0 fail.

Checked, no defect:
- Only owned 0A paths (02-TRD §1.1) besides item 1. Names verbatim: `@lims/shared-ts`, `@lims/test-fixtures`, `lims_shared` (TRD §1.3); Turborepo/pnpm per TRD §2.2; Node 26.x exact in `.nvmrc` = `engines.node` (TRD §2.1).
- Exact versions only, packages private, no lifecycle scripts, lockfile tracked (REQ-SEC-129). No secrets, no PHI, gitleaks default ruleset.
- RLS / permissions / idempotency / rate tier / error codes: not applicable (no DB/API code).
- Ran `node --test tests/monorepo/skeleton.test.mjs`: 11/11 pass. Ran `pnpm -w build --force` (0 cached) + `pnpm -w typecheck`: pass, dist emitted, `git status` clean (AC-0A-1.4 "no generated file differs").

Non-blocking:
- Smoke test does not enforce "no network except registry"; Turbo telemetry calls out (impl note). Build still succeeds; set `TURBO_TELEMETRY_DISABLED=1` in the CI job (T0A CI task).
- Local Node 25.8.0 ran the build; pnpm does not enforce `engines` without `engine-strict`. CI image must use `.nvmrc`.
- `tests/lint/ownership.test.mjs` (T0-02) has the same unowned-path issue; planner should route a move.
