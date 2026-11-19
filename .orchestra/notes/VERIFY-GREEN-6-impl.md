# VERIFY-GREEN-6 impl (writer, round 7, LD-423/LD-426)
- Files changed this round: none. The fix (msw `onUnhandledRequest`->`onUnhandledFrame` plus type-only casts in the catalog/frontdesk/billing test files and helpers) landed in tester commit cb58414d4, as LD-423 routed it [CONV].
- No VERIFY-GREEN-6-review.md exists, so there are no implementation-file items to apply. No product file was touched.
- tsc (apps/web, `tsc --noEmit -p .`): 0 errors under features/{catalog,frontdesk,billing} (88 before: catalog 70, frontdesk 8, billing 10). 198 errors remain elsewhere in apps/web and are out of this task's scope. `turbo run typecheck --continue` not re-run.
- Verify cmd suites green: vg6 7/7, web-t32 107/107, web-t35 96/96.
- Money/order: no emitted value, rounding, status or SQL changed; no ts-ignore/expect-error/skipLibCheck/new `as any`.
- Open: the earlier list of red suites in unedited files (emptytbl1/2, rs-c3/rs-c4 static, web-t33.server createDoctor) still stands and is not part of this task.
