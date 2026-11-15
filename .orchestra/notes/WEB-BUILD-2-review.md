APPROVE

Reviewed `git diff 2b2a30d2..HEAD` for WEB-BUILD-2 against LD-195 and the task brief.

- tsconfig.build.json extends ./tsconfig.json and excludes node_modules plus the five test globs. next.config.mjs only adds `typescript.tsconfigPath` (LD-195 cited). tsconfig.json and the typecheck script are unchanged. No ignoreBuildErrors, ts-ignore or ts-expect-error.
- The two Combobox calls now use `loadOptions={(q) => searchOrderablesAction(q)}`, so the AbortSignal is no longer passed. The PriceListDetail Code field has `maxLength={32}` (catalog.yaml PriceList.code).
- TextField adds 'decimal' to the inputMode union. The value reaches the input through TextInputBase.tsx:70, whose union already allowed it.
- Extra fixes are mechanical and the build reported them. (a) The 4 decimal TextFields get maxLength 10 or 7, which equals the longest string the parseNpr (`\d{1,7}(.\d{1,2})`) and parsePercentBp (`\d{1,4}(.\d{1,2})`) regexes accept, so no valid input is rejected. These are marked [CONV]. (b) The labels.tsx statusTone change is a return-type annotation only. (c) A `'use client'` line was added to 15 ui files that import react-aria. That is 23 files in total, under the 30-file cap.
- No spec, contract, migration, env-name, turbo.json, lockfile or Dockerfile change. No secrets, no PHI, no RLS or permission surface touched.
- Checks run by the reviewer: web-build-2 vitest config gives 37/37 pass. The ui `no-raw-style-literals` test fails (1 test), but every hit is in apps/web test files (instruments rs-c7, payments rs-c15, reporting rs-c6) that this diff does not touch, so it is pre-existing and not caused here.
- Not re-run by the reviewer: the full `pnpm --filter @lims/web build` (the writer's log is in WEB-BUILD-2-build.log), the Dockerfile build, and the t32/t33/t34/t38 catalog suites.
- Note (not a defect): the tester commit 95b192e5 renamed `.orchestra/cr/WEB-BUILD-1.md` to `*.resolved-202611150448.md`. The lead should confirm that rename was intended.
