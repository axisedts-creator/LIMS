# VERIFY-GREEN-8 impl (writer, pass after ruling 757347041 / tests 85aabebfd)
- Files changed by writer: none. Every remaining error sits in tester-owned paths (`**/__tests__/**`, roles/tester.md:1); no product file is in scope.
- Rerun 2026-11-19: `tsc -p apps/web --noEmit` = 65 errors, all TS2883, all under `__tests__` (*.harness.tsx / *.helpers.tsx / rs-c15.fixtures.tsx exports).
- Gate vitest.vg8: 6/8. Red: (1) the 65 TS2883 above; (2) `as any` above the new baseline of 80.
- [CONV] Ruling (VERIFY-GREEN-8-ruling.md) makes these the tester's fix: add explicit return-type annotations to the harness exports, and replace the ~10 VG8-added `as any` with narrow typed casts (LD-424/LD-425 routing).
- No dispute: the tests are right per ruling; the writer has nothing to implement.
- Open for lead: route to tester. `turbo run typecheck --continue` per-package counts not run.
