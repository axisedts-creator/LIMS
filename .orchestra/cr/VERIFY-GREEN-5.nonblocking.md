Title: CR-C1-VG5: web tsc program cannot resolve `@/` imports of portal pages pulled in by rs-c6 test
From chunk: C1            To owner: C0-0D (apps/web/tsconfig.json, 01-CHUNK-MAP.md:132) / lead
Type: bug
Blocking? no  (VERIFY-GREEN-5 leaves these 9 errors out of its count; listed in .orchestra/notes/VERIFY-GREEN-5.md)
Problem: `tsc -p apps/web` reports 9 errors (TS2307 x7, TS7006 x2) in apps/portal/src/app/r/[token]/{page,report/page}.tsx.
  They exist only because the web test file `apps/web/src/features/reporting/__tests__/rs-c6.portal.test.tsx` imports
  those portal pages; inside the web program `@/*` maps to apps/web/src, so `@/features/portal/*` and `@/server/*` miss.
  The modules exist in apps/portal/src (portal tsc = 0 errors). No web non-test file imports portal.
  Serves: VERIFY-GREEN-5 done_when (0 non-test errors), LD-268, LD-256 backlog.
Why C1 cannot fix inside owned files:
  - Relative-specifier fix in the portal pages is blocked: rs-c6.static pins page/actions.ts hashes and `@/…#sym` import keys (2 tests fail).
  - A `paths` fallback (`"@/*": ["./src/*", "../portal/src/*"]`) works but edits apps/web/tsconfig.json (C0-0D owned),
    is app-wide (Next bundler honours it) and would hide future missing-module TS2307 in web (LD-250 signal). Reverted.
Proposed change (pick one):
  (a) C0-0D approves exactly that `paths` fallback in apps/web/tsconfig.json (needs `next build` evidence);
  (b) give the rs-c6 portal tests their own tsconfig (or move them to apps/portal and typecheck there), so web tsc no longer includes portal pages;
  (c) re-pin rs-c6 (hashes/import keys) after a relative-specifier fix in the two portal pages.
Backward compatible? yes for all options; no runtime value changes.
Tenant/security impact: none. No RLS, PHI field or public surface change.
IRD/regulatory impact: n/a (no billing code).
Alternatives considered: stub modules under apps/web/src (forbidden, LD-250); @ts-ignore / skipLibCheck (forbidden by brief).
Tests that will prove it: apps/web/src/__tests__/vg5.typecheck.test.ts (0 non-test errors), rs-c6 suite, web-build-2, `pnpm --filter @lims/web build`.
