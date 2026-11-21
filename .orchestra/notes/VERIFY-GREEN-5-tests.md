# VERIFY-GREEN-5 tests (tester)
- RED gate: `apps/web/src/__tests__/vg5.typecheck.test.ts` (config `vitest.vg5.config.ts`): `tsc -p apps/web` must have 0 errors outside test files. Now 9, all in apps/portal/src/app/r/[token]/{page,report/page}.tsx: TS2307 x7 + TS7006 x2 (web program pulls portal pages in, so `@/` resolves to apps/web/src).
- Finding: the 6 modules EXIST in apps/portal/src (features/portal/{actions,notices,Notice,HealthSummary}, server/{api,session}): wrong specifier, not a missing feature. Fix the import (e.g. relative path); no stub, no apps/web/src/{features/portal,server} dir (LD-250). TS2307 for those is never tolerated.
- Other non-test errors may be left only if listed as `repo/path:line` in notes/VERIFY-GREEN-5.md AND a `.orchestra/cr/VERIFY-GREEN-5*.md` exists. Test-file errors (~280) are out of scope.
- Pins that pass now: portal tsc stays 0; portal modules not emptied; pages keep same 2/5 imports and names; no @ts-ignore/expect-error/nocheck, `as any`, skipLibCheck in touched files or tsconfigs; web tsconfig does not exclude portal.
- Also run (green now, must stay): rs-c6 portal suite + web-build-2 guards, behaviour pin for the two pages.
- Round 4 (ruling, LD-353/LD-362): `rs-c6.screens.test.tsx` worklist test now asserts the FilterBar "Status" select offers the 6 statuses (no `tab` role); `worklist` outline snapshot re-recorded once. rs-c6 suite 60/60 green. VG5 tests and verify.cmd unchanged.
- Run: `.orchestra\notes\VERIFY-GREEN-5-verify.cmd`
- Not covered: money/order emitted values (none in this task; writer states it in the review note and records error counts before/after via `turbo run typecheck --continue`); TS7006 fix is a consequence of the specifier fix, not tested separately.
