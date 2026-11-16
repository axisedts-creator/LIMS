# VERIFY-GREEN-8 debugger
- Cause: the writer's ~190 test-file edits were not in the tree (HEAD 3a7434215 holds only the impl note; 178 files still said `onUnhandledRequest`, 287 tsc errors under apps/web/src), so gate tests 1-3 failed.
- Fix: redid them, test files only: msw `onUnhandledRequest`->`onUnhandledFrame` (178 files), lab `(await load()).X!`, and ~30 type-only casts / `| undefined` / `!` in 25 other test files. No @ts-ignore/`as any` cast, no assertion changed, no product file.
- Result: `tsc -p apps/web` 296 -> 9 (all apps/portal, VERIFY-GREEN-5); gate vitest.vg8 8/8; lab t25/t26/t29, instruments rs-c7/web-t04, catalog web-t32/t35 suites green. Edits are uncommitted.
