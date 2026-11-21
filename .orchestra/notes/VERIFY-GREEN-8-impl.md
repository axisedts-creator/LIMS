# VERIFY-GREEN-8 impl (writer, pass after ruling TESTS_WRONG / tester commit fe3d80257)
- Files changed by writer: none. Implementation needed no change (ruling: stale constant in gate only; tester raised BASELINE_AS_ANY 80 -> 90).
- Rerun 2026-11-19 16:38: gate `vitest.vg8.config.ts` 8/8 green.
- `turbo run typecheck --filter=@lims/web --continue`: exit 0 (2/2 tasks successful). Worktree clean after run.
- [CONV] Only test files/helpers changed across VG8 (tester 1d93420ad, fe3d80257, debugger rounds); no product file, so no money/order emitted value, rounding, status or SQL changed.
- Open: per-package before/after counts across all packages (`turbo run typecheck --continue` unfiltered) not rerun; apps/portal errors belong to VERIFY-GREEN-5. 24 extra `as any` from other lanes' tests remain (out of scope per ruling).
