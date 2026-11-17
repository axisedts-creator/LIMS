# VERIFY-GREEN-6 tests (tester)
- RED gate: `apps/web/src/__tests__/vg6.typecheck.test.ts` (config `vitest.vg6.config.ts`): `tsc -p apps/web` must have 0 errors under features/{catalog,frontdesk,billing}. Now 65 (TS2722 x35 + TS18048 in catalog web-t32.server, TS2353 'onUnhandledRequest' msw fixtures, TS2345/TS2339/TS2379/TS2493 in t32..t35 + fd/billing fixtures).
- Tolerated only if listed `repo/path:line` in notes/VERIFY-GREEN-6.md AND `.orchestra/cr/VERIFY-GREEN-6*.md` exists (real runtime/shape question). The 35 TS2722 lines in web-t32.server.test.ts are never tolerable (typing fix).
- Pins green now, must stay: no @ts-ignore/expect-error/nocheck, skipLibCheck, skip/todo; `as any` <= 2 existing; it()/test() lines >= 524/241/57 and expect( >= 1629/687/145 (catalog/frontdesk/billing); writer/debugger commits touch only test files/helpers (no product file).
- Also run (green now, must stay): catalog web-t32 and web-t35 suites (CI=true).
- Run: `.orchestra\notes\VERIFY-GREEN-6-verify.cmd`
- Not covered: money/order emitted values (writer states "none changed" in review note; error counts before/after via `turbo run typecheck --continue`); other dirs' test errors (instruments, inventory, partners, lab, admin) are other tasks.
