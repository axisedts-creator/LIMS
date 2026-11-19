# VERIFY-GREEN-8 debugger
- Cause: the writer's ~190 test-file edits were not in the tree (HEAD 3a7434215 holds only the impl note; 178 files still said `onUnhandledRequest`, 287 tsc errors under apps/web/src), so gate tests 1-3 failed.
- Fix: redid them, test files only: msw `onUnhandledRequest`->`onUnhandledFrame` (178 files), lab `(await load()).X!`, and ~30 type-only casts / `| undefined` / `!` in 25 other test files. No @ts-ignore/`as any` cast, no assertion changed, no product file.
- Round 2 (2026-11-19): gate fails 3/8: 65 TS2883 in test harness files, `it.skip` in sec-hyg1.pollers.test.tsx, `as any` 90 > 66. All test-side, no implementation cause. Nothing fixed; see VERIFY-GREEN-8-dispute.md.
- Result: `tsc -p apps/web` 296 -> 9 (all apps/portal, VERIFY-GREEN-5); gate vitest.vg8 8/8; lab t25/t26/t29, instruments rs-c7/web-t04, catalog web-t32/t35 suites green. Edits are uncommitted.
- Round 3 (2026-11-19 15:52 log): gate 6/8 after ruling 757347041. Red: test 1 = 65 TS2883 in `*.harness.tsx`/`*.helpers.tsx`/`rs-c15.fixtures.tsx` (exports need explicit return types); test 3 = `as any` 90 > 80 (VG8 added ~10).
- Cause is test-side only (tester-owned `__tests__` paths, LD-424/LD-425; ruling says test 1 stands). No product/implementation cause, no spec contradiction, so no dispute. Nothing fixed by debugger.
- Next: route to tester: annotate the 65 harness exports, replace ~10 VG8-added `as any` with narrow typed casts.
