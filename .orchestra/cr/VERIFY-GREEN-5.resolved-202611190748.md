Title: CR-C1-VG5: VERIFY-GREEN-5 requires fixing portal `@/` imports seen by the web tsc program, but every fix is outside C1 ownership
From chunk: C1            To owner: C0-0D (apps/web/tsconfig.json, 01-CHUNK-MAP.md:132) + C6 (apps/portal, rs-c6 tests, 01-CHUNK-MAP.md:143) / lead
Type: bug
Blocking? yes  (C1 06-IMPLEMENTATION-PLAN row VERIFY-GREEN-5: done_when "no error outside test files" and the test apps/web/src/__tests__/vg5.typecheck.test.ts:45 cannot both be met inside C1-owned paths)
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  `tsc -p apps/web` reports 9 non-test errors (TS2307 x7, TS7006 x2) in apps/portal/src/app/r/[token]/{page,report/page}.tsx.
  They appear only because the C6 test apps/web/src/features/reporting/__tests__/rs-c6.portal.test.tsx imports those pages. In the web program `@/*` maps to apps/web/src.
  The modules exist in apps/portal/src (portal tsc = 0 errors), so the brief says to fix the specifier. vg5.typecheck.test.ts:45 never tolerates these errors.
  The possible fixes are all outside C1:
  (1) relative specifiers in the portal pages: apps/portal is C6-owned, and rs-c6.baseline.json:126-153 pins the `@/…#sym` import keys;
  (2) a `paths` fallback in apps/web/tsconfig.json: C0-0D-owned.
  Serves: VERIFY-GREEN-5 done_when, LD-268, LD-256 backlog.
Proposed change (exact) — the lead picks one:
  (a) C0-0D adds `"@/*": ["./src/*", "../portal/src/*"]` to apps/web/tsconfig.json `compilerOptions.paths` (needs `pnpm --filter @lims/web build` evidence; note it is app-wide and can hide future web missing-module TS2307, LD-250);
  (b) C6 moves rs-c6.portal.test.tsx under apps/portal (or gives it its own tsconfig), so the web tsc program no longer includes the portal pages;
  (c) C6 changes the two portal pages to relative specifiers and re-pins rs-c6.baseline.json (import keys/hashes).
  Whichever option is chosen, vg5.typecheck.test.ts stays as written. Under (b), the portal errors leave the web program, so vg5 passes unchanged.
Backward compatible? yes (all options; no runtime value changes)
Tenant/security impact: none (no RLS, PHI field or public surface change).
IRD/regulatory impact (billing changes only): n/a
Alternatives considered: stub modules under apps/web/src (forbidden, LD-250); @ts-ignore / @ts-expect-error / skipLibCheck / exclude (forbidden by the brief and vg5 tests); deferring via notes + nonblocking CR (rejected by vg5.typecheck.test.ts:45 for modules that exist in portal).
Tests that will prove it: apps/web/src/__tests__/vg5.typecheck.test.ts (0 non-test errors, portal 0 errors), rs-c6 suite, web build guards, `pnpm --filter @lims/web build`.
