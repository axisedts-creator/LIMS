# VERIFY-GREEN-5 impl (writer, round 3, per LD-405 option a)
- apps/web/tsconfig.json: `"@/*": ["./src/*", "../portal/src/*"]` + LD-405 comment (one-time cross-chunk authorization). No other file changed. No collision: apps/web/src has no features/portal, server/api, server/session. Known risk (accepted by LD-405): fallback can mask a future web missing-module TS2307 (LD-250).
- Typecheck `turbo run typecheck --continue`: 10/11 packages 0 errors. @lims/web: before 9 non-test (portal pages, see notes/VERIFY-GREEN-5.md), after 0 non-test; 378 errors remain, all in test files (VG-6/7/8 scope, not this task).
- `pnpm --filter @lims/web build`: completed (Next type-check passed, routes emitted).
- vg5 17/17, web-build-2 37/37, build-config 21/21. rs-c6 58/60: rs-c6.screens worklist (role "tab" not found + outline snapshot) fails identically with the tsconfig edit reverted, so baseline, not caused here (reporting changed on 2026-11-18 by T0D-PRINTCFG-1).
- No money or order code touched: no emitted value, rounding, status or SQL changed. No @ts-ignore, `as any`, skipLibCheck.
- Open: rs-c6.screens worklist regression for its owner (C6/T0D-PRINTCFG-1); whole web suite not run.
