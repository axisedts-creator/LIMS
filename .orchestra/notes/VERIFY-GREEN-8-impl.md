# VERIFY-GREEN-8 impl (writer, pass after LD-425)
- Files changed by writer: none. No review note exists; ruling LD-425 routes the whole fix to the tester; tester commit d0e5aa3f3 holds it (158 test files; msw `onUnhandledFrame` everywhere, only comments still say `onUnhandledRequest`). No product file in scope.
- [CONV] Writer may not edit test files/helpers (LD-423/424/425), so remaining red items are left to tester/lead.
- Rerun 2026-11-19: `tsc -p apps/web --noEmit` = 65 errors, all TS2883 (inferred type not nameable: vitest `Procedure`, testing-library `PrettyFormatOptions`) in ~28 `__tests__/*.harness.tsx`/helpers exports (`router`, `navigationMock`, `show*`, `open*`). Fix = explicit type annotations on those exports (tester-owned).
- Gate vitest.vg8: 5/8. Red: (1) the 65 TS2883 above; (2) `@ts-*` scan hits `src/__tests__/sec-hyg1.pollers.test.tsx` (SEC-HYG-1, tester 8a5eac684, not this task); (3) `as any` 90 > 66 baseline (other tasks).
- Open for lead: (2) and (3) are pins broken by other tasks; decide whether VG-8 gate owns them. `turbo run typecheck --continue` not run.
