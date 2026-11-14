# WEB-BUILD-2 tests (tester)
- `apps/web/src/__tests__/build-config.test.ts` + `vitest.web-build-2.config.ts` beside it (static, no build, no network). Also runs the existing `build-boundaries.test.ts` (16 tests) so it must stay green.
- Run: `.orchestra\notes\WEB-BUILD-2-verify.cmd` (vitest via root node_modules, config path; exits non-zero on failure).
- 7 self-tests with planted failures pass now: old `loadOptions={searchOrderablesAction}`, signal/kind-forwarding wrappers, Code field without maxLength, inputMode union without decimal, ts-ignore / ignoreBuildErrors, JSONC parse.
- Repo guards that FAIL now (right reasons): tsconfig.build.json missing; next.config.mjs has no typescript.tsconfigPath; both Combobox calls pass searchOrderablesAction directly; PriceListDetail Code field has no maxLength; TextField union lacks 'decimal'.
- Pass now (regression guards): tsconfig.json include/exclude + typecheck script unchanged; TextInputBase already allows 'decimal' and forwards inputMode to the <input> (so the LD-195 (3) "reaches the input" check is already satisfied); no ts suppression in non-test sources.
- Not covered: the real `pnpm --filter @lims/web build`, the "no behaviour change" and "max 30 files" limits, the nonblocking CR and impl note contents (reviewer/impl).
